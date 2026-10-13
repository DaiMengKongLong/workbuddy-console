/**
 * 反向代理：把 WorkBuddy 的官方 chat 能力以 **OpenAI 兼容协议** 暴露给本机其他 agent。
 *
 * 其他 agent（Claude Code / Cherry Studio / 任意 OpenAI SDK）只要把
 *   base_url = http://127.0.0.1:<port>/v1 ，api_key = 本页生成的 Key
 * 就能直接消耗 WorkBuddy 账号的积分与模型额度。
 *
 * 设计取舍：
 * - **不另起端口**：复用控制台自身的 Express（默认 57891 / 桌面版动态端口），
 *   少一个监听端口、少一处防火墙与"端口被占"的故障面。
 * - **默认关闭**：会对外暴露一个本地 HTTP 接口，必须用户显式开启。
 * - **账号轮换**：按请求轮询账号池；401/403 先刷新 token 重试，仍失败再换下一个账号。
 * - **只透传必要字段**：OpenAI 入站 body 里的未知字段（如某些客户端的私货）不往上游带。
 */
import { Readable } from 'node:stream';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { loadConfig, saveConfig, DEFAULT_PROXY } from '../store/config.mjs';
import { loadAccounts, accountMeta, secretValue } from '../workbuddy/accounts.mjs';
import { variantOf, VARIANT_LIST, authFilePath } from '../workbuddy/variant.mjs';
import { chatComplete, refreshAccessToken, fetchUpstreamModels, openUpstreamStream } from './wb.mjs';
import { anthropicToOpenAi, buildAnthropicMessage, pipeAnthropicStream } from './anthropic.mjs';
import { responsesToOpenAi, buildResponsesReply, pipeResponsesStream } from './responses.mjs';
import { geminiToOpenAi, buildGeminiResponse, geminiModelsPayload, pipeGeminiStream } from './gemini.mjs';
import { sanitizeMessages } from './sanitize.mjs';

/** 允许透传给上游的字段白名单（其余一律丢弃，避免把客户端私货喂给官方接口） */
const ALLOWED_FIELDS = [
  'model',
  'messages',
  'stream',
  'temperature',
  'top_p',
  'max_tokens',
  'max_completion_tokens',
  'stop',
  'tools',
  'tool_choice',
  'response_format',
  'frequency_penalty',
  'presence_penalty',
  'seed',
  'user',
];

const LOG_LIMIT = 200;

/** 进程内状态：轮转下标、请求日志、累计统计、模型缓存 */
const state = {
  rr: 0,
  logs: [],
  stats: { total: 0, ok: 0, failed: 0, lastAt: null },
  models: { ids: [], fetchedAt: null, error: null, account: null },
};

function ensureKey() {
  const cfg = loadConfig();
  if (cfg.proxy?.apiKey) return cfg.proxy.apiKey;
  const key = `sk-wb-${crypto.randomBytes(16).toString('hex')}`;
  cfg.proxy = { ...DEFAULT_PROXY, ...cfg.proxy, apiKey: key };
  saveConfig(cfg);
  return key;
}

/** 出站可用的明文 access_token（空值或加密信封对象都不算） */
function plainAccessToken(account) {
  const t = secretValue(account, 'access_token');
  return typeof t === 'string' && t.trim() ? t : '';
}

/** 出站可用的明文 refresh_token */
function plainRefreshToken(account) {
  const t = secretValue(account, 'refresh_token');
  return typeof t === 'string' && t.trim() ? t : '';
}

/**
 * 账号能否用于出站请求：有明文 access_token，**或**有明文 refresh_token
 * （access_token 过期、甚至只存了加密信封，都能靠 refresh_token 换一份明文的回来）。
 *
 * ⚠️ 别用 `hasPlainToken` 当这个判据：它顺带把"已过期"也算成不可用，于是
 * 「控制台离线几天、access_token 正好过期」的账号会被**静默踢出账号池**——
 * 明明 refresh_token 还有效，界面却只回一句"没有可用账号"，把人往"重新扫码"上引。
 * 那个函数在签到 / 切换账号 / 界面徽章里仍按原语义使用（那里"过期=不可用"是对的）。
 */
export function canEgress(account) {
  return !!plainAccessToken(account) || !!plainRefreshToken(account);
}

/** 参与轮换的账号：能出站的（见 canEgress），再按界面选中的子集过滤 */
export function poolAccounts() {
  const cfg = loadConfig();
  const raw = cfg.proxy?.accountIds;
  // null / 非数组 = 未指定 → 全部可用账号；[] = 明确一个都不选 → 池为空
  const selected = Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : null;
  if (selected && selected.length === 0) return [];
  const loginUids = currentLoginUids();
  return loadAccounts().filter((a) => {
    if (!canEgress(a)) return false;
    // 桌面端当前登录的账号**绝不参与出站**（显式勾选了也不行，见 currentLoginUids 注释）
    if (a?.uid && loginUids.has(String(a.uid))) return false;
    return selected ? selected.includes(a.id) : true;
  });
}

