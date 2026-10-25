/**
 * 成长中心自动化（国内版专有）：签到之外的全部每日奖励。
 *
 * 接口契约逆向自官方桌面端成长中心 H5，与 88lin/workbuddy-auto-signin（MIT）的实现
 * 逐条核对过（2026-10-13，`GET/POST {endpoint}/v2/activity/growth/*`）：
 *
 *   1. Buddy 旅行  GET  /buddy/travel/status   state: idle|traveling|arrived
 *                  POST /buddy/travel/claim    {record_id}          领旅行礼物
 *                  GET  /buddy/travel/config   locations[]          目的地列表
 *                  POST /buddy/travel/depart   {location_id}        派 Buddy 出发
 *   2. 任务        GET  /tasks                 accept_status: not_accepted|accepted|in_progress|completed|claimed
 *                  POST /tasks/accept          {task_codes:[...]}   接单（复数数组；单数 task_code 一律 400）
 *                  POST /tasks/{code}/claim    {}                   领奖（只有 completed 才发奖）
 *   2.5 对话任务    chat_* 类任务（如 chat_5「和 AI 聊天 5 次」）只有真实发起模型对话才计进度：
 *                  对话请求带 extra_vars.growthEvent（eventCode=chat_request_send，逆向自官方
 *                  桌面端 5.x，实测有效）。模型选择：免费模型（hy3 等，实测 0 积分/次）优先，
 *                  全部不可用才退到低倍率付费模型——实现见 usageTasks.mjs。
 *   3. 断登补签    GET  /streak                streak.days / makeup_cards / makeup_dates / launch_date
 *                  GET  /heatmap               cells[{date,score}] / today.date（服务端日期）
 *                  POST /makeup-cards/use      {target_date}        每轮最多 1 张
 *   4. 连登兑换    GET  /redeem/summary        starter/advanced/legendary_status
 *                  POST /redeem                {tier:"7d"|"14d"|"28d", client_token}
 *   5. 开盲盒      GET  /lottery/chances       balance
 *                  POST /lottery/draw          {client_token}       缺 token 直接 400；一轮只开一次
 *   6. Buddy 盲盒  GET  /buddy/quota           affordable / max_open_count
 *                  POST /buddy/open            {count, client_token}
 *   7. 展示值      GET  /energy                balance
 *
 * 实测判据（改动前先读这段，别重查）：
 * - client_token 官方前端是 `u-<uuid>`，服务端只做幂等去重不校验格式，但**缺了** /lottery/draw 直接 400。
 * - /redeem 的 tier 只认档位标识字符串：传 "starter"/"7"/7 分别得到 unknown tier / unknown tier /
 *   invalid request；被判 unknown tier 时退回**天数**再试一次（参数校验阶段拒绝，重试不会重复领取）。
 * - 403「连登天数不足」是业务常态，必须**先于**通用的 401/403 中止判断，否则未解锁档位会中止整轮。
 * - 补登候选只认 /heatmap 里 score==0 的当月历史日期（今天之前、活动上线之后）；makeup_dates 是
 *   **已补登历史**，不能当待办清单。日历结构异常时整段停止，不靠猜测消耗补登卡。
 * - 任务列表里的 reward_credit 只是活动配置，汇报优先用领奖响应里的实发数值。
 * - 兑换实发字段带 _granted 后缀（credit_granted/energy_granted/cards_granted/chances_granted）；
 *   直接读 `credit` 恒为空，会把兑换所得漏计。
 * - 写操作（claim/depart/redeem/draw/open/use）不重试：服务端处理完成后才超时时，重试会重复提交。
 *
 * 设计：各子步骤独立 try，一段失败不影响其余；401/403（非业务常态）中止本轮；
 * 硬失败（5xx/网络不可达）单独计数，供上层决定要不要提醒。
 */
import crypto from 'node:crypto';
import { proxyFetch } from '../proxy.mjs';
import { variantOf, officialNetHint } from './variant.mjs';
import { authHeaders } from './credits.mjs';
import { hasPlainToken, isEnvelope } from './accounts.mjs';
import { chatTaskBacklog, completeChatTasks } from './usageTasks.mjs';

const GROWTH_BASE = '/v2/activity/growth';
/** 每轮最多用掉一张补登卡（与参考实现一致；断登多天时分轮消化） */
export const MAKEUP_MAX_PER_RUN = 1;
/** 对话任务补满后等进度落库的复查间隔（服务端把进度翻成 completed 有秒级延迟） */
const CLAIM_RECHECK_DELAY_MS = 5000;
/** 补登候选的最早日期：成长中心活动上线日（与官方 H5 口径一致） */
const LAUNCH_FLOOR = '2026-06-17';

