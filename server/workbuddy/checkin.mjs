/**
 * 每日签到（国内版专有）。
 *
 * 复刻 workbuddy-switch 的 checkin.rs 核心语义：
 * - 状态查询：`POST /v2/billing/meter/checkin-activity-status`，404 才回退 `checkin-status`；
 * - 执行签到：`POST /v2/billing/meter/daily-checkin`，接口**幂等**，重复提交返回"已签到"按成功处理；
 * - 仅国内版有签到：国际版不发起任何请求，直接标记 unsupported；
 * - 只对「有明文 token」的账号发起，加密信封凭据给出可读错误而不是发空 Bearer。
 *
 * 与参考实现的差异：不做「签到时间窗 / 快速重试预算」那套调度，只提供
 * 「查状态 + 单个/全部签到 + 自动签到开关（服务端每小时巡检一次）」。
 */
import { proxyFetch } from '../proxy.mjs';
import { variantOf, officialNetHint } from './variant.mjs';
import { authHeaders } from './credits.mjs';
import { runGrowthForAccount } from './growth.mjs';
import {
  loadAccounts,
  accountDisplayName,
  accountMeta,
  hasPlainToken,
  isEnvelope,
  CHECKIN_LOGS_FILE,
  readJsonFile,
} from './accounts.mjs';
import { atomicWriteJson, atomicWriteJsonAsync } from '../store/config.mjs';

/** 签到相关接口前缀（国内版专有，与 workbuddy-switch 的 CHECKIN_API_PREFIX 一致） */
const CHECKIN_BASE = '/v2/billing/meter';
const CHECKIN_PATH = `${CHECKIN_BASE}/daily-checkin`;
/**
 * 状态接口候选：先试新版 checkin-activity-status，**只有 404 才回退**旧版 checkin-status。
 * 注意旧版接口对未签到的账号会返回 active:false/today_checked_in:false，语义与新接口不同，
 * 因此必须以新接口为准，旧接口只作路径兼容。
 */
const STATUS_PATHS = [`${CHECKIN_BASE}/checkin-activity-status`, `${CHECKIN_BASE}/checkin-status`];
/** 签到日志保留条数 */
const LOG_LIMIT = 300;

/** 官方响应视为成功的业务码 */
function isOkCode(code) {
  return code === 0 || code === 200 || code === '0' || code === '200';
}

/** 业务码：路由不存在（用于状态接口的路径回退） */
function isRouteMissing(status, json) {
  if (status === 404) return true;
  const code = json?.code ?? json?.Code;
  return code === 404;
}

/** 401/未授权 → 提示重新登录而不是笼统失败 */
function isUnauthorized(status, json) {
  if (status === 401 || status === 403) return true;
  const code = json?.code ?? json?.Code;
  if (code === 401) return true;
  const msg = String(json?.message || json?.msg || json?.Message || '');
  return /401|unauthorized|未授权|登录已过期|token/i.test(msg);
}

/** 「已签到」类提示：签到接口幂等，重复提交按成功处理 */
function isAlreadyCheckedInMessage(msg) {
  const s = String(msg || '');
  return /已签到|已经签到|重复签到|今日已|already/i.test(s);
}

/**
 * 带账号凭据的 POST，保留 HTTP 状态码（状态接口要靠 404 决定是否回退路径）。
 * 网络/解析失败抛出，由上层归类到该账号的失败原因。
 */