/**
 * 桌面端当前登录的 uid 集合（两个档位的登录态文件都查，读不到的档位当未登录）。
 *
 * 为什么要把当前登录账号剔出账号池：上游 11128 渠道风控除了按单请求内容判，
 * **对账号也有连坐效应** —— 实测「代理带着账号 A 跑竞品系统提示词的流量」之后，
 * 官方客户端用同一个账号 A 发消息也开始被拦。账号池默认收全部能出站的账号，
 * 不加隔离就等于主动把官方客户端正登录的账号往风控枪口上送。
 * 这里从机制上把两边分开：官方客户端用 A，代理只用其余账号。
 */
export function currentLoginUids() {
  const uids = new Set();
  for (const v of VARIANT_LIST) {
    try {
      const uid = JSON.parse(fs.readFileSync(authFilePath(v.id), 'utf8'))?.account?.uid;
      if (typeof uid === 'string' && uid.trim()) uids.add(uid.trim());
    } catch {
      /* 没有登录态文件 / 解析失败 → 该档位当未登录 */
    }
  }
  return uids;
}

function log(entry) {
  state.logs.unshift(entry);
  if (state.logs.length > LOG_LIMIT) state.logs.length = LOG_LIMIT;
}

function summarizeLog() {
  state.stats.total += 1;
  state.stats.lastAt = Date.now();
}

/**
 * 账号是否需要先刷新：到期前 60 秒就刷（避免请求打到一半过期），
 * 另外**当前 token 出站根本用不了**（缺失 / 加密信封 / 已过期）时也必须先换明文。
 *
 * 注意"已过期"这里靠 `expiresAt - now < 0` 自然成立——**前提是账号还在池子里**
 * （见 canEgress 的注释：池子必须收下"过期但可刷新"的账号，否则这行永远轮不到它）。
 */
export function needsRefresh(account) {
  if (!plainAccessToken(account)) return true;
  const exp = Number(account?.expiresAt);
  return Number.isFinite(exp) && exp > 0 && exp - Date.now() < 60_000;
}

/** OpenAI 入站 body → 上游 body：白名单过滤 + system 文本净化（导出供协议测试直接断言） */
export function buildUpstreamBody(inbound) {
  const out = {};
  for (const k of ALLOWED_FIELDS) {
    if (inbound[k] !== undefined) out[k] = inbound[k];
  }
  if (!Array.isArray(out.messages) || !out.messages.length) throw new Error('缺少 messages');
  if (!out.model) throw new Error('缺少 model');
  // system 级文本出站前净化（竞品系统提示词逐字命中上游风控会被 11128 拦截）；
  // 用户消息不受影响。理由与实证见 sanitize.mjs。
  sanitizeMessages(out.messages);
  return out;
}

/**
 * 客户端把 Key 放在哪儿了：返回携带方式，认不出来返回 null。
 *
 * 四种携带方式对应不同客户端的默认行为：
 *   - `Authorization: Bearer`（OpenAI SDK / Codex CLI / 多数 IDE）
 *   - `Authorization: <key>`（少数脚本 / 手写客户端直接把 Key 塞进去，不带前缀）
 *   - `x-api-key`（Anthropic 客户端，Claude Code 用 Bearer，但 ZCode 等用这个）
 *   - `x-goog-api-key`（Gemini CLI / Gemini 原生 SDK 的默认机制）
 * 另外 Gemini 客户端在部分版本会把 Key 放在 `?key=` 查询串里，一并接受。
 *
 * 未配置 Key 时返回 `'none'`（本地工具，方便直接试）。
 *
 * 返回值同时进请求日志：排查「401 到底是没带、还是带错」时，一眼能看出客户端把
 * Key 放在了哪个头上 —— 这比让用户抓包快得多。
 */
export function authMode(req) {
  const key = loadConfig().proxy?.apiKey;
  if (!key) return 'none';
  const auth = String(req.headers.authorization || '').trim();
  if (auth.startsWith('Bearer ')) {
    if (auth.slice(7).trim() === key) return 'bearer';
  } else if (auth === key) {
    return 'raw';
  }
  if (String(req.headers['x-api-key'] || '').trim() === key) return 'x-api-key';
  if (String(req.headers['x-goog-api-key'] || '').trim() === key) return 'x-goog-api-key';
  if (String(req.query?.key || '').trim() === key) return 'query';
  return null;
}

/** 鉴权：见 authMode。认不出携带方式即为不通过。 */
function authorized(req) {
  return !!authMode(req);
}

/**
 * 日志用的人话鉴权标签 —— 把「没带 Key」和「带了但不对」分开。
 * 这两种在用户侧都表现为 401，但处理方式完全不同（前者去配 Key，后者去对 Key）。
 */
export function authLabel(req) {
  const mode = authMode(req);
  if (mode) return mode;
  const any = req.headers.authorization || req.headers['x-api-key'] || req.headers['x-goog-api-key'] || req.query?.key;
  return any ? 'mismatch' : 'absent';
}

/** 客户端标识（截断，只用于日志，不影响任何逻辑） */
const uaOf = (req) => String(req.headers['user-agent'] || '').slice(0, 120) || null;

