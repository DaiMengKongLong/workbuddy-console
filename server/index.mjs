import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  loadConfig,
  saveConfigAsync,
  newId,
  maskKey,
  CONFIG_FILE,
  cachePath,
  activeKeyFor,
} from './store/config.mjs';
import { providers, getProvider, listPlatforms, PLATFORM_ORDER } from './providers/registry.mjs';
import { clearModelsCache, modelsCacheFile } from './providers/genericOpenAI.mjs';
import { getProxyUrl } from './proxy.mjs';
import { loadAccounts, accountMeta, findAccount, accountDisplayName, hasPlainToken } from './workbuddy/accounts.mjs';
import { oauthStart, oauthPoll } from './workbuddy/oauth.mjs';
import {
  switchAccount,
  detectCurrentAccount,
  importLocalAccount,
  deleteAccount,
  updateAccountDisplay,
} from './workbuddy/auth.mjs';
import {
  getCreditStatistics,
  getOfflineCreditProjection,
  getAccountBalances,
  getCreditDetails,
  // 提速版在 credit-stats 路由尾部调用了它（预热 7/90 天），但漏了 import：
  // 缺这行每次统计请求都会抛 ReferenceError（响应已发出，只在服务端日志里炸）
  prefetchCreditRanges,
} from './workbuddy/credits.mjs';
import { refreshAccessToken } from './proxy/wb.mjs';
import { VARIANT_LIST } from './workbuddy/variant.mjs';
import { checkinAll, checkinAccount, fetchCheckinStatus, loadCheckinLogs, allCheckedInToday, allGrowthDoneToday } from './workbuddy/checkin.mjs';
import { fetchTravelStatus } from './workbuddy/growth.mjs';
import {
  refreshAccounts,
  refreshPlan,
  loadRefreshLogs,
  lastRefreshRun,
  loadCredentialStatus,
  verifyStateOf,
  verifyAccount,
  verifyNewAccount,
  ACCESS_MIN_HOURS,
  REFRESH_MIN_HOURS,
} from './workbuddy/tokenRefresh.mjs';
import { checkForUpdate, LOCAL_VERSION } from './update.mjs';
import { applyHotUpdate, readUpdateState } from './hotupdate.mjs';
import { registerProxyRoutes, refreshModelsCache } from './proxy/index.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT || 57891);

const app = express();
// 反向代理的对话请求体可能很长（大上下文 / 工具调用），单独放宽到 12MB；
// 放在全局 1MB 解析器之前，命中的请求不会被后者拦下。
// /v1 与 /v1beta 是两个独立前缀（前者不含后者），Gemini 原生协议走 /v1beta，需单独挂。
app.use('/v1', express.json({ limit: '12mb' }));
app.use('/v1beta', express.json({ limit: '12mb' }));
app.use(express.json({ limit: '1mb' }));

const wrap = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((err) => {
    const status = Number(err?.status) || 500;
    // 4xx 是调用方参数问题，不打成服务器错误日志，避免日志噪音
    if (status >= 500) console.error(`[api] ${req.method} ${req.path}:`, err?.message || err);
    res.status(status).json({ error: err?.message || '服务器内部错误' });
  });
};

// 服务保命：未捕获的异步异常/Rejection 只记日志，绝不让进程整个消失——
// 用户点「一键同步」跑到一半服务闪退（页面变「本地服务已断开」）就是这类错误杀的。
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.stack || err);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err?.stack || err);
});

/**
 * 会话写操作互斥：sync-all / dedupe / move 都是「关应用 → 改库 → 重启」的重操作，
 * 并发跑会重复备份、撞 SQLite 写锁、重复重启 WorkBuddy。执行中再收到写请求直接 409
 * （排队等一小时不如让用户稍后再点）；dryRun 只读、随时可跑，不占锁。
 */
let sessionOpBusy = false;
async function withSessionOpLock(fn) {
  if (sessionOpBusy) {
    throw Object.assign(new Error('已有会话整理操作在执行中（同步 / 去重 / 搬家），请等它完成后再操作'), { status: 409 });
  }
  sessionOpBusy = true;
  try {
    return await fn();
  } finally {
    sessionOpBusy = false;
  }
}

const platformFromReq = (req) => {
  const id = String(req.query.platform || req.body?.platform || 'openrouter');
  return getProvider(id);
};



/* ---------------- 飞牛统一网关（可选） ---------------- *
 * 飞牛把桌面入口请求带前缀转发到本机服务，这里剥掉前缀，两种转发形态都兼容。 */
const CGI_PREFIX = '/cgi/ThirdParty/wbconsole/index.cgi';
app.use((req, res, next) => {
  if (req.url.startsWith(CGI_PREFIX)) req.url = req.url.slice(CGI_PREFIX.length) || '/';
  next();
});

/* ---------------- fnOS 版 stub ---------------- *
 * 本机进程管理（退出/重启 WorkBuddy）与 Token 统计预取在 fnOS 上不存在，
 * 这里保留同名符号，避免摘除路由后残留的死代码报错。 */

/* ---------------- 健康检查（前端用于探测本地服务是否在线） ---------------- */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    pid: process.pid,
    uptime: Math.round(process.uptime()),
    now: Date.now(),
    // 本机版本号：界面不再硬编码，统一从这里取
    version: LOCAL_VERSION,
    // 运行在 Electron 桌面壳里时为 true：前端据此调整「服务断开」的恢复指引
    desktop: process.env.WB_DESKTOP === '1',
  });
});

/* ---------------- 平台与模型 ---------------- */

app.get('/api/platforms', (req, res) => {
  const cfg = loadConfig();
  // 置灰只是"默认不建议"，不是"不允许"：设置里勾了「显示全部平台」就照常可选，
  // 但把原始限制原因单独作为 restriction 传下去，让界面能常驻风险提示。
  const unlockAll = !!cfg.settings.unlockAllPlatforms;
  const platforms = listPlatforms().map((p) => ({
    ...p,
    restriction: p.uiDisabled || null,
    uiDisabled: unlockAll ? null : p.uiDisabled || null,
    keyCount: cfg.keys.filter((k) => k.platform === p.id).length,
    modelCount: providers[p.id].peek?.()?.count ?? null,
  }));
  res.json({ platforms, unlockAll });
});

