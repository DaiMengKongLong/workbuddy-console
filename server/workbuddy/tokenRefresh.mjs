/**
 * 账号凭据自动刷新（防止"很久没切换的账号"静默失效）。
 *
 * ## 为什么需要
 *
 * 账号库里的 `access_token` / `refresh_token` 都是有有效期的，而**唯一**会去刷新它们的地方是
 * 反向代理处理请求时（`server/proxy/index.mjs`）——而且只在"到期前 60 秒"那个极窄窗口里触发。
 * 于是「既没被切换过、也没走过代理」的账号会一路静默过期，等到想用时只能重新扫码登录。
 *
 * ## 刷新判据（保守优先：宁可少刷，也不把官方服务端当轮换试验田）
 *
 * | 情况 | 动作 |
 * | --- | --- |
 * | access_token 剩余 < 24h | 刷 |
 * | refresh_token 剩余 < 72h | 刷（兜底：refresh 一过期就再也救不回来） |
 * | 两个有效期字段都缺失 | **不刷**（判断不了，别瞎猜） |
 * | refresh_token 已过期 | 不刷，标记 `dead`，界面提示重新登录 |
 * | 没有明文 refresh_token | 不刷，标记需重新扫码 |
 *
 * 只在这三种"已经临期"的时机动手，是为了把**轮换风险**压到最低：如果官方在刷新时轮换
 * refresh_token，我们持有的旧值会失效，而 WorkBuddy 自己的登录态文件里还存着它自己那一份。
 * 频次越高，两方互相踩到的概率越大；临期才刷，实质上只在"反正也要死了"的时刻出手。
 *
 * ## 与其他模块的边界
 *
 * - 刷新动作复用 `server/proxy/wb.mjs` 的 `refreshAccessToken`（它已负责端点、请求头、
 *   原子写回账号库），这里**不重复实现**协议细节。
 * - 日志写在 `~/.wb-switch/token_refresh_logs.json`（本工具私有，与 workbuddy-switch 无交集），
 *   只记结果与到期时间，**绝不记 token**。
 */
import path from 'node:path';
import {
  STORE_DIR,
  loadAccounts,
  accountDisplayName,
  secretValue,
  readJsonFile,
} from './accounts.mjs';
import { variantOf } from './variant.mjs';
import { refreshAccessToken } from '../proxy/wb.mjs';
import { atomicWriteJson } from '../store/config.mjs';

/** access_token 剩余不足这个小时数就刷新 */
export const ACCESS_MIN_HOURS = 24;
/** refresh_token 剩余不足这个小时数就刷新（整条链过期前的最后机会） */
export const REFRESH_MIN_HOURS = 72;

/** 本工具私有的刷新日志（不含任何 token） */
export const REFRESH_LOGS_FILE = path.join(STORE_DIR, 'token_refresh_logs.json');
const LOG_LIMIT = 200;
const HOUR_MS = 3600 * 1000;

/** 时间戳 → 剩余小时数；无法判断时返回 null（而不是 0，两者语义完全不同） */
function hoursLeft(ts, now) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  return (n - now) / HOUR_MS;
}

/** 明文（非信封）字符串字段 */
function plain(account, key) {
  const v = secretValue(account, key);
  return typeof v === 'string' && v.trim() ? v : '';
}

/**
 * 单个账号的刷新判定。纯函数，便于回归测试直接喂时间戳。
 * 返回 { id, name, variant, accessHours, refreshHours, hasRefreshToken, dead, due, reason }
 */
export function refreshPlanFor(account, { now = Date.now(), force = false } = {}) {
  const accessHours = hoursLeft(account?.expiresAt, now);
  const refreshHours = hoursLeft(account?.refreshExpiresAt, now);
  const hasRefreshToken = !!plain(account, 'refresh_token');
  const hasAccess = !!plain(account, 'access_token');

  const base = {
    id: account?.id || '',
    uid: account?.uid || '',
    name: accountDisplayName(account),
    variant: variantOf(account).id,
    accessHours,
    refreshHours,
    hasRefreshToken,
    hasPlainAccess: hasAccess,
    dead: false,
    due: false,
    reason: 'ok',
  };

  if (!hasRefreshToken) {
    // 只能靠已导入的明文 access_token 撑着：一过期就只能重新扫码。所以**临期就该示警**，
    // 而不是等到真的过期了才说"用不了"——那时用户已经只能重新登录了。
    const dying = accessHours != null && accessHours <= ACCESS_MIN_HOURS;
    return { ...base, dead: dying, due: false, reason: 'no-refresh-token' };
  }
  if (refreshHours != null && refreshHours <= 0) {
    return { ...base, dead: true, reason: 'dead' };
  }
  if (force) return { ...base, due: true, reason: 'manual' };

  if (accessHours != null && accessHours < ACCESS_MIN_HOURS) {
    return { ...base, due: true, reason: 'access-expiring' };
  }
  if (refreshHours != null && refreshHours < REFRESH_MIN_HOURS) {
    return { ...base, due: true, reason: 'refresh-expiring' };
  }
  // 两个有效期都缺失：判断不了，不动它
  if (accessHours == null && refreshHours == null) return { ...base, reason: 'unknown-expiry' };
  return base;
}