async function postOfficial(account, url, body = {}) {
  const res = await proxyFetch(url, {
    method: 'POST',
    headers: authHeaders(account, url),
    body: JSON.stringify(body),
    // 签到打的是官方接口，连不上时别报"模型平台需要 VPN"
    netHint: officialNetHint(variantOf(account).id),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON（如网关 404 页面）保持 null，由调用方按状态码判断 */
  }
  return { status: res.status, json };
}

/** 账号是否具备发起签到的条件（国内版 + 明文凭据） */
function checkinEligible(account) {
  if (variantOf(account).id !== 'cn') {
    return { ok: false, unsupported: true, error: '该档位暂无签到功能' };
  }
  if (isEnvelope(account?.access_token)) {
    return { ok: false, error: '该账号凭据为加密信封，无法发起签到；请重新用 WorkBuddy 登录后再授权导入' };
  }
  if (!hasPlainToken(account)) {
    return { ok: false, error: '该账号没有可用的 access_token，无法签到' };
  }
  return { ok: true };
}

/** 状态查询结果 → 统一结构 */
function statusFromResponse(json) {
  const code = json?.code ?? json?.Code;
  if (!isOkCode(code)) return null;
  const data = json?.data ?? json?.Data ?? {};
  const today =
    data?.today_checked_in ?? data?.todayCheckedIn ?? data?.todayCheckIn ?? data?.checkedIn ?? false;
  return {
    ok: true,
    todayCheckedIn: Boolean(today),
    raw: data,
    error: null,
  };
}

/**
 * 查询单个账号的签到状态。
 * 返回 { ok, todayCheckedIn, error, unsupported }
 */
export async function fetchCheckinStatus(account) {
  const eligible = checkinEligible(account);
  if (!eligible.ok) return { ok: false, todayCheckedIn: false, ...eligible };

  const endpoint = variantOf(account).apiEndpoint;
  let last = null;
  for (let i = 0; i < STATUS_PATHS.length; i++) {
    const url = `${endpoint}${STATUS_PATHS[i]}`;
    const { status, json } = await postOfficial(account, url, {});
    last = { status, json };
    const parsed = statusFromResponse(json);
    if (parsed) return parsed;
    // 只有 404 才回退下一个候选：401/业务错误回落只会掩盖真因
    if (!isRouteMissing(status, json)) break;
  }
  const code = last?.json?.code ?? last?.json?.Code;
  const msg = last?.json?.message || last?.json?.msg || last?.json?.Message;
  return {
    ok: false,
    todayCheckedIn: false,
    error: msg ? String(msg) : `签到状态查询失败（HTTP ${last?.status ?? '?'}${code != null ? ` / code ${code}` : ''}）`,
    unauthorized: isUnauthorized(last?.status, last?.json),
  };
}

/**
 * 执行签到。返回 { ok, alreadyCheckedIn, message, unauthorized }
 * 幂等：服务端返回「已签到」提示同样视为成功。
 */
export async function performCheckin(account) {
  const eligible = checkinEligible(account);
  if (!eligible.ok) return { ok: false, ...eligible };

  const url = `${variantOf(account).apiEndpoint}${CHECKIN_PATH}`;
  const { status, json } = await postOfficial(account, url, {});
  const code = json?.code ?? json?.Code;
  const msg = String(json?.message || json?.msg || json?.Message || '');

  if (isOkCode(code)) {
    return { ok: true, alreadyCheckedIn: false, message: msg || '签到成功', raw: json?.data ?? json?.Data ?? null };
  }
  if (isAlreadyCheckedInMessage(msg)) {
    return { ok: true, alreadyCheckedIn: true, message: msg || '今日已签到', raw: json?.data ?? json?.Data ?? null };
  }
  return {
    ok: false,
    message: msg || `签到失败（HTTP ${status}${code != null ? ` / code ${code}` : ''}）`,
    unauthorized: isUnauthorized(status, json),
  };
}

/** 读取签到日志（最新在前） */
export function loadCheckinLogs() {
  const rows = readJsonFile(CHECKIN_LOGS_FILE, []);
  return Array.isArray(rows) ? rows : [];
}

async function appendCheckinLogs(entries) {
  const rows = loadCheckinLogs();
  const stamped = entries.map((e) => ({ ...e, at: Date.now() }));
  const next = [...rows, ...stamped].slice(-LOG_LIMIT);
  try {
    // 异步落盘：巡检撞上 EPERM 锁窗时不能把整个服务冻住 36 秒
    await atomicWriteJsonAsync(CHECKIN_LOGS_FILE, next);
  } catch {
    /* 日志写失败不影响签到结果 */
  }
}

/** 一条签到记录（只存结果，不存任何 token）；growth 存在时附上成长中心报告 */
function logEntry(account, result, growth = null) {
  return {
    ts: Date.now(),
    accountId: account.id,
    accountName: accountDisplayName(account),
    variant: variantOf(account).id,
    ok: Boolean(result.ok),
    alreadyCheckedIn: Boolean(result.alreadyCheckedIn),
    message: result.message || result.error || '',
    ...(growth
      ? {
          growth: {
            ok: Boolean(growth.ok),
            report: growth.report || '',
            creditsGained: growth.creditsGained || 0,
            hardFailures: growth.hardFailures || 0,
          },
        }
      : {}),
  };
}

/**
 * 签到成功后顺带跑成长中心（旅行/任务/补登/兑换/盲盒/Buddy）。
 * 失败绝不抛出让签到结果被污染——成长中心是附加收益，签到才是主流程。
 */
async function growthSafe(account) {
  try {
    return await runGrowthForAccount(account);
  } catch (e) {
    return { ok: false, report: `成长中心异常（${e?.message || e}）`, creditsGained: 0, hardFailures: 1 };
  }
}

/**
 * 对单个账号签到 + 成长中心：先查状态，未签到才提交，避免无谓的写请求。
 * 签到成功（含今日已签）后顺带跑成长中心六个模块。
 * 返回 { ok, action: 'checked'|'already'|'skipped'|'failed', message, account, growth? }
 */
export async function checkinAccount(accountId, { withGrowth = true } = {}) {
  const accounts = loadAccounts();
  const account = accounts.find((a) => a.id === accountId);
  if (!account) throw new Error('账号不存在');

  const state = await fetchCheckinStatus(account);
  // 状态接口不可用（部分账号无权限/接口变动）时，仍然直接提交一次——接口幂等
  if (state.ok && state.todayCheckedIn) {
    const growth = withGrowth ? await growthSafe(account) : null;
    const result = { ok: true, action: 'already', message: '今日已签到', account: accountMeta(account) };
    if (growth) result.growth = growth;
    await appendCheckinLogs([logEntry(account, { ok: true, alreadyCheckedIn: true, message: result.message }, growth)]);
    return result;
  }
  if (!state.ok && state.unsupported) {
    return { ok: false, action: 'skipped', message: state.error, account: accountMeta(account) };
  }

  const done = await performCheckin(account);
  if (done.ok) {
    const growth = withGrowth ? await growthSafe(account) : null;
    const result = {
      ok: true,
      action: 'checked',
      message: done.alreadyCheckedIn ? '今日已签到' : done.message || '签到成功',
      account: accountMeta(account),
    };
    if (growth) result.growth = growth;
    await appendCheckinLogs([logEntry(account, done, growth)]);
    return result;
  }
  const reason = done.message || state.error || '签到失败';
  await appendCheckinLogs([logEntry(account, { ok: false, message: reason })]);
  return { ok: false, action: 'failed', message: reason, account: accountMeta(account) };
}

/**
 * 全部账号签到 + 成长中心（并发受限，避免同一时刻打爆网关）。
 * - onlyPending：已签到的账号不重复提交签到（成长中心仍照常领取）；
 * - skipGrowthIfDoneToday：今天已跑过成长中心的账号跳过（自动巡检用，手动领取不设这道闸）。
 * 返回 { results, summary }
 */
export async function checkinAll({ onlyPending = false, withGrowth = true, skipGrowthIfDoneToday = false, staggerMs = 0 } = {}) {
  const accounts = loadAccounts().filter((a) => variantOf(a).id === 'cn');
  const results = [];
  // staggerMs > 0：防风控模式——单并发顺序签到，账号间间隔 staggerMs（官方对短窗口内
  // 多账号同 IP 操作会判定批量营销号踢下线）。= 0：保持原 3 并发（用户手动触发场景）。
  const CONCURRENCY = staggerMs > 0 ? 1 : 3;
  let cursor = 0;

  async function worker() {
    while (cursor < accounts.length) {
      if (staggerMs > 0 && cursor > 0) await new Promise((r) => setTimeout(r, staggerMs));
      const account = accounts[cursor++];
      try {
        if (onlyPending) {
          const state = await fetchCheckinStatus(account);
          if (state.ok && state.todayCheckedIn) {
            if (withGrowth && !(skipGrowthIfDoneToday && growthDoneToday(account.id))) {
              results.push(await checkinAccount(account.id, { withGrowth: true }));
            } else {
              results.push({ ok: true, action: 'already', message: '今日已签到', account: accountMeta(account) });
            }
            continue;
          }
          if (state.unsupported) {
            results.push({ ok: false, action: 'skipped', message: state.error, account: accountMeta(account) });
            continue;
          }
        }
        results.push(await checkinAccount(account.id, { withGrowth }));
      } catch (e) {
        results.push({ ok: false, action: 'failed', message: e?.message || '签到失败', account: accountMeta(account) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, accounts.length) }, worker));

  const summary = {
    total: results.length,
    checked: results.filter((r) => r.action === 'checked').length,
    already: results.filter((r) => r.action === 'already').length,
    failed: results.filter((r) => r.action === 'failed').length,
    skipped: results.filter((r) => r.action === 'skipped').length,
    growthCredits: results.reduce((sum, r) => sum + (r.growth?.creditsGained || 0), 0),
    growthHardFailures: results.reduce((sum, r) => sum + (r.growth?.hardFailures || 0), 0),
  };
  return { results, summary };
}

/** 今天是否所有国内版账号都已签到（自动巡检用，避免重复提交） */
export async function allCheckedInToday() {
  const accounts = loadAccounts().filter((a) => variantOf(a).id === 'cn' && hasPlainToken(a));
  if (accounts.length === 0) return true;
  for (const account of accounts) {
    try {
      const state = await fetchCheckinStatus(account);
      if (!state.ok) return false; // 查不到状态就当作待处理，由签到流程自己幂等兜底
      if (!state.todayCheckedIn) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** 今天（本地时区）该账号是否已有成长中心记录 */
export function growthDoneToday(accountId) {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  return loadCheckinLogs().some((e) => e.accountId === accountId && e.growth && e.ts >= dayStart.getTime());
}

/**
 * 今天是否所有国内版可签到账号都已跑过成长中心（自动巡检的第二道门禁）。
 * 日志被裁剪会忘掉记录 → 最坏情况是当天多跑一轮，而成长中心各接口全部幂等/服务端兜底，无害。
 */
export function allGrowthDoneToday() {
  const accounts = loadAccounts().filter((a) => variantOf(a).id === 'cn' && hasPlainToken(a));
  if (accounts.length === 0) return true;
  return accounts.every((a) => growthDoneToday(a.id));
}
