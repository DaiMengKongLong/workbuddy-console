/**
 * OAuth 扫码登录采集（复刻 workbuddy-switch 的 oauth.rs）。
 *
 * 流程：向官方申请 state → 前端展示二维码/链接（或直接开浏览器授权）→
 * **服务端后台轮询** token 接口 → 拿到 access_token 后拉账号信息 →
 * 校验档位一致性 → 写入账号库。
 *
 * 关键约束（与参考实现保持一致，改动前先读）：
 * - **每个 loginId 独立记录发起档位**，轮询时沿用该档位拼域名与 platform，
 *   绝不跟随当前列表档位——否则会拿国内版的 state 去国际版换 token。
 * - **domain 档位校验**：token 与 profile 两处响应的 domain 都必须与发起
 *   档位匹配，不符即拒绝入库（混档账号会让客户端一直处于登录失效状态）。
 * - **轮询常驻服务端**（见 startBackgroundCollect）：手机授权是异步完成的，
 *   用户常常关掉弹窗或刷新页面，前端轮询会让登录态白拿——手机显示成功、
 *   账号却没进库。前端只读状态。
 * - 明细逐笔不求和这类坑这里没有，但 upsert 必须按 uid 匹配并保留本地
 *   备注/展示字段，重复扫码会更新凭据而不是堆一条新记录。
 */
import { randomUUID } from 'node:crypto';
import { proxyFetch } from '../proxy.mjs';
import { getVariant, officialNetHint } from './variant.mjs';
import { loadAccounts, saveAccounts, accountMeta } from './accounts.mjs';
import { verifyNewAccount } from './tokenRefresh.mjs';

/** 单次扫码登录的有效期（秒），与官方 state 有效期对齐 */
const OAUTH_TIMEOUT_SECONDS = 600;

/** loginId -> { variant, state, expiresAt, done, result, error } */
const OAUTH_STATES = new Map();

/** 国际版域后缀：只认后缀，避免相似域名被误判 */
const AI_DOMAIN_SUFFIX = '.workbuddy.ai';

function hasAiDomainSuffix(domain) {
  return String(domain || '').trim().toLowerCase().endsWith(AI_DOMAIN_SUFFIX);
}

/** 响应 domain 是否与档位匹配；空 domain 视为匹配（官方未回退时放行） */
function matchesDomain(variant, domain) {
  const d = String(domain || '').trim();
  if (!d) return true;
  return variant.id === 'ai' ? hasAiDomainSuffix(d) : !hasAiDomainSuffix(d);
}

function domainMismatchError(variant, domain) {
  if (matchesDomain(variant, domain)) return null;
  return `登录响应的 domain（${String(domain)}）与${variant.label}档位不符，已拒绝入库`;
}

/** 申请 state 的 URL（域名、前缀、platform 全部取自档位） */
function oauthStateUrl(variant) {
  return `${variant.apiEndpoint}${variant.apiPrefix}/auth/state?platform=${encodeURIComponent(variant.oauthPlatform)}`;
}

/** 换取 token 的 URL。必须用**发起档位**，不能跟随当前列表档位。 */
function oauthTokenUrl(variant, state) {
  return `${variant.apiEndpoint}${variant.apiPrefix}/auth/token?state=${encodeURIComponent(state)}`;
}

/** 拉取账号信息的 URL（同档位）。 */
function oauthAccountUrl(variant, state) {
  return `${variant.apiEndpoint}${variant.apiPrefix}/login/account?state=${encodeURIComponent(state)}`;
}

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

/** 官方 JSON 请求；网络层失败抛错（由路由层转成错误响应），HTTP 错误状态返回解析后的 body。
 * 必须带 variant：连不上时要按档位给出「国际版需要代理 / 国内版查网络」的提示，
 * 而不是模型平台那条笼统的 VPN 文案。 */