/** 请求路径（去掉查询串；Gemini 的模型名在路径里，出问题时这行最有信息量） */
const pathOf = (req) => String(req.originalUrl || req.url || '').split('?')[0];

/**
 * 上游错误码 → 中文人话。
 * 只收实测碰到过的码；没登记的码回落到上游自己的 zh 文案。
 */
const UPSTREAM_CODE_HINT = {
  11102: '模型不可用（上游没有这个模型，请在「反向代理」页面挑清单里的模型）',
  11128: '上游渠道风控拦截：客户端的「系统提示词」被判定为非官方客户端',
};

/**
 * 把上游那一大坨 JSON 压成一行能读的话。
 *
 * 上游错误原文形如
 *   `账号名: HTTP 400: {"code":11128,"msg":"Illegal API invocation…","displayMsg":{"zh":"…"}`
 * 直接塞进界面（截 60 字）只会看到 `{"code":11128,"msg":"Illegal API invocation from an un…`，
 * 完全看不出该干什么。这里抽出 code 与中文提示，压成
 *   `账号名: 上游 11128：上游渠道风控拦截：客户端的「系统提示词」被判定为非官方客户端`
 */
export function briefUpstream(text) {
  const s = String(text ?? '');
  const i = s.indexOf('{');
  const head = (i > 0 ? s.slice(0, i) : '').replace(/\s*HTTP \d+:\s*$/, ' ');
  const body = i > 0 ? s.slice(i) : s;
  const m = body.match(/"code"\s*:\s*(\d+)\s*,\s*"msg"\s*:\s*"([^"]*)"/);
  if (!m) return s.length > 300 ? `${head}${body.slice(0, 300)}…` : s;
  const zh = (body.match(/"zh"\s*:\s*"([^"]*)"/) || [])[1];
  return `${head}上游 ${m[1]}：${UPSTREAM_CODE_HINT[Number(m[1])] || zh || m[2]}`;
}

/** 多账号错误列表 → 一行简报（给客户端响应体与日志共用） */
export function briefErrors(errors, n = 3) {
  return (errors || [])
    .slice(0, n)
    .map(briefUpstream)
    .join(' | ');
}

/** 响应体里挑出一句人话（鉴权/参数类拒绝的日志用） */
function shortReject(body) {
  if (!body) return '未知错误';
  if (typeof body === 'string') return body.slice(0, 200);
  if (typeof body.error === 'string') return body.error.slice(0, 200);
  if (typeof body.error?.message === 'string') return body.error.message.slice(0, 200);
  if (typeof body.message === 'string') return body.message.slice(0, 200);
  return JSON.stringify(body).slice(0, 200);
}

/**
 * 「没进入转发」的请求也要留痕。
 *
 * 此前只有真正打到账号池的请求才写日志：Key 不对、代理没开、body 缺字段这些在
 * handler 开头就被 `return` 掉了，界面「请求日志」一片空白 —— 用户看到的现象恰好
 * 就是「反向代理用不了，日志里什么都没有」。而这类拒绝往往正是问题本身。
 *
 * 做法：包一层 `res.json` 抓住响应体，`finish` 时若状态码 ≥ 400 且 handler 没记过，
 * 就补一条日志（带客户端 UA、Key 携带方式、请求路径）。
 */
function watchRejections(req, res, next) {
  const started = Date.now();
  const sendJson = res.json.bind(res);
  let body = null;
  res.json = (b) => {
    body = b;
    return sendJson(b);
  };
  res.on('finish', () => {
    if (res.statusCode < 400) return;
    if (res.locals?.proxyLogged) return; // 账号池已记过（markFailed / handleChat）
    summarizeLog();
    state.stats.failed += 1;
    log({
      at: Date.now(),
      ok: false,
      status: res.statusCode,
      model: req.body?.model ? String(req.body.model) : null,
      stream: !!req.body?.stream,
      account: null,
      ms: Date.now() - started,
      error: shortReject(body),
      ua: uaOf(req),
      auth: authLabel(req),
      path: pathOf(req),
    });
  });
  next();
}

/**
 * 把上游流接到客户端响应。
 * 客户端提前断开（Ctrl+C、超时取消）时要销毁上游流，
 * 否则这次请求会一直挂在官方服务器上，连接与账号在途名额都释放不掉。
 */
function pipeStream(webStream, res) {
  return new Promise((resolve, reject) => {
    const nodeStream = Readable.fromWeb(webStream);
    let clientGone = false;
    res.on('close', () => {
      if (!res.writableFinished) {
        clientGone = true;
        nodeStream.destroy();
      }
    });
    nodeStream.on('error', (err) => (clientGone ? resolve() : reject(err)));
    nodeStream.on('end', resolve);
    nodeStream.pipe(res);
  });
}

/* ---------------- OpenAI 兼容端点 ---------------- */