/** 连登兑换三档：(档位标识, summary 状态字段前缀, 展示名, 兜底天数) */
export const REDEEM_TIERS = [
  { tier: '7d', statusKey: 'starter_status', label: '入门', days: 7 },
  { tier: '14d', statusKey: 'advanced_status', label: '进阶', days: 14 },
  { tier: '28d', statusKey: 'legendary_status', label: '巅峰', days: 28 },
];

/** 档位奖励的官方文案（2026-09 活动版本），响应里挖不到实发字段时回落到这里 */
const REDEEM_REWARD_FALLBACK = {
  '7d': '+2 能量 +1 补登卡 +1 次抽奖',
  '14d': '+50 积分 +3 能量 +1 补登卡 +1 次抽奖',
  '28d': '+150 积分 +5 能量 +1 补登卡 +1 次抽奖',
};

/** 在可能被 data/result/resp/response 包裹的响应里找字段（兼容信封结构） */
export function dig(obj, key) {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
    for (const k of ['data', 'result', 'resp', 'response']) {
      if (obj[k] && typeof obj[k] === 'object') {
        const r = dig(obj[k], key);
        if (r !== null && r !== undefined) return r;
      }
    }
  }
  return null;
}

/** 字符串数字安全转 int；转不动返回 default（宁可截断也不把真实数值丢成 0） */
function asInt(v, defaultValue = 0) {
  const n = Number.parseInt(String(v), 10);
  if (Number.isFinite(n)) return n;
  const f = Number.parseFloat(String(v));
  return Number.isFinite(f) ? Math.trunc(f) : defaultValue;
}

/** 优先取响应里的实发数值，挖不到才用回落值（任务列表配置值 ≠ 实发） */
function firstInt(body, key, fallback = 0) {
  const v = dig(body, key);
  return v !== null && v !== undefined ? asInt(v) : asInt(fallback);
}

/** 活动接口的防重放 token：`u-<uuid>`，服务端只做幂等去重 */
function clientToken() {
  return `u-${crypto.randomUUID()}`;
}

/** 硬失败：5xx 与"没拿到响应"需要人关注；4xx 绝大多数是业务规则（每日上限/活动结束） */
function isHardFailure(status, networkError) {
  return Boolean(networkError) || status >= 500;
}

/** 抽奖失败是否只是"没有次数"——常态不是故障（400 + insufficient lottery chance balance） */
function isNoChance(msg) {
  const m = String(msg || '').toLowerCase();
  if (!m) return false;
  if (m.includes('insufficient') || m.includes('not enough')) return m.includes('chance') || m.includes('balance');
  return m.includes('no chance');
}

/** tier 这个值本身不认识（400 + unknown/unsupported/invalid tier）→ 退回天数重试 */
function isUnknownTier(status, body) {
  if (status !== 400) return false;
  const m = String(dig(body, 'msg') || '').toLowerCase();
  return m.includes('tier') && (m.includes('unknown') || m.includes('unsupported') || m.includes('invalid'));
}

/** 未解锁档位：403 + 「天数不足」——常态，不是故障，更不能中止整轮 */
function isTierLocked(status, body) {
  if (status !== 403) return false;
  return String(dig(body, 'msg') || '').includes('不足');
}