app.get(
  '/api/models',
  wrap(async (req, res) => {
    const provider = platformFromReq(req);
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const key = activeKeyFor(loadConfig(), provider.id);
    const data = await provider.getModels({ refresh, apiKey: key?.key || undefined, baseUrl: key?.baseUrl || undefined });
    res.json({ ...data, platform: provider.id, platformName: provider.name, note: provider.note, tutorialUrl: provider.tutorialUrl || null });
  })
);

/* ---------------- 额度（按平台聚合，只查已配置 key 的平台） ---------------- */

app.get(
  '/api/quota',
  wrap(async (req, res) => {
    const cfg = loadConfig();
    const groups = [];
    for (const pid of PLATFORM_ORDER) {
      const provider = providers[pid];
      const keys = cfg.keys.filter((k) => k.platform === pid);
      if (!keys.length) continue;
      const list = await Promise.all(
        keys.map(async (k) => {
          const base = { keyId: k.id, platform: pid, label: k.label || maskKey(k.key), masked: maskKey(k.key) };
          // 无额度接口的平台不发起任何网络请求，仅展示本地保存的 key 状态
          if (!provider.fetchQuotaForKey) {
            const st = k.lastStatus;
            return { ...base, status: st === 'ok' || st === 'invalid' ? st : 'unknown', note: '该平台未提供额度查询接口' };
          }
          try {
            const q = await provider.fetchQuotaForKey(k.key);
            if (!q.ok) return { ...base, status: 'invalid', error: 'Key 无效或已撤销' };
            if (q.unavailable) return { ...base, status: 'ok', unavailable: q.unavailable };
            if (provider.quotaKind === 'balance') {
              return { ...base, status: 'ok', balance: q.balance || null };
            }
            const { key: info, credits } = q;
            return {
              ...base,
              status: 'ok',
              freeModelDailyRequests: info.free_model_daily_requests || null,
              usage: info.usage ?? null,
              usageDaily: info.usage_daily ?? null,
              usageWeekly: info.usage_weekly ?? null,
              usageMonthly: info.usage_monthly ?? null,
              limit: info.limit ?? null,
              limitRemaining: info.limit_remaining ?? null,
              isFreeTier: !!info.is_free_tier,
              expiresAt: info.expires_at || null,
              credits: credits ? { total: credits.total_credits ?? null, used: credits.total_usage ?? null } : null,
            };
          } catch (err) {
            return { ...base, status: 'error', error: err?.message || '查询失败' };
          }
        })
      );
      groups.push({
        platform: pid,
        platformName: provider.name,
        quotaKind: provider.quotaKind,
        note: provider.note,
        tutorialUrl: provider.tutorialUrl || null,
        keys: list,
      });
    }
    res.json({ fetchedAt: Date.now(), activeKeys: cfg.activeKeys || {}, platforms: groups });
  })
);

/* ---------------- Keys 管理（按平台） ---------------- */

app.get('/api/keys', (req, res) => {
  const cfg = loadConfig();
  res.json({
    activeKeys: cfg.activeKeys || {},
    activeKeyId: cfg.activeKeyId,
    keys: cfg.keys.map((k) => ({
      id: k.id,
      platform: k.platform,
      label: k.label || maskKey(k.key),
      masked: maskKey(k.key),
      addedAt: k.addedAt,
      lastStatus: k.lastStatus || null,
      baseUrl: k.baseUrl || null,
    })),
    configFile: CONFIG_FILE,
  });
});