async function officialJson(url, { method = 'GET', body, headers, variant } = {}) {
  const res = await proxyFetch(url, {
    method,
    headers: { ...JSON_HEADERS, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    netHint: variant ? officialNetHint(variant.id) : undefined,
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // 非 JSON 响应：保持与参考实现一致的形状，让上层按 code!=0 视为"尚未完成"
    return { code: res.status, message: text.slice(0, 200) };
  }
}

/** 归一化官方时间字段：字符串/数字均可，秒级自动升为毫秒 */
function normTs(value) {
  let ts;
  if (typeof value === 'string') {
    const n = Number(value.trim());
    if (!Number.isFinite(n)) return null;
    ts = Math.trunc(n);
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    ts = Math.trunc(value);
  } else return null;
  if (Math.abs(ts) < 10_000_000_000) ts *= 1000;
  return ts;
}

function str(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/** 从 profile 读邮箱；没有就留空，不拿昵称/uid 冒充 */
function profileEmail(profile) {
  return str(profile?.email);
}

/**
 * 发起扫码登录：向官方申请 state，返回 loginId / verificationUri / expiresIn。
 * variantId 缺省国内版。
 */
export async function oauthStart(variantId = 'cn') {
  const variant = getVariant(variantId);
  const loginId = `wb_${randomUUID().replace(/-/g, '')}`;

  const resp = await officialJson(oauthStateUrl(variant), { method: 'POST', body: {}, variant });
  const data = resp?.data && typeof resp.data === 'object' ? resp.data : {};
  const state = str(data.state);
  if (!state) {
    const snippet = JSON.stringify(resp).slice(0, 300);
    throw new Error(`auth/state 响应缺少 state: ${snippet}`);
  }

  // 官方字段名历史上在 authUrl / auth_url / url 之间变过，逐个兼容
  const verificationUri =
    str(data.authUrl) || str(data.auth_url) || str(data.url) || `${variant.apiEndpoint}/login?state=${encodeURIComponent(state)}`;

  OAUTH_STATES.set(loginId, {
    variant,
    state,
    expiresAt: Date.now() + OAUTH_TIMEOUT_SECONDS * 1000,
    done: false,
    result: null,
    error: null,
    lastCode: null,
    lastMessage: '',
    lastPollAt: 0,
    pollCount: 0,
    failures: 0,
  });

  // 顺手清理过期记录，避免长时间不关弹窗时 Map 无限增长
  for (const [id, info] of OAUTH_STATES) {
    if (!info.done && info.expiresAt < Date.now()) OAUTH_STATES.delete(id);
  }

  // 后台常驻采集：前端关弹窗/刷新页面都不影响账号入库
  startBackgroundCollect();

  return { loginId, verificationUri, expiresIn: OAUTH_TIMEOUT_SECONDS };
}

function failOAuth(loginId, error) {
  const info = OAUTH_STATES.get(loginId);
  if (info) {
    info.done = true;
    info.error = error;
  }
  return { done: true, error };
}

/**
 * 轮询一次并把结果写回 OAUTH_STATES（幂等：done 后直接返回）。
 * 返回 { done, result?, error? }。
 */
async function pollOnce(loginId) {
  const info = OAUTH_STATES.get(loginId);
  if (!info) return { done: true, error: '登录请求不存在' };
  if (info.done) return { done: true, result: info.result, error: info.error };
  if (Date.now() > info.expiresAt) {
    info.done = true;
    info.error = '登录超时，请重新发起扫码';
    return { done: true, error: info.error };
  }

  // 用发起档位拼域名与 platform，不跟随当前列表档位
  const { variant, state } = info;
  const resp = await officialJson(oauthTokenUrl(variant, state), { variant });
  const code = typeof resp?.code === 'number' ? resp.code : -1;
  info.lastCode = code;
  info.lastMessage = str(resp?.msg) || str(resp?.message) || '';
  info.lastPollAt = Date.now();
  info.pollCount = (info.pollCount || 0) + 1;

  if (code !== 0 && code !== 200) {
    // 鉴权类失败不可能是"还没扫"，直接给出可读错误，避免干等到超时
    if (code === 401 || code === 403) {
      return failOAuth(loginId, `登录凭证校验失败（code ${code}），请重新发起扫码`);
    }
    return { done: false }; // 其余（如 11217 login ing）都视为用户尚未完成授权
  }

  const data = resp?.data && typeof resp.data === 'object' ? resp.data : {};
  const accessToken = str(data.accessToken) || str(data.access_token);
  if (!accessToken) return { done: false };

  const domain = str(data.domain);
  const mismatch = domainMismatchError(variant, domain);
  if (mismatch) return failOAuth(loginId, mismatch);

  // 拉账号信息
  const accHeaders = { Authorization: `Bearer ${accessToken}` };
  if (domain) accHeaders['X-Domain'] = domain;
  const accResp = await officialJson(oauthAccountUrl(variant, state), { headers: accHeaders, variant });
  const accData = accResp?.data && typeof accResp.data === 'object' ? accResp.data : {};

  const profileMismatch = domainMismatchError(variant, str(accData.domain));
  if (profileMismatch) return failOAuth(loginId, profileMismatch);

  const now = Date.now();
  const record = {
    id: randomUUID(),
    uid: str(accData.uid) || null,
    nickname: str(accData.nickname) || null,
    email: profileEmail(accData) || null,
    enterpriseName: accData.enterpriseName ?? null,
    enterpriseId: accData.enterpriseId ?? null,
    access_token: accessToken,
    refresh_token: str(data.refreshToken) || str(data.refresh_token) || null,
    token_type: str(data.tokenType) || str(data.token_type) || 'Bearer',
    domain: domain || variant.apiEndpoint,
    // 档位随登录来源写入：后续切换/刷新/积分/签到都以它为准
    variant: variant.id,
    expiresAt: normTs(data.expiresAt ?? data.expires_at) ?? (Number(data.expiresIn) ? now + Number(data.expiresIn) * 1000 : null),
    refreshExpiresAt: normTs(data.refreshExpiresAt ?? data.refresh_expires_at) ?? (Number(data.refreshExpiresIn) ? now + Number(data.refreshExpiresIn) * 1000 : null),
    auth_raw: data,
    profile_raw: accData,
    createdAt: now,
  };

  const saved = upsertCollectedAccount(record);
  saveAccounts(saved.accounts);
  const result = accountMeta(saved.record);
  info.done = true;
  info.result = result;
  info.error = null;
  console.log(`[oauth] 已采集账号：${result?.name || result?.uid || '(未命名)'}（档位 ${variant.id}）`);

  /**
   * 入库即验活：徽章只认服务端验活结论，不验就要等 6 小时巡检，新账号会一直挂着
   * 「待验活」（2026-10-20 反馈）。这里是扫码后唯一能拿到新鲜 token 的地方，
   * 收尾顺手验一次，前端随后 reload 列表就能看到真实状态。
   * 失败/超时都不影响入库结果——只在有结论时补进返回值。
   */
  const verify = await verifyNewAccount(result?.uid || result?.id);
  // info.result 与 result 是同一个对象，补上 verify 后后续轮询也能读到
  if (verify) result.verify = verify;
  return { done: true, result };
}

/* ---------------- 后台采集循环 ---------------- */

/**
 * 前端只负责展示：真正的轮询放在服务端跑。
 *
 * 手机扫码后的授权是异步完成的，用户经常会「关掉弹窗 / 刷新页面 / 切到别的页签」，
 * 一旦由前端轮询，这些动作都会让登录态白拿——手机显示成功、账号却没进库。
 * 服务端常驻轮询后再由前端读结果，弹窗关掉也不影响入库。
 */
const BG_POLL_MS = 2000;
const MAX_CONSECUTIVE_FAILURES = 15;
let bgTimer = null;
let bgBusy = false;

function hasActive() {
  for (const info of OAUTH_STATES.values()) if (!info.done) return true;
  return false;
}

function startBackgroundCollect() {
  if (bgTimer) return;
  bgTimer = setInterval(async () => {
    if (bgBusy) return;
    bgBusy = true;
    try {
      for (const [loginId, info] of OAUTH_STATES) {
        if (info.done) continue;
        if (Date.now() > info.expiresAt) {
          info.done = true;
          info.error = '登录超时，请重新发起扫码';
          continue;
        }
        try {
          await pollOnce(loginId);
        } catch (e) {
          info.lastMessage = e?.message || String(e);
          info.failures = (info.failures || 0) + 1;
          // 网络持续失败时不要一直傻等，给出可读原因
          if (info.failures >= MAX_CONSECUTIVE_FAILURES) {
            info.done = true;
            info.error = `轮询失败：${info.lastMessage}`;
          }
        }
      }
    } finally {
      bgBusy = false;
    }
    if (!hasActive()) {
      clearInterval(bgTimer);
      bgTimer = null;
    }
  }, BG_POLL_MS);
}

/**
 * 读取扫码结果（纯内存读取，不发起网络请求）。
 * { done:false, code, message } 表示还在等待授权，code/message 是官方接口的原始状态，
 * 用于界面提示"到底是没扫，还是服务端还在处理"。
 */
export function oauthPoll(loginId) {
  const info = OAUTH_STATES.get(loginId);
  if (!info) return { done: true, error: '登录请求不存在（服务可能已重启，请重新发起扫码）' };
  if (info.done) return { done: true, result: info.result, error: info.error };
  return { done: false, code: info.lastCode ?? null, message: info.lastMessage || '', pollCount: info.pollCount || 0 };
}

/**
 * 按 uid（无 uid 时回退 email）匹配入库：
 * 命中则保留原 id / createdAt / 备注 / 展示字段，只更新凭据与官方资料；
 * 未命中则追加。返回 { accounts, record } 供调用方落盘。
 */
function upsertCollectedAccount(collected) {
  const accounts = loadAccounts();
  const identity = (a) => (collected.uid ? str(a?.uid) === collected.uid : !!collected.email && str(a?.email) === collected.email);
  const matches = accounts.map((a, i) => (identity(a) ? i : -1)).filter((i) => i >= 0);

  if (matches.length > 0) {
    const first = matches[0];
    const existing = accounts[first];
    const merged = {
      ...existing,
      ...collected,
      // 本地字段不来自官方采集：保留已有值
      note: existing.note ?? collected.note ?? null,
      displayField: existing.displayField || collected.displayField || 'auto',
      id: existing.id || collected.id,
      uid: existing.uid || collected.uid,
      createdAt: existing.createdAt || collected.createdAt,
      variant: existing.variant || collected.variant,
    };
    // 同 uid 的历史重复记录一并清掉，保持账号库不变量
    for (const idx of [...matches].reverse()) accounts.splice(idx, 1);
    accounts.splice(Math.min(first, accounts.length), 0, merged);
    return { accounts, record: merged };
  }

  accounts.push(collected);
  return { accounts, record: collected };
}