/** HTTP + 业务码双检（补登相关接口用） */
function apiSuccess(status, json) {
  if (status < 200 || status >= 300) return false;
  const code = json?.code;
  return code === undefined || code === null || code === 0;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 从活跃日历选断登日期（纯函数，供测试）。
 * 口径与官方成长中心一致：当月、今天之前、活动上线之后、score == 0、不在已补登历史里。
 * 用 heatmap.today.date 的服务端日期，避免本机时区把月初/午夜算错。
 * 结构异常直接抛错——不能靠猜测消耗补登卡。
 * 返回 ISO 日期串，最近的断点在前（尽早恢复当前连登）。
 */
export function makeupCandidates(streakBody, heatmapBody) {
  const parseDate = (value, what) => {
    if (typeof value !== 'string' || !DATE_RE.test(value)) throw new Error(`${what}格式无效`);
    return value;
  };
  const todayObj = dig(heatmapBody, 'today');
  if (!todayObj || typeof todayObj !== 'object') throw new Error('活跃日历缺少服务端日期');
  const today = parseDate(todayObj.date, '服务端日期');
  const launch = parseDate(dig(streakBody, 'launch_date') || LAUNCH_FLOOR, '活动上线日期');
  const monthStart = `${today.slice(0, 7)}-01`;
  const start = [monthStart, launch, LAUNCH_FLOOR].sort()[2]; // 三者取最大
  const streak = dig(streakBody, 'streak');
  if (!streak || typeof streak !== 'object') throw new Error('连登状态格式无效');
  const madeUpRaw = streak.makeup_dates ?? [];
  if (!Array.isArray(madeUpRaw)) throw new Error('已补登记录格式无效');
  const madeUp = new Set(madeUpRaw.map((v) => parseDate(v, '已补登日期')));
  const cells = dig(heatmapBody, 'cells');
  if (!Array.isArray(cells)) throw new Error('活跃日历缺少日期列表');
  const out = [];
  for (const cell of cells) {
    if (!cell || typeof cell !== 'object') throw new Error('活跃日历记录格式无效');
    const day = parseDate(cell.date, '活跃日历日期');
    const score = cell.score;
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0) throw new Error('活跃日历分数无效');
    if (day >= start && day < today && score === 0 && !madeUp.has(day)) out.push(day);
  }
  return out.sort().reverse();
}