/** 清洗用户粘贴的 Key：去零宽字符、所有空白字符、首尾包裹引号（网页复制的常见污染） */
function cleanKey(raw) {
  return String(raw || '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '') // 零宽字符与方向控制符
    .replace(/\s+/g, '') // 空格 / 换行 / 制表符等
    .replace(/^["'`]+|["'`]+$/g, ''); // 首尾引号
}

app.post(
  '/api/keys',
  wrap(async (req, res) => {
    const key = cleanKey(req.body?.key);
    const label = String(req.body?.label || '').trim();
    const provider = getProvider(String(req.body?.platform || 'openrouter'));
    if (provider.keyFormat && !provider.keyFormat.test(key)) {
      const head = key.slice(0, 6);
      return res.status(400).json({
        error:
          `Key 格式不符合 ${provider.name} 的要求（应以 ${provider.keyPlaceholder || '正确前缀'} 开头）。` +
          `检测到粘贴内容以 "${head || '空'}" 开头、共 ${key.length} 个字符，` +
          '请确认复制的是 API Key 本身（不是页面上的其他文本），重新复制后重试',
      });
    }
    const cfg = loadConfig();
    if (cfg.keys.some((k) => k.platform === provider.id && k.key === key)) {
      return res.status(400).json({ error: '这个 Key 已经添加过了' });
    }
    // 先验真伪再入库
    const t = await provider.testKey(key);
    if (!t.ok) {
      const why = t.invalid ? t.error || '平台返回未授权（401），Key 已失效或账户未开通该服务' : t.error || '校验失败';
      return res.status(400).json({ error: `Key 无效：${why}` });
    }
    const item = {
      id: newId('key'),
      platform: provider.id,
      key,
      label: label || t.label || `${provider.name} ${maskKey(key)}`,
      addedAt: Date.now(),
      lastStatus: 'ok',
      // 多节点平台（如 Agnes 双站）：记录该 key 实际鉴权通过的节点，
      // 之后拉模型、载入 WorkBuddy 都走这个节点（key 与签发站点绑定，跨站必 401）
      baseUrl: t.baseUrl || null,
    };
    cfg.keys.push(item);
    cfg.activeKeys = { ...(cfg.activeKeys || {}) };
    if (!cfg.activeKeys[provider.id]) cfg.activeKeys[provider.id] = item.id;
    if (provider.id === 'openrouter') cfg.activeKeyId = item.id;
    // 异步落盘：写盘重试最坏 36 秒，同步版会冻住整个服务 → 前端 25 秒默认超时误报失败
    await saveConfigAsync(cfg);
    res.json({ id: item.id, platform: provider.id, label: item.label, masked: maskKey(key), isFreeTier: t.isFreeTier, warn: t.warn || null });
  })
);

app.delete('/api/keys/:id', async (req, res) => {
  const cfg = loadConfig();
  const target = cfg.keys.find((k) => k.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'Key 不存在' });
  cfg.keys = cfg.keys.filter((k) => k.id !== req.params.id);
  if ((cfg.activeKeys || {})[target.platform] === req.params.id) {
    cfg.activeKeys[target.platform] = cfg.keys.find((k) => k.platform === target.platform)?.id || null;
  }
  if (cfg.activeKeyId === req.params.id) cfg.activeKeyId = cfg.keys.find((k) => k.platform === 'openrouter')?.id || null;
  try {
    await saveConfigAsync(cfg);
  } catch (err) {
    return res.status(500).json({ error: `删除失败：${err?.message || err}` });
  }
  res.json({ ok: true });
});

app.post('/api/keys/:id/activate', async (req, res) => {
  const cfg = loadConfig();
  const target = cfg.keys.find((k) => k.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'Key 不存在' });
  cfg.activeKeys = { ...(cfg.activeKeys || {}), [target.platform]: target.id };
  if (target.platform === 'openrouter') cfg.activeKeyId = target.id;
  try {
    await saveConfigAsync(cfg);
  } catch (err) {
    return res.status(500).json({ error: `切换失败：${err?.message || err}` });
  }
  res.json({ ok: true });
});

app.post(
  '/api/keys/:id/test',
  wrap(async (req, res) => {
    const cfg = loadConfig();
    const k = cfg.keys.find((x) => x.id === req.params.id);
    if (!k) return res.status(404).json({ error: 'Key 不存在' });
    try {
      const t = await getProvider(k.platform).testKey(k.key);
      k.lastStatus = t.ok ? 'ok' : 'invalid';
      // 多节点平台：key 可能被删后换站点重建，重测时同步纠正生效节点
      k.baseUrl = t.baseUrl || null;
      // 探测结果只是元数据：落盘失败不该让「测试通过」变成 502，故单独兜住
      await saveConfigAsync(cfg).catch(() => {});
      res.json(
        t.ok
          ? { ok: true, isFreeTier: t.isFreeTier, baseUrl: t.baseUrl || null, warn: t.warn || null }
          : { ok: false, error: t.error || 'Key 无效' },
      );
    } catch (err) {
      res.status(502).json({ ok: false, error: err?.message || '测试失败' });
    }
  })
);

/* ---------------- WorkBuddy ---------------- */

/* ---------------- 导出配置（拷给其他 agent 用：不写文件，只读生成条目） ---------------- */

/**
 * 与 /api/workbuddy/load 的区别：这一步**不改任何文件**，只把"如果要配这些模型，
 * 该填什么"算出来给界面展示与复制。
 * API Key 默认只回脱敏尾巴；界面上点「显示」时才带 reveal=1 取明文（本机工具，用户自己的 Key）。
 */
app.post(
  '/api/export/entries',
  wrap(async (req, res) => {
    const modelIds = Array.isArray(req.body?.modelIds) ? req.body.modelIds.filter(Boolean) : [];
    const provider = platformFromReq(req);
    const reveal = req.query.reveal === '1' || req.body?.reveal === true;
    if (!modelIds.length) return res.status(400).json({ error: '请先选择要导出的模型' });

    const cfg = loadConfig();
    const keyId = req.body?.keyId || null;
    const target =
      cfg.keys.find((k) => k.platform === provider.id && k.id === keyId) || activeKeyFor(cfg, provider.id);
    if (!target) {
      return res.status(400).json({ error: `尚未配置 ${provider.name} API Key，请先到「免费模型广场 → API Keys」添加` });
    }

    const cached = provider.peek?.();
    if (!cached?.models?.length) {
      return res.status(409).json({ error: `${provider.name} 模型列表尚未加载，请先在模型广场打开一次该平台` });
    }
    const index = new Map(cached.models.map((m) => [m.id, m]));

    const entries = [];
    const skipped = [];
    for (const id of modelIds) {
      const m = index.get(id);
      if (!m) {
        skipped.push({ id, reason: '模型列表中未找到' });
        continue;
      }
      const entry = provider.buildEntry(m, target.key, target.baseUrl);
      entries.push({
        ...entry,
        // 未点「显示」时不带明文，避免 Key 被无意复制到剪贴板
        apiKey: reveal ? entry.apiKey : null,
        outputKind: m.outputKind || 'text',
      });
    }
    if (!entries.length) return res.status(400).json({ error: '没有可导出的模型', skipped });

    res.json({
      platform: provider.id,
      platformName: provider.name,
      baseUrl: provider.baseUrl || null,
      protocol: 'openai-compatible',
      chatPath: '/chat/completions',
      masked: maskKey(target.key),
      apiKey: reveal ? target.key : null,
      entries,
      skipped,
    });
  })
);

/* ---------------- 自动化巡检状态（fnOS 版新增，便于确认自动化确实在跑） ---------------- */
app.get(
  '/api/patrol/status',
  wrap(async (req, res) => {
    const cfg = loadConfig();
    res.json({
      autoRefreshToken: !!cfg.settings.autoRefreshToken,
      autoCheckin: !!cfg.settings.autoCheckin,
      refreshIntervalMs: TOKEN_REFRESH_PATROL_MS,
      checkinIntervalMs: CHECKIN_PATROL_MS,
      lastRefreshAt: PATROL_STATE.refreshAt || null,
      lastCheckinAt: PATROL_STATE.checkinAt || null,
      accounts: loadAccounts().length,
      cnAccounts: loadAccounts().filter((a) => (a?.variant || 'cn') !== 'ai').length,
    });
  })
);

/* ---------------- 每日签到（仅国内版账号） ---------------- */

/** 各账号的签到状态（只读查询，不写任何东西） */
app.get(
  '/api/workbuddy/checkin/status',
  wrap(async (req, res) => {
    const accounts = loadAccounts().filter((a) => (a?.variant || 'cn') !== 'ai');
    const states = [];
    for (const account of accounts) {
      try {
        const state = await fetchCheckinStatus(account);
        states.push({ account: accountMeta(account), ...state });
      } catch (e) {
        states.push({ account: accountMeta(account), ok: false, todayCheckedIn: false, error: e?.message || '查询失败' });
      }
    }
    res.json({ states, logs: loadCheckinLogs().slice(-20).reverse() });
  })
);

/** 手动签到：带 accountId 签单个，不带则全部 */
app.post(
  '/api/workbuddy/checkin',
  wrap(async (req, res) => {
    const accountId = String(req.body?.accountId || '');
    if (accountId) {
      res.json(await checkinAccount(accountId));
    } else {
      res.json(await checkinAll({ onlyPending: req.body?.onlyPending !== false }));
    }
  })
);

/* ---------------- 登录态与目录权限自检 ---------------- */

/* ---------------- 登录态备份管理 ---------------- */

/* ---------------- Token 统计 ---------------- */

/* ---------------- 账号管理 ---------------- */

/**
 * 账号库 + 当前登录态。
 * accountsFile 指向 ~/.wb-switch/accounts.json（与 workbuddy-switch 共享同一份数据，
 * 两个工具互不干扰地读写，不会互相覆盖）。
 */
app.get('/api/accounts', (req, res) => {
  const accounts = loadAccounts();
  const current = detectCurrentAccount();
  // 附上最近一次验活结论：界面据此把「凭据有效」改成「服务端确认有效 / 已失效」，
  // 而不是只看本地有效期（2026-10-18 反馈：显示有效、切过去却登录过期）
  const verified = loadCredentialStatus();
  res.json({
    accounts: accounts.map((a) => ({ ...accountMeta(a), verify: verified[a.id] || null })),
    current: {
      variant: current.variant,
      uid: current.uid,
      exists: current.exists,
      account: current.account,
      warning: current.warning || null,
    },
    // fnOS 版：不再返回本机登录态文件路径与数据根目录（两者在 fnOS 上都不存在）
    variants: VARIANT_LIST.map((v) => ({ id: v.id, label: v.label })),
  });
});

/**
 * 切换账号：写登录态文件（内部先备份、失败回滚）。
 *
 * 两个可选动作，都由界面显式传入：
 * - `stopApp`：切换前**直接结束 WorkBuddy 的全部相关进程**（用户不必手动退出）。
 *   运行中的实例会把登录态改写回原账号，所以不关掉的话切换本来就无效；
 *   关进程后还会**重新打开** WorkBuddy，让用户拿到一个已登录新账号的客户端。
 * - `copySessionIds`：切换前把**当前登录账号**的这些会话复制给目标账号。
 *   顺序不能反——来源账号是「当前登录账号」，登录态一旦被改写就再也读不出源账号是谁。
 */
/**
 * 退出 WorkBuddy（结束后台全部相关进程）。供界面上的「退出 WorkBuddy」按钮直接调用。
 * 返回 `{ stopped, wasRunning, killed, forced, exePath }`。
 */
/** 导入本机当前登录中的账号到账号库 */
/**
 * OAuth 扫码登录：向官方申请 state，返回验证链接（前端渲染二维码）。
 * 轮询 /api/oauth/status 等待用户扫码，成功后自动采集入库。
 */
app.post(
  '/api/oauth/start',
  wrap(async (req, res) => {
    const variant = String(req.body?.variant || 'cn');
    res.json(await oauthStart(variant));
  })
);

/** 轮询扫码登录结果（loginId 由 /api/oauth/start 返回） */
app.post(
  '/api/oauth/status',
  wrap(async (req, res) => {
    const loginId = String(req.body?.loginId || '');
    if (!loginId) return res.status(400).json({ error: '缺少 loginId' });
    res.json(await oauthPoll(loginId));
  })
);

/** 删除账号（当前登录中的账号会被拒绝） */
app.delete('/api/accounts/:id', (req, res) => {
  try {
    res.json(deleteAccount(String(req.params.id)));
  } catch (err) {
    res.status(400).json({ error: err?.message || '删除失败' });
  }
});

/** 修改账号本地备注 / 展示名来源 */
app.patch(
  '/api/accounts/:id',
  wrap(async (req, res) => {
    try {
      res.json(updateAccountDisplay(String(req.params.id), req.body || {}));
    } catch (err) {
      res.status(400).json({ error: err?.message || '保存失败' });
    }
  })
);

/* ---------------- 会话（对话记录）复制 ---------------- */

/**
 * 列出「当前登录账号 → 目标账号」可复制的会话。
 * 只读：不写任何文件、不改数据库；供账号页的会话选择弹窗渲染。
 */
/**
 * 把选中的会话复制给目标账号（副本用新 UUID，源账号数据不受影响）。
 *
 * `stopApp: true` 时由本工具先结束 WorkBuddy 的进程再复制，并在结束后重新打开它。
 * 进程生命周期放在这一层而不是 `copySessions` 里，是因为只有这里能保证
 * "无论复制成功还是失败都把用户的 WorkBuddy 重新打开"。
 * `copySessions` 内部仍会自查 App 是否已退出（写库前的最后一道门）。
 */
/**
 * 定位「汇总后自动整理」脚本。两套布局都要支持：
 *   1) 源码/开发运行：项目根目录（server/ 的上一级）
 *   2) 桌面安装版：electron-builder 的 extraResources 复制到 resources/cleanup/
 *      （asar 内的文件无法被 spawn 执行，所以必须解到真实磁盘上）
 */
function resolveCleanScript() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, '../汇总后自动整理.mjs')];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'cleanup', '汇总后自动整理.mjs'));
  }
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* 忽略单个候选的探测失败，继续下一个 */
    }
  }
  return null;
}