async function handleChat(req, res) {
  const started = Date.now();
  const cfg = loadConfig();
  if (!cfg.proxy?.enabled) return res.status(403).json({ error: '反向代理未开启，请在「反向代理」页面开启' });
  if (!authorized(req)) return res.status(401).json({ error: 'API Key 无效，请在「反向代理」页面查看或重新生成' });

  let body;
  try {
    body = buildUpstreamBody(req.body || {});
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const pool = poolAccounts();
  if (!pool.length) {
    return res.status(503).json({
      error: '没有可用账号：反向代理需要至少 1 个带明文凭据的 WorkBuddy 账号（扫码登录导入的账号才有）',
    });
  }

  const timeoutMs = Number(cfg.proxy?.timeoutMs) || DEFAULT_PROXY.timeoutMs;
  const isStream = !!body.stream;
  const errors = [];

  // 每个账号最多两轮（一轮直发，401/403 时刷新后重试一轮），全部失败才放弃
  for (let i = 0; i < pool.length; i++) {
    const account = pool[(state.rr + i) % pool.length];
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt === 0 && needsRefresh(account)) await refreshAccessToken(account);
        const out = await chatComplete(account, body, { timeoutMs });
        if (out.ok) {
          state.rr = (state.rr + i + 1) % pool.length;
          summarizeLog();
          state.stats.ok += 1;
          log({
            at: Date.now(),
            ok: true,
            status: out.status,
            model: String(body.model),
            stream: isStream,
            account: accountMeta(account).name,
            ms: Date.now() - started,
            ua: uaOf(req),
            auth: authLabel(req),
            path: pathOf(req),
          });
          if (isStream) {
            res.status(out.status);
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            await pipeStream(out.stream, res);
            return;
          }
          res.status(out.status);
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(out.text);
          return;
        }
        // 401/403：先刷新再试一次同一账号；其它错误直接换号
        if ((out.status === 401 || out.status === 403) && attempt === 0) {
          await refreshAccessToken(account).catch(() => {});
          continue;
        }
        errors.push(`${accountMeta(account).name}: ${out.error || `HTTP ${out.status}`}`);
        break;
      } catch (err) {
        errors.push(`${accountMeta(account).name}: ${err?.message || '请求失败'}`);
        break;
      }
    }
  }

  summarizeLog();
  state.stats.failed += 1;
  res.locals.proxyLogged = true;
  log({
    at: Date.now(),
    ok: false,
    status: 502,
    model: String(body.model),
    stream: isStream,
    account: null,
    ms: Date.now() - started,
    error: briefErrors(errors, 1) || '所有账号都请求失败',
    errorRaw: errors.join(' | ').slice(0, 4000),
    ua: uaOf(req),
    auth: authLabel(req),
    path: pathOf(req),
  });
  res.status(502).json({ error: '所有账号都请求失败', details: errors.slice(0, 5).map(briefUpstream) });
}

async function handleModels(req, res) {
  const cfg = loadConfig();
  if (!cfg.proxy?.enabled) return res.status(403).json({ error: '反向代理未开启' });
  if (!authorized(req)) return res.status(401).json({ error: 'API Key 无效' });

  const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
  if (refresh || !state.models.ids.length) await refreshModelsCache().catch(() => {});

  const now = Math.floor(Date.now() / 1000);
  // Anthropic 客户端（Claude Code / ZCode）按 Anthropic 的模型列表形状解析
  if (req.headers['anthropic-version']) {
    return res.json({
      data: state.models.ids.map((id) => ({
        id,
        type: 'model',
        display_name: id,
        created_at: new Date(now * 1000).toISOString(),
      })),
      has_more: false,
      first_id: state.models.ids[0] || null,
      last_id: state.models.ids[state.models.ids.length - 1] || null,
    });
  }
  res.json({
    object: 'list',
    data: state.models.ids.map((id) => ({ id, object: 'model', created: now, owned_by: 'workbuddy' })),
  });
}

/* ---------------- Anthropic Messages 端点（Claude Code / ZCode） ---------------- */

/** 给非流式路径套上客户端断连信号（流式路径由 openUpstreamStream 直接用 signal） */
function clientAbort(res) {
  const ctrl = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) ctrl.abort();
  });
  return ctrl.signal;
}

const anthropicError = (res, status, message) =>
  res.status(status).json({
    type: 'error',
    error: { type: status === 401 ? 'authentication_error' : status === 429 ? 'rate_limit_error' : 'api_error', message },
  });

const sseHeaders = (res) => {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
};

/** 结算一次成功请求（轮转指针前进 + 日志） */
function markOk({ started, model, stream, account, status = 200, req }) {
  summarizeLog();
  state.stats.ok += 1;
  log({
    at: Date.now(),
    ok: true,
    status,
    model,
    stream,
    account: accountMeta(account).name,
    ms: Date.now() - started,
    ua: req ? uaOf(req) : null,
    auth: req ? authLabel(req) : null,
    path: req ? pathOf(req) : null,
  });
}

/**
 * 结算一次失败请求。
 * 传 `res` 是为了在响应上打标记，避免外层的「拒绝请求监听」把同一次失败记两遍。
 */