/** 带账号凭据的请求；网络/解析异常不抛出，统一成 { status, json, networkError } 由上层归类 */
async function request(account, method, url, body, netOpts = {}) {
  try {
    const res = await proxyFetch(url, {
      method,
      headers: authHeaders(account, url),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      // 成长中心同样是官方接口，网络失败的提示要按档位说人话
      netHint: officialNetHint(variantOf(account).id),
      ...netOpts,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON（网关错误页）保持 null，按状态码判断 */
    }
    return { status: res.status, json, networkError: null };
  } catch (e) {
    return { status: 0, json: null, networkError: e?.message || '网络不可达' };
  }
}

const get = (account, url, netOpts) => request(account, 'GET', url, undefined, netOpts);
const post = (account, url, body = {}, netOpts) => request(account, 'POST', url, body, netOpts);

/** 服务端时间戳换算成「还有多久回来」；任一缺失/非法返回空串（纯展示，绝不让它失败整轮） */
function fmtEta(arriveAt, serverNow) {
  const left = Number(arriveAt) - Number(serverNow);
  if (!Number.isFinite(left)) return '';
  if (left <= 0) return '，已到达待领取';
  const minutes = Math.round(left / 60);
  if (minutes < 60) return `，约 ${Math.max(1, minutes)} 分钟后回`;
  return `，约 ${(left / 3600).toFixed(1)} 小时后回`;
}

/** 兑换成功的奖励描述：优先拼服务端实发 *_granted，挖不到回落官方文案 */
function redeemRewardDesc(body, tier) {
  const bits = [];
  const credit = asInt(dig(body, 'credit_granted'), 0);
  const energy = asInt(dig(body, 'energy_granted'), 0);
  const cards = asInt(dig(body, 'cards_granted'), 0);
  const chances = asInt(dig(body, 'chances_granted'), 0);
  if (credit) bits.push(`+${credit} 积分`);
  if (energy) bits.push(`+${energy} 能量`);
  if (cards) bits.push(`+${cards} 补登卡`);
  if (chances) bits.push(`+${chances} 次抽奖`);
  return `（${bits.length ? bits.join(' ') : REDEEM_REWARD_FALLBACK[tier] || '奖励已到账'}）`;
}

/** 账号是否具备跑成长中心的条件（国内版 + 明文凭据） */
export function growthEligible(account) {
  if (variantOf(account).id !== 'cn') {
    return { ok: false, unsupported: true, error: '该档位暂无成长中心' };
  }
  if (isEnvelope(account?.access_token)) {
    return { ok: false, error: '该账号凭据为加密信封，无法领取成长中心奖励' };
  }
  if (!hasPlainToken(account)) {
    return { ok: false, error: '该账号没有可用的 access_token' };
  }
  return { ok: true };
}

/**
 * 对单个账号跑成长中心全部六个模块。
 * options.systemProxy=false 时跳过 Windows 系统代理探测（隔离测试用，见 proxy.mjs 的说明；
 * proxyFetch 在有代理时会走 undici，绕开测试里的 fetch 桩）。
 * 返回 { ok, report, parts, creditsGained, energy, streakDays, failures, hardFailures, idle, unauthorized }
 * ok=false 只在中止级问题（不支持/认证拒绝/硬失败）时出现；单模块失败记在 parts+failures 里。
 */
/**
 * 查询某账号今日「Buddy 旅行」状态（只查询，不派出发）。
 * state: idle（未旅行）| traveling（已出发）| arrived（已到达待领取）
 */
export async function fetchTravelStatus(account) {
  try {
    const { apiEndpoint: endpoint } = variantOf(account);
    const url = `${endpoint}${GROWTH_BASE}/buddy/travel/status`;
    // 用 Node 原生 fetch 直连（官方境内域名，避免系统代理残留导致失败）
    const res = await fetch(url, { headers: authHeaders(account, url), signal: AbortSignal.timeout(15000) });
    if (res.status !== 200) return { ok: false, traveled: false, state: '', error: `HTTP ${res.status}` };
    const json = await res.json().catch(() => null);
    const state = String(dig(json, 'state') || '');
    return {
      ok: true,
      traveled: state === 'traveling' || state === 'arrived',
      state,
      /** 今日名额已用完（state=idle 且 daily_limit_reached=true） */
      dailyLimit: Boolean(dig(json, 'daily_limit_reached')),
      /** 本次/今日旅行可得的积分（官方字段 reward_credit，未旅行时为 0） */
      reward: asInt(dig(json, 'reward_credit')),
    };
  } catch (err) {
    return { ok: false, traveled: false, state: '', error: err?.message || String(err) };
  }
}

export async function runGrowthForAccount(account, options = {}) {
  const eligible = growthEligible(account);
  if (!eligible.ok) {
    return { ok: false, report: eligible.error, parts: [], failures: 0, hardFailures: 0, idle: false, ...eligible };
  }

  const base = `${variantOf(account).apiEndpoint}${GROWTH_BASE}`;
  const netOpts = options.systemProxy === undefined ? {} : { systemProxy: options.systemProxy };
  const g = (url) => get(account, url, netOpts);
  const p = (url, body) => post(account, url, body, netOpts);
  const parts = [];
  let creditsGained = 0;
  let failures = 0;
  let hardFailures = 0;
  let successes = 0;

  /** 认证/权限拒绝 → 中止本轮（业务常态 403 由调用方先拦截） */
  const authAbort = (status) => status === 401 || status === 403;
  const abortResult = (status) => ({
    ok: false,
    unauthorized: true,
    report: `成长中心中止：登录态被拒绝（HTTP ${status}），请刷新凭据或重新扫码`,
    parts,
    creditsGained,
    failures: failures + 1,
    hardFailures: hardFailures + 1,
    idle: false,
  });

  /**
   * 前置查询接口异常的统一记录；返回 true 表示调用方应跳过后续处理。
   * required=true：查询失败必须提醒（补登判断不能把未知状态解释成无需补登）。
   */
  const noteHttp = (r, label, { required = false } = {}) => {
    if (r.networkError) {
      parts.push(`${label}失败：网络不可达（${r.networkError}）`);
      failures += 1;
      hardFailures += 1;
      return true;
    }
    const ok = r.status >= 200 && r.status < 300 && (!required || apiSuccess(r.status, r.json));
    if (ok) return false;
    const detail = String(r.json?.error || r.json?.msg || r.json?.message || '');
    parts.push(`${label}失败：HTTP ${r.status}${detail ? `（${detail}）` : ''}`);
    if (required || isHardFailure(r.status, null)) {
      failures += 1;
      hardFailures += 1;
    }
    return true;
  };

  // --- 1. Buddy 旅行：领礼物 + 派出发 ---
  try {
    const s = await g(`${base}/buddy/travel/status`);
    if (s.networkError) {
      // 第一个请求就网络不可达：立刻收手，别把后续接口全撞一遍
      return {
        ok: false,
        report: `网络不可达，成长中心跳过（${s.networkError}）`,
        parts,
        creditsGained,
        failures: 1,
        hardFailures: 1,
        idle: false,
      };
    }
    if (authAbort(s.status)) return abortResult(s.status);
    noteHttp(s, '查旅行状态');
    let travel = dig(s.json, 'state');
    const dailyLimit = Boolean(dig(s.json, 'daily_limit_reached'));
    let claimedTravel = false;
    if (travel === 'arrived') {
      const recordId = dig(s.json, 'record_id');
      const c = await p(`${base}/buddy/travel/claim`, { record_id: recordId });
      if (authAbort(c.status)) return abortResult(c.status);
      const reward = dig(c.json, 'reward_credit');
      if (!c.networkError && c.status >= 200 && c.status < 300 && reward !== null && reward !== undefined) {
        const got = asInt(reward);
        creditsGained += got;
        parts.push(`领旅行礼物 +${got} 积分`);
        successes += 1;
        claimedTravel = true;
      } else {
        const msg = c.networkError || String(dig(c.json, 'msg') || `HTTP ${c.status}`);
        parts.push(`领旅行礼物失败：${msg}`);
        failures += 1;
        hardFailures += isHardFailure(c.status, c.networkError) ? 1 : 0;
      }
      // 只有领取成功后才视为 idle 允许派出发，避免覆盖未领取的奖励
      if (claimedTravel) travel = 'idle';
    }
    if (travel === 'idle' && dailyLimit) {
      parts.push('今日旅行名额已用完');
    } else if (travel === 'idle') {
      const c = await g(`${base}/buddy/travel/config`);
      if (authAbort(c.status)) return abortResult(c.status);
      const locs = dig(c.json, 'locations');
      if (Array.isArray(locs) && locs.length && locs[0] && typeof locs[0] === 'object') {
        const d = await p(`${base}/buddy/travel/depart`, { location_id: locs[0].id });
        if (authAbort(d.status)) return abortResult(d.status);
        if (!d.networkError && d.status >= 200 && d.status < 300) {
          const locName = dig(d.json, 'location')?.name || '?';
          const dur = dig(d.json, 'duration_hours') ?? dig(d.json, 'location')?.duration_hours ?? '?';
          parts.push(`派 Buddy 去${locName}（${dur} 小时后回）`);
          successes += 1;
        } else {
          const msg = d.networkError || String(dig(d.json, 'msg') || `HTTP ${d.status}`);
          parts.push(`派 Buddy 失败：${msg}`);
          failures += 1;
          hardFailures += isHardFailure(d.status, d.networkError) ? 1 : 0;
        }
      }
    } else if (travel === 'traveling') {
      const locName = dig(s.json, 'location')?.name || '?';
      parts.push(`Buddy 旅行中（${locName}${fmtEta(dig(s.json, 'arrive_at'), dig(s.json, 'server_now'))}）`);
    }
  } catch (e) {
    parts.push(`旅行模块异常（${e?.message || e}）`);
    failures += 1;
    hardFailures += 1;
  }

  // --- 2. 任务领奖（放在抽奖前：任务送的抽奖机会/能量，后面马上能用上）---
  /** 任务标题表（任务模块查到列表后填充；对话补全复查时复用） */
  const titles = new Map();
  /** 领走列表里所有 completed 任务的奖励（任务模块与对话补全后复查共用） */
  const claimCompleted = async (list) => {
    for (const task of list) {
      if (task?.locked || task?.accept_status !== 'completed') continue; // 只有 completed 才发奖
      const code = task.task_code;
      const title = titles.get(code) || code;
      try {
        const c = await p(`${base}/tasks/${encodeURIComponent(code)}/claim`, {});
        if (authAbort(c.status)) return abortResult(c.status);
        if (!c.networkError && c.status >= 200 && c.status < 300 && !dig(c.json, 'already_claimed')) {
          const rc = firstInt(c.json, 'credit', task.reward_credit);
          const re = firstInt(c.json, 'energy', task.reward_energy);
          creditsGained += rc;
          parts.push(`领任务奖「${title}」+${rc} 积分 +${re} 能量`);
          successes += 1;
        } else if (!c.networkError && c.status >= 200 && c.status < 300) {
          parts.push(`任务奖「${title}」已领过`);
        } else {
          const msg = c.networkError || String(dig(c.json, 'msg') || `HTTP ${c.status}`);
          parts.push(`领任务奖「${title}」失败：${msg}`);
          failures += 1;
          hardFailures += isHardFailure(c.status, c.networkError) ? 1 : 0;
        }
      } catch (e) {
        parts.push(`领任务奖「${title}」异常（${e?.message || e}）`);
        failures += 1;
        hardFailures += 1;
      }
    }
  };
  try {
    const t = await g(`${base}/tasks`);
    if (authAbort(t.status)) return abortResult(t.status);
    if (!noteHttp(t, '查任务列表')) {
      const tasks = dig(t.json, 'tasks') || [];
      for (const x of tasks) titles.set(x?.task_code, x?.title || x?.task_code);
      const pending = tasks
        .filter((x) => x?.task_code && !x?.locked && x?.accept_status === 'not_accepted')
        .map((x) => x.task_code);
      // 分批接单，别把 body 撑大
      for (let i = 0; i < pending.length; i += 20) {
        const batch = pending.slice(i, i + 20);
        const a = await p(`${base}/tasks/accept`, { task_codes: batch });
        if (authAbort(a.status)) return abortResult(a.status);
        // 逐条读 results：接单失败必须报出来（常见 prerequisite not met），静默吞掉接口坏了没人知道
        let results = dig(a.json, 'results');
        if (!Array.isArray(results)) {
          results = batch.map((code) => ({
            task_code: code,
            status: !a.networkError && a.status >= 200 && a.status < 300 ? 'ok' : 'error',
            message: a.networkError || dig(a.json, 'msg'),
          }));
        }
        for (const r of results) {
          const title = titles.get(r?.task_code) || r?.task_code;
          if (r?.status === 'error') {
            parts.push(`领取任务「${title}」失败：${r?.message || `HTTP ${a.status}`}`);
            failures += 1;
            hardFailures += isHardFailure(a.status, a.networkError) ? 1 : 0;
          } else {
            parts.push(`领取任务「${title}」（进度开始计）`);
            successes += 1;
          }
        }
      }
      await claimCompleted(tasks);
    }
  } catch (e) {
    parts.push(`任务模块异常（${e?.message || e}）`);
    failures += 1;
    hardFailures += 1;
  }

  // --- 2.5 对话任务补全（免费模型优先 → 低倍率模型兜底）---
  /**
   * chat_* 类任务只有真实发起模型对话才会计进度（见 usageTasks.mjs 头注释）。
   * 上一段只接单/领奖，这里复查一遍：还有对话缺口的就用选定模型补足，
   * 补完再复查并补领奖。整段独立 try，失败不影响其余模块。
   */
  try {
    const t2 = await g(`${base}/tasks`);
    if (authAbort(t2.status)) return abortResult(t2.status);
    if (!noteHttp(t2, '查任务进度')) {
      const backlog = chatTaskBacklog(dig(t2.json, 'tasks'));
      if (backlog.length) {
        const r2 = await completeChatTasks(account, backlog, {
          systemProxy: options.systemProxy,
        });
        parts.push(...r2.parts);
        successes += r2.successes;
        failures += r2.failures;
        hardFailures += r2.hardFailures;
        if (r2.changed) {
          // 对话发出后服务端把进度落成 completed 有秒级延迟：立即复查领一次，
          // 仍有未完成的等几秒再复查一轮（claim 幂等，多查无害）。
          const pendingCodes = new Set(backlog.map((b) => b.code));
          for (let attempt = 0; attempt < 2; attempt++) {
            const t3 = await g(`${base}/tasks`);
            if (authAbort(t3.status) || noteHttp(t3, '复查任务')) break;
            const fresh = dig(t3.json, 'tasks') || [];
            for (const x of fresh) if (!titles.has(x?.task_code)) titles.set(x?.task_code, x?.title || x?.task_code);
            await claimCompleted(fresh);
            const stillPending = fresh.some((x) => pendingCodes.has(x?.task_code) && x?.accept_status !== 'claimed');
            if (!stillPending) break;
            await new Promise((r) => setTimeout(r, CLAIM_RECHECK_DELAY_MS));
          }
        }
      }
    }
  } catch (e) {
    parts.push(`对话任务补全异常（${e?.message || e}）`);
    failures += 1;
    hardFailures += 1;
  }

  // --- 3. 补登卡：断登自动补一张，保住连登（放在连登兑换之前：补登改变连登天数）---
  let streakBody = null; // 复用给第 7 段展示值，避免同一轮打两次 /streak
  let streakStale = false; // 补登成功会改变连签天数，此时必须重新取
  try {
    const m = await g(`${base}/streak`);
    if (authAbort(m.status)) return abortResult(m.status);
    if (!noteHttp(m, '查连登状态', { required: true })) {
      streakBody = m.json;
      // 余额兼容两种形状：{"makeup_cards":{"balance":2}} 与 {"makeup_cards":2}
      const cardsObj = dig(m.json, 'makeup_cards');
      let cards = cardsObj && typeof cardsObj === 'object' ? asInt(cardsObj.balance) : asInt(cardsObj);
      let dates = [];
      if (cards > 0) {
        const h = await g(`${base}/heatmap`);
        if (authAbort(h.status)) return abortResult(h.status);
        if (!noteHttp(h, '查补登日历', { required: true })) {
          dates = makeupCandidates(m.json, h.json);
        }
      }
      if (dates.length) {
        let madeUp = 0;
        for (const d of dates.slice(0, Math.min(cards, MAKEUP_MAX_PER_RUN))) {
          const u = await p(`${base}/makeup-cards/use`, { target_date: d });
          if (authAbort(u.status)) return abortResult(u.status);
          if (apiSuccess(u.status, u.json)) {
            cards -= 1;
            madeUp += 1;
            streakStale = true;
            // 优先报服务端给的余额，本地递减只是接口没给时的兜底
            const leftObj = dig(u.json, 'makeup_cards');
            const left = leftObj && typeof leftObj === 'object' ? asInt(leftObj.balance, cards) : asInt(leftObj, cards);
            parts.push(`补登 ${d}（剩 ${left} 张卡）`);
            cards = Math.max(0, left);
            successes += 1;
          } else {
            const msg = String(dig(u.json, 'msg') || '');
            if (u.status === 400 && msg.trim().toLowerCase() === 'date is not broken, no makeup needed') {
              // 查询后被客户端或另一轮补上，是正常竞争，不再当失败刷日志
              parts.push(`${d} 已活跃或已补登，无需再次补登`);
              break;
            }
            parts.push(`补登 ${d} 失败：${u.networkError || msg || `HTTP ${u.status}`}`);
            failures += 1;
            hardFailures += 1;
            break;
          }
        }
        if (madeUp && dates.length > madeUp && cards > 0) {
          parts.push(`另有 ${dates.length - madeUp} 天可补、剩 ${cards} 张卡，下轮继续`);
        }
      }
    }
  } catch (e) {
    parts.push(`补登模块异常（${e?.message || e}）`);
    failures += 1;
    hardFailures += 1;
  }

  // --- 4. 连登奖励兑换（入门/进阶/巅峰三档）---
  try {
    const r = await g(`${base}/redeem/summary`);
    if (authAbort(r.status)) return abortResult(r.status);
    if (!noteHttp(r, '查连登兑换')) {
      for (const { tier, statusKey, label, days } of REDEEM_TIERS) {
        const status = dig(r.json, statusKey);
        // 字段缺失同样跳过：接口改版时不该对三档无脑 POST；claimed/locked 没有可兑的
        if (!status || status === 'claimed' || status === 'locked') continue;
        let c = await p(`${base}/redeem`, { tier, client_token: clientToken() });
        // 档位标识被判未知时退回天数再试一次（参数校验阶段拒绝，重试不会重复领取）
        if (isUnknownTier(c.status, c.json)) {
          c = await p(`${base}/redeem`, { tier: days, client_token: clientToken() });
        }
        // 403「连登天数不足」是业务常态，必须先于通用 authAbort 判断
        if (isTierLocked(c.status, c.json)) {
          parts.push(`连登兑换「${label}」未解锁（连登天数不足）`);
          continue;
        }
        if (authAbort(c.status)) return abortResult(c.status);
        if (!c.networkError && c.status >= 200 && c.status < 300) {
          creditsGained += asInt(dig(c.json, 'credit_granted'), 0);
          parts.push(`连登兑换「${label}」${redeemRewardDesc(c.json, tier)}`);
          successes += 1;
        } else {
          const msg = c.networkError || String(dig(c.json, 'msg') || `HTTP ${c.status}`);
          parts.push(`连登兑换「${label}」失败：${msg}`);
          failures += 1;
          hardFailures += isHardFailure(c.status, c.networkError) ? 1 : 0;
        }
      }
    }
  } catch (e) {
    parts.push(`连登兑换模块异常（${e?.message || e}）`);
    failures += 1;
    hardFailures += 1;
  }

  // --- 5. 盲盒/抽奖（draw 必须带 client_token，缺了 400；一轮只开一次，这条写路径不可逆）---
  try {
    const l = await g(`${base}/lottery/chances`);
    if (authAbort(l.status)) return abortResult(l.status);
    const chances = noteHttp(l, '查抽奖机会') ? 0 : asInt(dig(l.json, 'balance'));
    if (chances > 0) {
      const d = await p(`${base}/lottery/draw`, { client_token: clientToken() });
      if (authAbort(d.status)) return abortResult(d.status);
      if (!d.networkError && d.status >= 200 && d.status < 300) {
        let prize = dig(d.json, 'prize_name') || dig(d.json, 'prize') || '未知';
        if (typeof prize !== 'string') prize = String(prize);
        // 奖池含实物周边，中奖后要用户自己填收件信息——脚本代填不了也绝不该代填，但必须提醒
        if (dig(d.json, 'need_address') || dig(d.json, 'require_address')) {
          prize += '（实物奖，需到成长中心填写收件信息）';
        }
        parts.push(`开盲盒获得：${prize}`);
        successes += 1;
        if (chances > 1) parts.push(`还剩 ${chances - 1} 次抽奖机会，下轮继续`);
      } else {
        const msg = String(dig(d.json, 'msg') || '');
        if (isNoChance(msg)) {
          parts.push(`开盲盒：${msg || '无抽奖机会'}`);
        } else {
          parts.push(`开盲盒失败：${d.networkError || msg || `HTTP ${d.status}`}`);
          failures += 1;
          hardFailures += isHardFailure(d.status, d.networkError) ? 1 : 0;
        }
      }
    }
  } catch (e) {
    parts.push(`盲盒模块异常（${e?.message || e}）`);
    failures += 1;
    hardFailures += 1;
  }

  // --- 6. Buddy 盲盒（能量攒够就开；能量没有其它消耗出口）---
  try {
    const q = await g(`${base}/buddy/quota`);
    if (authAbort(q.status)) return abortResult(q.status);
    if (!noteHttp(q, '查 Buddy 能量')) {
      const affordable = asInt(dig(q.json, 'affordable'));
      const maxOpen = asInt(dig(q.json, 'max_open_count'), 1) || 1;
      if (affordable > 0) {
        const count = Math.min(affordable, maxOpen);
        const o = await p(`${base}/buddy/open`, { count, client_token: clientToken() });
        if (authAbort(o.status)) return abortResult(o.status);
        if (!o.networkError && o.status >= 200 && o.status < 300) {
          let name = dig(o.json, 'buddy') || dig(o.json, 'name') || dig(o.json, 'buddies');
          if (typeof name !== 'string') name = '新 Buddy';
          parts.push(`开 Buddy 盲盒 ×${count}（${name}）`);
          successes += 1;
        } else {
          const msg = o.networkError || String(dig(o.json, 'msg') || `HTTP ${o.status}`);
          parts.push(`开 Buddy 盲盒失败：${msg}`);
          failures += 1;
          hardFailures += isHardFailure(o.status, o.networkError) ? 1 : 0;
        }
      }
    }
  } catch (e) {
    parts.push(`Buddy 盲盒模块异常（${e?.message || e}）`);
    failures += 1;
    hardFailures += 1;
  }

  // --- 7. 能量 & 连签状态（纯展示值，取不到不计失败）---
  let energy = null;
  let streakDays = null;
  try {
    const e = await g(`${base}/energy`);
    if (!authAbort(e.status) && !e.networkError && e.status >= 200 && e.status < 300) {
      energy = dig(e.json, 'balance');
    }
  } catch {
    /* 展示值，忽略 */
  }
  try {
    if (streakBody !== null && !streakStale) {
      const obj = dig(streakBody, 'streak');
      streakDays = obj && typeof obj === 'object' ? obj.days ?? null : null;
    } else {
      const s2 = await g(`${base}/streak`);
      if (!authAbort(s2.status) && !s2.networkError && s2.status >= 200 && s2.status < 300) {
        const obj = dig(s2.json, 'streak');
        streakDays = obj && typeof obj === 'object' ? obj.days ?? null : null;
      }
    }
  } catch {
    /* 展示值，忽略 */
  }

  const tail = [];
  if (energy !== null && energy !== undefined) tail.push(`能量 ${energy}`);
  if (streakDays !== null && streakDays !== undefined) tail.push(`连签 ${streakDays} 天`);
  if (creditsGained) tail.push(`本次 +共 ${creditsGained} 积分`);

  let report;
  if (parts.length) report = parts.join('；');
  else if (failures) report = '成长中心各步骤均失败';
  else report = '成长中心无可领取项';
  if (tail.length) report += `（${tail.join('，')}）`;

  // idle = 这一轮既没领到东西也没出错，纯空跑（Buddy 还在路上/名额已用完/没有可领项）
  const idle = successes === 0 && failures === 0;
  return {
    ok: hardFailures === 0,
    report,
    parts,
    creditsGained,
    energy,
    streakDays,
    failures,
    hardFailures,
    idle,
  };
}