function kickOffStorageClean(reason = 'after-sync') {
  try {
    const script = resolveCleanScript();
    if (!script) return;
    const child = spawn(process.execPath, [script], { detached: true, stdio: 'ignore', cwd: path.dirname(script) });
    child.unref();
    console.log(`[storage-clean] 已触发（${reason}）→ ${script}`);
  } catch (e) {
    console.log('[storage-clean] 触发失败: ' + (e?.message || e));
  }
}

/**
 * 服务日志尾部（服务是隐藏启动的，用户看不到控制台输出，排查全靠这个）
 * GET /api/diag/tail?n=80
 */
/**
 * 一键同步所有本机账号：内容并集取最新 + 改名跟随，已有副本原位合并、绝不重复复制。
 * fillMissing=true 时把「目标账号里从来没有」的会话也补全复制过去（全量对齐，占磁盘）。
 * stopApp=true 时由服务端先结束 WorkBuddy（写库门禁要求），完成后再重新打开。
 */
/**
 * 搬家式转移：把当前账号的会话「过户」给目标账号——不复制、磁盘零增长。
 * 目标账号已有同一对话时先合并内容（取全）再移走源正文；需要 WorkBuddy 已退出。
 */
/**
 * 一键去重：同账号内同一家族的多余副本，合并进最完整的一份后软删除多余者；
 * 复制账本同步改写，此后同步永远原位合并、不再产生重复。dryRun=预演不写入。
 * 写库需要 WorkBuddy 冻结：stopApp=true 时先冻结、完成后再结束（崩溃恢复自动
 * 拉起新实例，登录态不变，等同于「重启了一次 WorkBuddy」）。
 */