/** 全部账号的判定结果（界面用；不含 token） */
export function refreshPlan({ now = Date.now() } = {}) {
  return loadAccounts().map((a) => refreshPlanFor(a, { now }));
}

/** 读取刷新日志（最新在前） */
export function loadRefreshLogs() {
  const rows = readJsonFile(REFRESH_LOGS_FILE, []);
  return Array.isArray(rows) ? rows.slice().reverse() : [];
}

/** 最近一次巡检的汇总（界面用） */
export function lastRefreshRun() {
  const rows = readJsonFile(REFRESH_LOGS_FILE, []);
  if (!Array.isArray(rows) || !rows.length) return null;
  const lastAt = Number(rows[rows.length - 1]?.at) || null;
  const sameRun = rows.filter((r) => r?.at === lastAt);
  return { at: lastAt, refreshed: sameRun.filter((r) => r.ok && r.action === 'refreshed').length };
}

function appendRefreshLogs(entries) {
  const rows = readJsonFile(REFRESH_LOGS_FILE, []);
  const list = Array.isArray(rows) ? rows : [];
  const stamped = entries.map((e) => ({ ...e, at: Date.now() }));
  try {
    atomicWriteJson(REFRESH_LOGS_FILE, [...list, ...stamped].slice(-LOG_LIMIT));
  } catch {
    /* 日志写失败不影响刷新结果 */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 执行刷新。
 *
 * @param {object}   opts
 * @param {string[]} [opts.accountIds] 只处理这些账号（id 或 uid）；不传 = 全部
 * @param {boolean}  [opts.force]      跳过临期判定，强制刷新（用户手动点「立即刷新」）
 * @param {number}   [opts.delayMs]    每次刷新之间的间隔，避免连续打官方接口
 * @returns {{ results: object[], summary: object }}
 */
export async function refreshAccounts({ accountIds = null, force = false, delayMs = 400 } = {}) {
  const wanted = Array.isArray(accountIds) && accountIds.length ? new Set(accountIds) : null;
  const targets = loadAccounts().filter((a) => !wanted || wanted.has(a?.id) || wanted.has(a?.uid));

  const results = [];
  for (const account of targets) {
    const plan = refreshPlanFor(account, { force });
    if (plan.dead) {
      results.push({
        ok: false,
        action: 'dead',
        reason: plan.reason,
        message:
          plan.reason === 'dead'
            ? 'refresh_token 已过期，需用 WorkBuddy 重新扫码登录后再导入'
            : '该账号没有 refresh_token，access_token 一过期就只能重新扫码登录',
        ...metaOf(plan),
      });
      continue;
    }
    if (!plan.due) {
      results.push({ ok: true, action: 'skipped', reason: plan.reason, message: '', ...metaOf(plan) });
      continue;
    }

    const before = { accessHours: plan.accessHours, refreshHours: plan.refreshHours };
    try {
      await refreshAccessToken(account);
      // 重新读盘拿刷新后的有效期（refreshAccessToken 已原子写回）
      const after = loadAccounts().find((a) => a?.id === account.id || a?.uid === account.uid) || account;
      const next = refreshPlanFor(after, { now: Date.now() });
      results.push({
        ok: true,
        action: 'refreshed',
        reason: plan.reason,
        message: '',
        ...metaOf(next),
        before,
      });
      appendRefreshLogs([
        {
          ts: Date.now(),
          accountId: plan.id,
          accountName: plan.name,
          variant: plan.variant,
          ok: true,
          action: 'refreshed',
          reason: plan.reason,
          accessHours: next.accessHours,
          refreshHours: next.refreshHours,
        },
      ]);
    } catch (e) {
      const message = e?.message || '刷新失败';
      results.push({ ok: false, action: 'failed', reason: plan.reason, message, ...metaOf(plan) });
      appendRefreshLogs([
        {
          ts: Date.now(),
          accountId: plan.id,
          accountName: plan.name,
          variant: plan.variant,
          ok: false,
          action: 'failed',
          reason: plan.reason,
          message,
        },
      ]);
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  const summary = {
    total: results.length,
    refreshed: results.filter((r) => r.action === 'refreshed').length,
    skipped: results.filter((r) => r.action === 'skipped').length,
    failed: results.filter((r) => r.action === 'failed').length,
    dead: results.filter((r) => r.action === 'dead').length,
  };
  return { results, summary };
}

/** 结果里对外的账号字段（不含任何 token） */
function metaOf(plan) {
  return {
    accountId: plan.id,
    accountName: plan.name,
    variant: plan.variant,
    accessHours: plan.accessHours,
    refreshHours: plan.refreshHours,
  };
}