function markFailed(res, { started, model, stream, errors }) {
  summarizeLog();
  state.stats.failed += 1;
  if (res?.locals) res.locals.proxyLogged = true;
  const raw = (errors || []).join(' | ');
  log({
    at: Date.now(),
    ok: false,
    status: 502,
    model,
    stream,
    account: null,
    ms: Date.now() - started,
    error: briefErrors(errors, 1) || '所有账号都请求失败',
    errorRaw: raw.slice(0, 4000),
  });
}

/**
 * 账号池遍历执行器（Anthropic / Responses 端点共用）。
 *
 * task 的返回约定：
 *   'done'          —— 已成功响应，收工
 *   'retry-auth'    —— 401/403，刷新同一账号后再试一轮
 *   其它对象         —— 该账号失败（取 .error 记日志），换下一个账号
 */
async function runAcrossPool(pool, task) {
  const errors = [];
  for (let i = 0; i < pool.length; i++) {
    const account = pool[(state.rr + i) % pool.length];
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt === 0 && needsRefresh(account)) await refreshAccessToken(account).catch(() => {});
        const r = await task(account, attempt);
        if (r === 'done') {
          state.rr = (state.rr + i + 1) % pool.length;
          return { ok: true };
        }
        if (r === 'retry-auth' && attempt === 0) {
          await refreshAccessToken(account).catch(() => {});
          continue;
        }
        errors.push(`${accountMeta(account).name}: ${r?.error || '请求失败'}`);
        break;
      } catch (err) {
        if (err?.status === 401 || err?.status === 403) {
          if (attempt === 0) {
            await refreshAccessToken(account).catch(() => {});
            continue;
          }
        }
        errors.push(`${accountMeta(account).name}: ${err?.message || '请求失败'}`);
        break;
      }
    }
  }
  return { ok: false, errors };
}

async function handleMessages(req, res) {
  const started = Date.now();
  const cfg = loadConfig();
  if (!cfg.proxy?.enabled) return anthropicError(res, 403, '反向代理未开启，请在控制台「反向代理」页面开启');
  if (!authorized(req)) return anthropicError(res, 401, 'API Key 无效，请在控制台「反向代理」页面查看或重新生成');
  const pool = poolAccounts();
  if (!pool.length) {
    return anthropicError(res, 503, '没有可用账号：反向代理需要至少 1 个带明文凭据的 WorkBuddy 账号（扫码登录导入的账号才有）');
  }

  let upstream;
  try {
    upstream = anthropicToOpenAi(req.body || {});
  } catch (err) {
    return anthropicError(res, 400, `请求体解析失败：${err?.message || err}`);
  }
  if (!upstream.messages?.length) return anthropicError(res, 400, '缺少 messages');
  if (!upstream.model) return anthropicError(res, 400, '缺少 model');

  // 按 Anthropic 规范：只有显式 stream:true 才流式，否则返回完整 message
  const isStream = req.body?.stream === true;
  const timeoutMs = Number(cfg.proxy?.timeoutMs) || DEFAULT_PROXY.timeoutMs;
  const signal = clientAbort(res);

  const result = await runAcrossPool(pool, async (account, attempt) => {
    if (isStream) {
      const up = await openUpstreamStream(account, upstream, { signal });
      sseHeaders(res);
      try {
        await pipeAnthropicStream(up.frames, res, { model: upstream.model, signal });
      } catch (pipeErr) {
        if (!signal.aborted && !res.writableEnded) {
          res.write(
            `event: error\ndata: ${JSON.stringify({
              type: 'error',
              error: { type: 'api_error', message: String(pipeErr?.message || pipeErr) },
            })}\n\n`
          );
          res.end();
        }
      }
      markOk({ started, model: upstream.model, stream: true, account, req });
      return 'done';
    }

    const out = await chatComplete(account, upstream, { timeoutMs });
    if (out.ok) {
      let parsed;
      try {
        parsed = JSON.parse(out.text);
      } catch {
        return { error: '上游响应解析失败' };
      }
      res.json(buildAnthropicMessage(parsed, upstream.model));
      markOk({ started, model: upstream.model, stream: false, account, req });
      return 'done';
    }
    if ((out.status === 401 || out.status === 403) && attempt === 0) return 'retry-auth';
    return { error: out.error || `HTTP ${out.status}` };
  });

  if (!result.ok && !res.headersSent) {
    markFailed(res, { started, model: upstream.model, stream: isStream, errors: result.errors, req });
    return anthropicError(res, 502, `所有账号都请求失败：${briefErrors(result.errors, 3)}`);
  }
}

/* ---------------- OpenAI Responses 端点（Codex CLI） ---------------- */

const responsesError = (res, status, message) =>
  res.status(status).json({
    error: { message, type: status === 401 ? 'invalid_request_error' : 'api_error', code: status === 401 ? 'invalid_api_key' : null },
  });