/* ---------------- 积分统计 ---------------- */

/**
 * 只查积分余额（含积分包明细），供账号页卡片渲染。
 * 不扫用量明细，比 /api/credits 快得多；进程内缓存 2 分钟。
 */
/**
 * 每个账号「今日是否已签到 / 是否已旅行」——账号卡片上的两个状态小标。
 * 只查询官方状态接口，不执行任何签到/旅行动作；结果缓存 5 分钟。
 */
let dailyStatusCache = { at: 0, data: null };
app.get(
  '/api/accounts/daily-status',
  wrap(async (req, res) => {
    const force = req.query?.refresh === '1';
    // 缓存 10 分钟：这是纯展示用的状态小标，没必要 5 分钟一刷官方接口
    if (!force && dailyStatusCache.data && Date.now() - dailyStatusCache.at < 10 * 60 * 1000) {
      res.json(dailyStatusCache.data);
      return;
    }
    const list = loadAccounts().filter((a) => a?.uid && hasPlainToken(a));
    // 防风控：原来 N 账号 × 2 接口全部 Promise.all 并发（同 IP 一波 6+ 请求，典型批量指纹），
    // 改成逐账号串行、账号间隔 400ms；接口总数少（2/账号），串行代价可接受
    const entries = [];
    for (const a of list) {
      if (entries.length > 0) await new Promise((r) => setTimeout(r, 400));
      const c = await fetchCheckinStatus(a).catch(() => null);
      const tr = await fetchTravelStatus(a).catch(() => null);
      entries.push([
        String(a.id || a.uid),
        {
          checkedIn: !!c?.todayCheckedIn,
          traveled: !!tr?.traveled,
          travelState: tr?.state || null,
          travelDailyLimit: !!tr?.dailyLimit,
          travelReward: Number(tr?.reward || 0),
          checkinError: c && c.ok === false ? String(c.error || '查询失败') : null,
          travelError: tr && tr.ok === false ? String(tr.error || '查询失败') : null,
        },
      ]);
    }
    const data = { accounts: Object.fromEntries(entries), at: Date.now() };
    dailyStatusCache = { at: Date.now(), data };
    res.json(data);
  })
);

/**
 * 每个账号「当前额度超限的模型」+ 恢复时间。
 * 数据源：该账号最近会话日志里的官方 429 报错（含「将在 xxx 重置」）。
 * 只返回「恢复时间还在未来」的记录；结果缓存 3 分钟。
 */
/**
 * 每个账号「当前额度超限的模型」+ 恢复时间。
 * 数据源：**当场探测** —— 用该账号的登录态对「它最近用过的模型」发一次 max_tokens=1 的请求，
 * 上游回 429 且带重置时间才算超限（见 workbuddy/modelLimits.mjs）。结果缓存 10 分钟。
 */

app.get(
  '/api/accounts/credits',
  wrap(async (req, res) => {
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    res.json(await getAccountBalances({ refresh }));
  })
);

/**
 * 单账号的逐笔积分明细（官方客户端「积分明细」弹窗的数据源）。
 * 进程内缓存 5 分钟；?refresh=1 强制重打官方接口。
 */
app.get(
  '/api/accounts/credit-details',
  wrap(async (req, res) => {
    const id = String(req.query.id || '').trim();
    if (!id) throw Object.assign(new Error('缺少账号 id'), { status: 400 });
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    res.json(await getCreditDetails({ accountId: id, refresh }));
  })
);

/** 官方逐请求用量投影（按日 / 按模型 / 按账号聚合） */
app.get(
  '/api/credits',
  wrap(async (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const variant = ['cn', 'ai'].includes(String(req.query.variant)) ? String(req.query.variant) : 'all';
    res.json(await getCreditStatistics({ days, refresh, variant }));
    // 后台把另外两个区间也算好，用户切 7/30/90 时直接命中缓存
    prefetchCreditRanges({ variant, days });
  })
);