async function handleResponses(req, res) {
  const started = Date.now();
  const cfg = loadConfig();
  if (!cfg.proxy?.enabled) return responsesError(res, 403, '反向代理未开启，请在控制台「反向代理」页面开启');
  if (!authorized(req)) return responsesError(res, 401, 'API Key 无效，请在控制台「反向代理」页面查看或重新生成');
  const pool = poolAccounts();
  if (!pool.length) {
    return responsesError(res, 503, '没有可用账号：反向代理需要至少 1 个带明文凭据的 WorkBuddy 账号（扫码登录导入的账号才有）');
  }

  const upstream = responsesToOpenAi(req.body || {});
  if (!upstream.messages?.length) return responsesError(res, 400, '缺少 input');
  if (!upstream.model) return responsesError(res, 400, '缺少 model');

  // 按 Responses 规范：只有显式 stream:true 才流式
  const isStream = req.body?.stream === true;
  const timeoutMs = Number(cfg.proxy?.timeoutMs) || DEFAULT_PROXY.timeoutMs;
  const signal = clientAbort(res);

  const result = await runAcrossPool(pool, async (account, attempt) => {
    if (isStream) {
      const up = await openUpstreamStream(account, upstream, { signal });
      sseHeaders(res);
      try {
        await pipeResponsesStream(up.frames, res, { model: upstream.model, signal });
      } catch (pipeErr) {
        if (!signal.aborted && !res.writableEnded) {
          res.write(
            `event: response.failed\ndata: ${JSON.stringify({
              type: 'response.failed',
              response: { id: 'resp_error', object: 'response', status: 'failed', error: { code: 'upstream_error', message: String(pipeErr?.message || pipeErr) } },
            })}\n\n`
          );
          res.end();
        }
      }
      markOk({ started, model: upstream.model, stream: true, account, req });
      return 'done';
    }

    const out = await chatComplete(account, upstream, { timeoutMs });
    if (out.ok) {
      let parsed;
      try {
        parsed = JSON.parse(out.text);
      } catch {
        return { error: '上游响应解析失败' };
      }
      res.json(buildResponsesReply(parsed, upstream.model));
      markOk({ started, model: upstream.model, stream: false, account, req });
      return 'done';
    }
    if ((out.status === 401 || out.status === 403) && attempt === 0) return 'retry-auth';
    return { error: out.error || `HTTP ${out.status}` };
  });

  if (!result.ok && !res.headersSent) {
    markFailed(res, { started, model: upstream.model, stream: isStream, errors: result.errors, req });
    return responsesError(res, 502, `所有账号都请求失败：${briefErrors(result.errors, 3)}`);
  }
}

/* ---------------- Google Gemini 原生端点（Gemini CLI / Gemini SDK） ---------------- */

/** Gemini 错误体：{ error: { code, message, status } } */
const GEMINI_STATUS_NAME = {
  400: 'INVALID_ARGUMENT',
  401: 'UNAUTHENTICATED',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
  429: 'RESOURCE_EXHAUSTED',
  500: 'INTERNAL',
  502: 'INTERNAL',
  503: 'UNAVAILABLE',
  504: 'DEADLINE_EXCEEDED',
};

const geminiError = (res, status, message) =>
  res.status(status).json({ error: { code: status, message, status: GEMINI_STATUS_NAME[status] || 'UNKNOWN' } });

/**
 * generateContent / streamGenerateContent 共用入口。
 * 路径形如 /v1beta/models/{model}:generateContent，模型在 **URL 路径**里
 * （Gemini 请求体不含 model 字段），因此从 req.params 取。
 */
async function handleGemini(req, res) {
  const started = Date.now();
  const endpoint = String(req.params?.[1] || 'generateContent');
  const rawModel = decodeURIComponent(String(req.params?.[0] || ''));
  const model = rawModel.replace(/^models\//, '');

  const cfg = loadConfig();
  if (!cfg.proxy?.enabled) return geminiError(res, 403, '反向代理未开启，请在控制台「反向代理」页面开启');
  if (!authorized(req)) return geminiError(res, 401, 'API Key 无效，请在控制台「反向代理」页面查看或重新生成');
  const pool = poolAccounts();
  if (!pool.length) {
    return geminiError(res, 503, '没有可用账号：反向代理需要至少 1 个带明文凭据的 WorkBuddy 账号（扫码登录导入的账号才有）');
  }

  let upstream;
  try {
    upstream = geminiToOpenAi(req.body || {}, model);
  } catch (err) {
    return geminiError(res, 400, `请求体解析失败：${err?.message || err}`);
  }
  if (!upstream.messages?.length) return geminiError(res, 400, '缺少 contents');
  if (!upstream.model) return geminiError(res, 400, '缺少模型名（应出现在 URL 路径 /v1beta/models/{model} 中）');

  // Gemini 协议按端点区分：:|generateContent 非流式，:streamGenerateContent 流式
  const isStream = endpoint === 'streamGenerateContent';
  const timeoutMs = Number(cfg.proxy?.timeoutMs) || DEFAULT_PROXY.timeoutMs;
  const signal = clientAbort(res);

  const result = await runAcrossPool(pool, async (account, attempt) => {
    if (isStream) {
      const up = await openUpstreamStream(account, upstream, { signal });
      sseHeaders(res);
      try {
        await pipeGeminiStream(up.frames, res, { model: upstream.model, signal });
      } catch (pipeErr) {
        if (!signal.aborted && !res.writableEnded) {
          res.write(
            `data: ${JSON.stringify({
              error: { code: 502, message: String(pipeErr?.message || pipeErr), status: 'INTERNAL' },
            })}\n\n`
          );
          res.end();
        }
      }
      markOk({ started, model: upstream.model, stream: true, account, req });
      return 'done';
    }

    const out = await chatComplete(account, upstream, { timeoutMs });
    if (out.ok) {
      let parsed;
      try {
        parsed = JSON.parse(out.text);
      } catch {
        return { error: '上游响应解析失败' };
      }
      res.json(buildGeminiResponse(parsed, upstream.model));
      markOk({ started, model: upstream.model, stream: false, account, req });
      return 'done';
    }
    if ((out.status === 401 || out.status === 403) && attempt === 0) return 'retry-auth';
    return { error: out.error || `HTTP ${out.status}` };
  });

  if (!result.ok && !res.headersSent) {
    markFailed(res, { started, model: upstream.model, stream: isStream, errors: result.errors, req });
    return geminiError(res, 502, `所有账号都请求失败：${briefErrors(result.errors, 3)}`);
  }
}

/** GET /v1beta/models：Gemini 形状的模型清单 */
async function handleGeminiModels(req, res) {
  const cfg = loadConfig();
  if (!cfg.proxy?.enabled) return geminiError(res, 403, '反向代理未开启');
  if (!authorized(req)) return geminiError(res, 401, 'API Key 无效');

  const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
  if (refresh || !state.models.ids.length) await refreshModelsCache().catch(() => {});
  res.json(geminiModelsPayload(state.models.ids));
}

/**
 * POST /v1beta/models/{model}:countTokens
 * Gemini CLI 用它做上下文预算；本地按字符数粗估即可（官方也只承诺近似）。
 * 估算口径：约 4 字符 / token，与官方"字符数估算"同量级。
 */
function handleGeminiCountTokens(req, res) {
  const cfg = loadConfig();
  if (!cfg.proxy?.enabled) return geminiError(res, 403, '反向代理未开启');
  if (!authorized(req)) return geminiError(res, 401, 'API Key 无效');

  const body = req.body || {};
  let chars = 0;
  for (const c of Array.isArray(body.contents) ? body.contents : []) {
    for (const p of Array.isArray(c?.parts) ? c.parts : []) {
      if (typeof p?.text === 'string') chars += p.text.length;
    }
  }
  const sys = body.systemInstruction;
  if (typeof sys === 'string') chars += sys.length;
  else for (const p of Array.isArray(sys?.parts) ? sys.parts : []) if (typeof p?.text === 'string') chars += p.text.length;

  res.json({ totalTokens: Math.max(1, Math.ceil(chars / 4)) });
}

/** 从账号池第一个可用账号拉模型清单，写入进程内缓存 */
export async function refreshModelsCache() {
  const pool = poolAccounts();
  if (!pool.length) {
    state.models = { ids: [], fetchedAt: null, error: '没有可用账号', account: null };
    return state.models;
  }
  let lastErr = null;
  for (const account of pool) {
    try {
      if (needsRefresh(account)) await refreshAccessToken(account).catch(() => {});
      const models = await fetchUpstreamModels(account);
      if (models?.length) {
        state.models = {
          ids: models.map((m) => m.id),
          fetchedAt: Date.now(),
          error: null,
          account: accountMeta(account).name,
        };
        return state.models;
      }
      lastErr = '上游返回空模型列表';
    } catch (err) {
      lastErr = err?.message || String(err);
    }
  }
  state.models = { ids: [], fetchedAt: Date.now(), error: lastErr, account: null };
  return state.models;
}

/* ---------------- 管理接口（前端页面用） ---------------- */

function publicStatus(port, { reveal = false } = {}) {
  const cfg = loadConfig();
  // 界面统一按"显式列表"理解：未指定（null）时展开成全部可用账号的 id
  const stored = cfg.proxy?.accountIds;
  const selected = Array.isArray(stored) ? stored : loadAccounts().map((a) => a?.id).filter(Boolean);
  const loginUids = currentLoginUids();
  const accounts = loadAccounts().map((a) => {
    const meta = accountMeta(a);
    const usable = canEgress(a);
    return {
      id: meta.id,
      name: meta.name,
      uid: meta.uid,
      variant: meta.variant,
      variantLabel: meta.variantLabel,
      usable,
      expired: meta.expired,
      expiresAt: meta.expiresAt,
      selected: selected.length ? selected.includes(meta.id) : true,
      // 桌面端当前登录的账号：即使勾选了也不在池里（poolAccounts 强制排除），界面据此禁勾并打标
      isCurrentLogin: !!(meta.uid && loginUids.has(String(meta.uid))),
    };
  });
  return {
    enabled: !!cfg.proxy?.enabled,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    chatUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
    hasKey: !!cfg.proxy?.apiKey,
    keyPreview: cfg.proxy?.apiKey ? `sk-wb-••••${cfg.proxy.apiKey.slice(-6)}` : '',
    // 明文只在用户点「显示」时带出（本机工具、用户自己的 Key，与模型页 Key 显示口径一致）
    apiKey: reveal ? cfg.proxy?.apiKey || '' : '',
    accountIds: selected,
    poolCount: poolAccounts().length,
    accounts,
    models: state.models,
    stats: state.stats,
    logs: state.logs.slice(0, 50),
  };
}

/**
 * 挂载反向代理路由。
 * 必须在 Express 的静态资源 / SPA 兜底之前调用，否则 /v1/* 会被 index.html 吃掉。
 */
export function registerProxyRoutes(app, { port }) {
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
    res.status(500).json({ error: err?.message || '服务器内部错误' });
  });

  /**
   * CORS：有些调用方是浏览器页面（自建 Web UI / 在线前端），同源策略会拦预检。
   * 这里只监听 127.0.0.1，放行成本极低；不放行的话这类客户端根本连不上。
   *
   * 注意 `/v1` 与 `/v1beta` 是两个独立前缀（Express 的 use 按路径段边界匹配，
   * `/v1` 不会命中 `/v1beta`），所以两个都要挂。
   */
  const corsV1 = (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type, X-API-Key, X-Goog-Api-Key, Anthropic-Version, Anthropic-Beta, Anthropic-Dangerous-Direct-Browser-Access'
    );
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  };
  app.use('/v1', corsV1);
  app.use('/v1beta', corsV1);

  // 拒绝也要留痕（必须在各端点之前挂）
  app.use('/v1', watchRejections);
  app.use('/v1beta', watchRejections);

  app.get('/api/proxy/status', (req, res) => res.json(publicStatus(port, { reveal: req.query.reveal === '1' })));

  app.put(
    '/api/proxy/config',
    wrap(async (req, res) => {
      const cfg = loadConfig();
      cfg.proxy = { ...DEFAULT_PROXY, ...cfg.proxy };
      if (typeof req.body?.enabled === 'boolean') cfg.proxy.enabled = req.body.enabled;
      if (Array.isArray(req.body?.accountIds)) cfg.proxy.accountIds = req.body.accountIds.filter((x) => typeof x === 'string');
      if (cfg.proxy.enabled && !cfg.proxy.apiKey) cfg.proxy.apiKey = ensureKey();
      saveConfig(cfg);
      res.json(publicStatus(port));
    })
  );

  app.post(
    '/api/proxy/key/rotate',
    wrap(async (req, res) => {
      const cfg = loadConfig();
      cfg.proxy = { ...DEFAULT_PROXY, ...cfg.proxy, apiKey: `sk-wb-${crypto.randomBytes(16).toString('hex')}` };
      saveConfig(cfg);
      res.json(publicStatus(port));
    })
  );

  app.post('/api/proxy/models/refresh', wrap(async (req, res) => res.json(await refreshModelsCache())));

  app.get('/api/proxy/logs', (req, res) => res.json({ logs: state.logs.slice(0, 200) }));

  /** 连通性自检：发一条极短的非流式请求，验证「Key → 账号 → 官方接口」整条链路 */
  app.post(
    '/api/proxy/test',
    wrap(async (req, res) => {
      const pool = poolAccounts();
      if (!pool.length) return res.status(400).json({ ok: false, error: '没有可用账号' });
      const model = String(req.body?.model || state.models.ids[0] || '').trim();
      if (!model) return res.status(400).json({ ok: false, error: '没有可用模型，请先刷新模型列表' });
      const account = pool[0];
      try {
        if (needsRefresh(account)) await refreshAccessToken(account);
        const out = await chatComplete(
          account,
          { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 16 },
          { timeoutMs: 60_000 }
        );
        if (out.ok) {
          return res.json({
            ok: true,
            account: accountMeta(account).name,
            variant: variantOf(account).label,
            model,
            preview: String(out.text || '').slice(0, 200),
          });
        }
        return res.json({ ok: false, account: accountMeta(account).name, error: out.error });
      } catch (err) {
        res.json({ ok: false, account: accountMeta(account).name, error: err?.message || String(err) });
      }
    })
  );

  // 四种协议端点：不同 agent 说不同的"方言"，共用同一个账号池
  app.post('/v1/chat/completions', wrap(handleChat)); // OpenAI SDK / Cherry Studio / ZCode(OpenAI 模式)
  app.post('/v1/messages', wrap(handleMessages)); // Claude Code / ZCode(Anthropic 模式)
  app.post('/v1/responses', wrap(handleResponses)); // Codex CLI
  app.get('/v1/models', wrap(handleModels));

  // Gemini 原生协议：模型在路径里，且带冒号方法后缀，Express 的字符串路由表达不了，
  // 用正则匹配（贪婪 .+ 保证 model 自身含 `/` 也能取到，如 google/gemini-3-pro）
  const GEMINI_PATH = /^\/v1beta\/models\/(.+):(generateContent|streamGenerateContent)$/;
  app.post(GEMINI_PATH, wrap(handleGemini)); // Gemini CLI / Gemini 原生 SDK
  app.post(/^\/v1beta\/models\/(.+):countTokens$/, wrap(handleGeminiCountTokens));
  app.get('/v1beta/models', wrap(handleGeminiModels)); // Gemini CLI 的模型清单
}