/** 本地快照离线投影（官方接口不可用时的兜底） */
app.get('/api/credits/offline', (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
  res.json(getOfflineCreditProjection({ days }));
});

/* ---------------- 设置 ---------------- */

function readCacheInfos() {
  return listPlatforms()
    .map((p) => {
      try {
        const raw = JSON.parse(fs.readFileSync(modelsCacheFile(p.id), 'utf8'));
        if (Array.isArray(raw?.models) && raw.models.length) {
          return { platform: p.id, platformName: p.name, fetchedAt: raw.fetchedAt, count: raw.count };
        }
      } catch {
        /* 无缓存 */
      }
      return null;
    })
    .filter(Boolean);
}

app.get(
  '/api/settings',
  wrap(async (req, res) => {
    const cfg = loadConfig();
    res.json({
      workbuddyDir: cfg.settings.workbuddyDir || '',
      proxyUrl: cfg.settings.proxyUrl || '',
      autoCheckin: !!cfg.settings.autoCheckin,
      autoRefreshToken: !!cfg.settings.autoRefreshToken,
      autoCheckUpdate: !!cfg.settings.autoCheckUpdate,
      unlockAllPlatforms: !!cfg.settings.unlockAllPlatforms,
      effectiveProxy: await getProxyUrl(),
      // fnOS 版：本机 WorkBuddy 数据目录探测已摘除
      detected: { dir: null, source: "none", sourceLabel: "fnOS 版不探测", valid: false },
      cacheDir: cachePath(''),
      modelsCaches: readCacheInfos(),
    });
  })
);

app.put(
  '/api/settings',
  wrap(async (req, res) => {
    const cfg = loadConfig();
    if (typeof req.body?.workbuddyDir === 'string') {
      cfg.settings.workbuddyDir = req.body.workbuddyDir.trim();
    }
    if (typeof req.body?.proxyUrl === 'string') {
      cfg.settings.proxyUrl = req.body.proxyUrl.trim();
    }
    if (typeof req.body?.autoCheckin === 'boolean') {
      cfg.settings.autoCheckin = req.body.autoCheckin;
    }
    if (typeof req.body?.autoRefreshToken === 'boolean') {
      cfg.settings.autoRefreshToken = req.body.autoRefreshToken;
    }
    if (typeof req.body?.autoCheckUpdate === 'boolean') {
      cfg.settings.autoCheckUpdate = req.body.autoCheckUpdate;
    }
    if (typeof req.body?.unlockAllPlatforms === 'boolean') {
      cfg.settings.unlockAllPlatforms = req.body.unlockAllPlatforms;
    }
    // 设置页每次切换开关都会走这里：必须异步落盘，否则写盘卡顿期间整个界面都超时
    const saveMs = await saveConfigAsync(cfg);
    if (saveMs > 2000) console.log(`[settings] 保存设置耗时 ${saveMs}ms`);
    res.json({
      ok: true,
      workbuddyDir: cfg.settings.workbuddyDir,
      proxyUrl: cfg.settings.proxyUrl,
      autoCheckin: !!cfg.settings.autoCheckin,
      autoRefreshToken: !!cfg.settings.autoRefreshToken,
      autoCheckUpdate: !!cfg.settings.autoCheckUpdate,
      unlockAllPlatforms: !!cfg.settings.unlockAllPlatforms,
      effectiveProxy: await getProxyUrl(),
      // fnOS 版：本机 WorkBuddy 数据目录探测已摘除
      detected: { dir: null, source: "none", sourceLabel: "fnOS 版不探测", valid: false },
    });
  })
);

// 重新自动检测 WorkBuddy 数据目录（并附带运行状态）
app.post('/api/cache/clear', (req, res) => {
  clearModelsCache(String(req.body?.platform || '')); // 空字符串 = 清全部平台
  res.json({ ok: true });
});

/* ---------------- 版本自检 ---------------- */

app.get(
  '/api/app/update',
  wrap(async (req, res) => {
    const cfg = loadConfig();
    // 关掉自动检查时不发起任何出站请求，前端据此只显示版本号、不显示升级按钮
    if (!cfg.settings.autoCheckUpdate) {
      res.json({
        ok: true,
        disabled: true,
        current: LOCAL_VERSION,
        latest: null,
        hasUpdate: false,
        releaseUrl: null,
        downloadUrl: null,
        assetName: null,
        hotupdateUrl: null,
        hotupdateName: null,
        canHotUpdate: false,
        publishedAt: null,
        notes: '',
        checkedAt: null,
        cached: false,
        error: null,
      });
      return;
    }
    res.json(await checkForUpdate({ force: false }));
  })
);

// 手动「检查更新」是一次明确的授权动作，即使关掉了自动检查也照做
app.post(
  '/api/app/update/check',
  wrap(async (req, res) => {
    res.json(await checkForUpdate({ force: true }));
  })
);

/* ---------------- 一键热更新（飞牛 fnOS） ---------------- */

/**
 * 点一下就把新版本拉下来就地换掉并重启：不需要去 GitHub 下载 .fpk，也不需要到应用中心卸载重装。
 * 实现与回滚策略见 server/hotupdate.mjs 的头注释。
 */
app.post(
  '/api/app/update/apply',
  wrap(async (req, res) => {
    const force = req.body?.force === true || req.body?.force === '1';
    res.json(await applyHotUpdate({ force }));
  })
);

/** 重启后界面回来问一句：上次更新结果是什么（成功/失败原因） */
app.get('/api/app/update/state', (_req, res) => {
  res.json(readUpdateState() || { ok: false, message: '没有更新记录' });
});

/* ---------------- 凭据自动刷新（巡检 + 接口） ---------------- */

/** 巡检间隔：6 小时。判据本身是"临期才动手"，这里只负责定期来看一眼 */
const TOKEN_REFRESH_PATROL_MS = 6 * 60 * 60 * 1000;
let tokenRefreshBusy = false;
let tokenRefreshTimer = null;

app.get(
  '/api/accounts/refresh',
  wrap(async (req, res) => {
    const cfg = loadConfig();
    res.json({
      autoRefreshToken: !!cfg.settings.autoRefreshToken,
      intervalHours: TOKEN_REFRESH_PATROL_MS / 3_600_000,
      accessMinHours: ACCESS_MIN_HOURS,
      refreshMinHours: REFRESH_MIN_HOURS,
      accounts: refreshPlan(),
      lastRun: lastRefreshRun(),
      logs: loadRefreshLogs().slice(0, 30),
    });
  })
);

// 手动刷新：不传 accountId 就处理全部账号；force 跳过临期判定（用户明确要求刷）
app.post(
  '/api/accounts/refresh',
  wrap(async (req, res) => {
    const accountId = req.body?.accountId ? String(req.body.accountId) : '';
    const force = req.body?.force === true || req.body?.force === '1';
    const { results, summary } = await refreshAccounts({
      accountIds: accountId ? [accountId] : null,
      force,
    });
    res.json({ ok: true, results, summary });
  })
);

/**
 * 巡检防风控：账号间隔。官方对「短窗口内多账号同 IP 操作」会判定批量营销号踢下线
 * （2026-10-23 用户实测凭据被批量失效），巡检类自动化一律顺序执行、账号间隔分钟级；
 * 手动单账号操作不受影响。跳过类账号（无调用）不占间隔。
 */
const PATROL_ACCOUNT_STAGGER_MS = 3 * 60_000;

const PATROL_STATE = { refreshAt: 0, checkinAt: 0 };

async function runTokenRefreshPatrol({ silent = false } = {}) {
  if (tokenRefreshBusy) return null;
  PATROL_STATE.refreshAt = Date.now();
  if (!loadConfig().settings.autoRefreshToken) return null;
  tokenRefreshBusy = true;
  try {
    const { results, summary } = await refreshAccounts({ delayMs: PATROL_ACCOUNT_STAGGER_MS });
    // 平时（没有临期账号）完全静默：这类巡检不该在日志里刷存在感
    if (summary.refreshed || summary.failed || (!silent && summary.dead)) {
      console.log(
        `[refresh] 凭据巡检：验活有效 ${summary.verified ?? 0}、刷新 ${summary.refreshed}、跳过 ${summary.skipped}、失败 ${summary.failed}、需重新登录 ${summary.dead}` +
          ((summary.invalid ?? 0) > 0 ? `（其中 ${summary.invalid} 个被服务端判定失效）` : '')
      );
      for (const r of results.filter((x) => x.action === 'failed')) {
        console.error(`[refresh] 「${r.accountName}」刷新失败：${r.message}`);
      }
    }
    return summary;
  } catch (e) {
    console.error('[refresh] 凭据巡检出错:', e?.message || e);
    return null;
  } finally {
    tokenRefreshBusy = false;
  }
}

/** 启动巡检：先延迟 60 秒（不与启动时的其它初始化抢网络），之后每 6 小时一次 */
function startTokenRefreshPatrol() {
  if (tokenRefreshTimer) clearInterval(tokenRefreshTimer);
  setTimeout(() => runTokenRefreshPatrol({ silent: true }), 60_000);
  tokenRefreshTimer = setInterval(runTokenRefreshPatrol, TOKEN_REFRESH_PATROL_MS);
  console.log(`[refresh] 凭据自动刷新已启用：启动 60 秒后首检，之后每 ${TOKEN_REFRESH_PATROL_MS / 3600_000} 小时一次`);
}

startTokenRefreshPatrol();

/* ---------------- 版本定时自检 ---------------- */

/**
 * 版本定时自检：每小时**主动**刷新一次远端版本信息（force，不吃 6 小时缓存）。
 *
 * 早先只有界面挂载时才查一次，控制台常年驻留后台的用户永远等不到升级按钮——
 * 只有下次重启才看得见新版本（2026-10-18 用户反馈）。现在由服务端定时刷新缓存，
 * 界面侧再定时取一次缓存结果，升级按钮不重启也能出现。
 *
 * 限流：GitHub 未认证接口每小时 60 次，这里每小时 1 次，余量充足；
 * 关掉「自动检查更新」后整体不工作，也不发起任何出站请求。
 */
const UPDATE_PATROL_MS = 60 * 60 * 1000;
let updatePatrolBusy = false;
let updatePatrolTimer = null;

async function runUpdatePatrol() {
  if (updatePatrolBusy) return;
  if (!loadConfig().settings.autoCheckUpdate) return;
  updatePatrolBusy = true;
  try {
    const r = await checkForUpdate({ force: true });
    if (r?.ok && r.hasUpdate) {
      console.log(`[update] 发现新版本 v${r.latest}（当前 v${r.current}），升级按钮已就绪`);
    }
  } catch (e) {
    // 网络抖动/限流都算常态，不打扰用户
    console.error('[update] 定时检查出错:', e?.message || e);
  } finally {
    updatePatrolBusy = false;
  }
}

function startUpdatePatrol() {
  if (updatePatrolTimer) clearInterval(updatePatrolTimer);
  // 启动 1 分钟后先查一次（首屏自己也会查，这里让缓存尽快就位），之后每小时一次
  setTimeout(runUpdatePatrol, 60_000);
  updatePatrolTimer = setInterval(runUpdatePatrol, UPDATE_PATROL_MS);
}

startUpdatePatrol();

/* ---------------- 自动签到巡检 ---------------- */

/** 巡检间隔：每小时检查一次，跨天自然覆盖（签到本身幂等，重复调用无副作用） */
const CHECKIN_PATROL_MS = 60 * 60 * 1000;
let checkinPatrolBusy = false;
let checkinPatrolTimer = null;

async function runCheckinPatrol({ ignoreQuietHours = false } = {}) {
  if (checkinPatrolBusy) return;
  PATROL_STATE.checkinAt = Date.now();
  const cfg = loadConfig();
  if (!cfg.settings.autoCheckin) return;
  // 小时级巡检只在 06:00–23:00 之间进行，避免深夜反复打扰官方接口；
  // 启动触发的那一次（ignoreQuietHours）不受此限——用户要求启动即领，而不是等到固定时间
  const hour = new Date().getHours();
  if (!ignoreQuietHours && (hour < 6 || hour >= 23)) return;
  checkinPatrolBusy = true;
  try {
    // 两道门禁：签到 + 成长中心（签到早满了也不影响成长中心的旅行/任务/补登/兑换/盲盒）
    if ((await allCheckedInToday()) && allGrowthDoneToday()) return;
    // 签到同样防风控：单并发顺序执行，账号间间隔 3 分钟（手动批量签到不传，保持原并发）
    const { summary, results } = await checkinAll({
      onlyPending: true,
      skipGrowthIfDoneToday: true,
      staggerMs: PATROL_ACCOUNT_STAGGER_MS,
    });
    const failed = results.filter((r) => r.action === 'failed');
    console.log(
      `[checkin] 自动巡检完成：签到 ${summary.checked}、已签到 ${summary.already}、失败 ${summary.failed}` +
        (summary.growthCredits ? `、成长中心 +${summary.growthCredits} 积分` : '') +
        (failed.length ? `（${failed.map((f) => f.account?.name || f.account?.uid).join(', ')}）` : '')
    );
  } catch (e) {
    console.error('[checkin] 自动巡检出错:', e?.message || e);
  } finally {
    checkinPatrolBusy = false;
  }
}

/**
 * 启动巡检：先延迟 30 秒（等界面加载完），之后每小时一次。
 *
 * **每次启动必领一次**且不受夜间窗口限制（用户要求 2026-10-17）：
 * 早先那次启动巡检走 06:00–23:00 时间窗，深夜/凌晨启动会被直接跳过，
 * 积分要等到早上 6 点后的某次整点巡检才领到——变成"固定等时间"而不是"启动即领"。
 * 幂等门禁（今天已签到且成长任务已完成就直接返回）保证重复启动不会重复请求。
 */
function startCheckinPatrol() {
  if (checkinPatrolTimer) clearInterval(checkinPatrolTimer);
  setTimeout(() => runCheckinPatrol({ ignoreQuietHours: true }), 30_000);
  checkinPatrolTimer = setInterval(runCheckinPatrol, CHECKIN_PATROL_MS);
  console.log(`[checkin] 自动签到与成长中心已启用：启动 30 秒后首领，之后每 ${CHECKIN_PATROL_MS / 3600_000} 小时一次（06:00-23:00）`);
}

startCheckinPatrol();

// 反向代理已开启时，启动时预热一次模型缓存（失败不阻塞启动，页面可手动刷新）
if (loadConfig().proxy?.enabled) refreshModelsCache().catch(() => {});

/* ---------------- 反向代理（OpenAI 兼容，供其他 agent 调用） ---------------- */

// 必须挂在静态资源与 SPA 兜底之前，否则 /v1/* 会被 index.html 吃掉
registerProxyRoutes(app, { port: PORT });

/* ---------------- 静态资源 + SPA ---------------- */

/* ---------------- 前端入口：按访问前缀注入 <base> ---------------- *
 * 飞牛网关既可能给 /cgi/ThirdParty/wbconsole/index.cgi/（带尾斜杠）也可能不带，
 * 而前端资源用的是相对路径（./assets/*）。尾斜杠一变，相对路径就会解析错一层 →
 * 资源 404 → 白屏。这里按请求的真实前缀写死 <base>，两种形态都对。 */
app.get(['/', '/index.html'], (req, res, next) => {
  try {
    let html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
    // 仅在「网关保留前缀直接转发」时才注入 <base>。
    // 走 CGI 时前缀已被 bridge 剥掉，此时若注入 base="/" 反而会把 ./assets/* 钉到根 → 404 白屏。
    const base = req.originalUrl && req.originalUrl.startsWith(CGI_PREFIX) ? `${CGI_PREFIX}/` : null;
    if (base) {
      html = html.replace(/<head>/i, `<head>\n    <base href="${base}">`);
    }
    res.type('html').send(html);
  } catch {
    next();
  }
});

app.use(express.static(DIST));
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(DIST, 'index.html'));
});

const onListening = () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`workbuddy控制台已启动: ${url}`);
  // fnOS 版：服务器环境没有浏览器，默认不自动打开（桌面壳 WB_DESKTOP=1 或 OPEN_BROWSER=1 才开）
  if ((process.env.WB_DESKTOP === '1' || process.env.OPEN_BROWSER === '1') && process.env.NO_OPEN !== '1') {
    const cmd =
      process.platform === 'win32'
        ? spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' })
        : process.platform === 'darwin'
          ? spawn('open', [url], { detached: true, stdio: 'ignore' })
          : spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    cmd.unref();
  }
};

app.listen(PORT, process.env.WB_HOST || '0.0.0.0', onListening);

/*
 * 同时监听 IPv6 环回。
 *
 * 只绑 127.0.0.1 时，把 `localhost` 解析成 `::1` 的客户端（本机 ping localhost 就是
 * ::1）会连不上：实测 `http://[::1]:57891/...` 返回 HTTP 000。现象是「反向代理用不了」，
 * 而且**连一条请求日志都不会有** —— 请求根本没到进程里，最容易被误判成代理坏了。
 *
 * 两个地址都只在环回范围内，不增加对外暴露面。绑不上（机器禁用 IPv6）只提示、不影响 IPv4。
 */
if (process.env.NO_IPV6 !== '1') {
  const server6 = http.createServer(app);
  server6.on('error', (err) => {
    console.warn(`IPv6 环回监听失败（不影响 IPv4 访问）: ${err?.code || err?.message}`);
  });
  server6.listen(PORT, '::1');
}
