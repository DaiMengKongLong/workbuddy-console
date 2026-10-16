import fs from 'node:fs';
import { atomicWriteJson, cachePath } from '../store/config.mjs';
import { proxyFetch } from '../proxy.mjs';

/**
 * 通用 OpenAI 兼容平台适配器：各平台只需声明 baseUrl、免费判定规则和模态推断规则。
 * 统一产出与 OpenRouter 相同的模型结构，前端无需区分来源。
 *
 * normalizeGeneric 产出的 created 保持"秒"级时间戳，与 OpenRouter 归一化结果一致。
 */

export function normalizeGeneric(m, { platform, isFree, outputKind = 'text', supportsTools = true, loadable = true, supportsReasoning = false }) {
  const id = m.id || '';
  const vendor = id.includes('/') ? id.split('/')[0] : (m.owned_by || platform);
  return {
    id,
    platform,
    name: m.name || id,
    vendor,
    created: m.created != null ? Number(m.created) || null : null,
    description: m.description || '',
    contextLength: m.context_length || m.context_window || m.max_context_window_tokens || null,
    pricing: null,
    inputModalities: ['text'],
    outputModalities: [typeof outputKind === 'function' ? 'text' : outputKind],
    supportedParameters: [],
    isFree: typeof isFree === 'function' ? !!isFree(m) : !!isFree,
    outputKind: typeof outputKind === 'function' ? outputKind(m) : outputKind,
    supportsTools,
    supportsReasoning,
    supportsImageInput: false,
    loadable: typeof loadable === 'function' ? !!loadable(m) : !!loadable,
  };
}

const UPSTREAM_TIMEOUT_MS = 15_000;

export async function fetchModelsOpenAI({ platform, baseUrl, apiKey, extraHeaders = {} }) {
  const headers = { Accept: 'application/json', ...extraHeaders };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await proxyFetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${platform} /models 返回 HTTP ${res.status}`);
  let json;
  try {
    json = await res.json();
  } catch {
    // 个别平台未鉴权时返回 200 + 纯文本（如 GitHub Models 返回 "OK"）
    throw new Error(`${platform} /models 返回了非 JSON 内容（HTTP ${res.status}），通常意味着该接口需要配置 API Key`);
  }
  const list = Array.isArray(json?.data) ? json.data : [];
  if (!list.length) throw new Error(`${platform} /models 返回为空`);
  return list;
}

/** 平台级两级缓存（内存 + ~/.free-token/cache/<platform>-models.json） */
const memCache = new Map();

export function modelsCacheFile(platform) {
  return cachePath(`${platform}-models.json`);
}

/** 服务端缓存有效期：期内直接回缓存；过期立即返回旧数据并在后台静默回源（stale-while-revalidate） */
export const MODELS_CACHE_TTL = 30 * 60_000;

const inflightRefreshes = new Map();

export async function getModelsCached({ platform, refresh = false, fetcher }) {
  const readCache = () => {
    if (memCache.has(platform)) return memCache.get(platform);
    try {
      const cached = JSON.parse(fs.readFileSync(modelsCacheFile(platform), 'utf8'));
      if (Array.isArray(cached?.models) && cached.models.length) {
        memCache.set(platform, cached);
        return cached;
      }
    } catch {
      /* 无缓存 */
    }
    return null;
  };
  const fetchAndStore = async () => {
    const models = await fetcher();
    const payload = { fetchedAt: Date.now(), platform, count: models.length, models };
    memCache.set(platform, payload);
    try {
      atomicWriteJson(modelsCacheFile(platform), payload);
    } catch {
      /* 缓存写失败不影响返回 */
    }
    return payload;
  };

  const cached = refresh ? null : readCache();
  // 无任何缓存或手动刷新：等待回源，失败向上抛
  if (refresh || !cached) return fetchAndStore();
  // 有效期内：直接回缓存
  if (Date.now() - cached.fetchedAt < MODELS_CACHE_TTL) return cached;
  // 过期缓存：立即返回旧数据，后台刷新（进行中不重复发起；失败保留旧数据，下次再试）
  if (!inflightRefreshes.has(platform)) {
    const p = fetchAndStore()
      .catch(() => {})
      .finally(() => inflightRefreshes.delete(platform));
    inflightRefreshes.set(platform, p);
  }
  return cached;
}

export function peekModelsCacheFor(platform) {
  return memCache.get(platform) || null;
}

/** 清空模型缓存（内存 + 磁盘），platform 省略时清全部 */
export function clearModelsCache(platform) {
  const ids = platform ? [platform] : [...memCache.keys()];
  for (const id of ids) memCache.delete(id);
  try {
    for (const f of fs.readdirSync(cachePath(''))) {
      if (f.endsWith('-models.json') && (!platform || f === modelsCacheFile(platform).split(/[\\/]/).pop())) {
        fs.unlinkSync(cachePath(f));
      }
    }
  } catch {
    /* ignore */
  }
}

/** 已知上游错误的可操作中文提示（匹配平台返回原文） */
const KNOWN_HINTS = [
  [
    /bind your alibaba cloud/i,
    '解决：打开 modelscope.cn → 右上角头像 → 账号设置 → 账号绑定 → 绑定阿里云账号（免费，绑定时会跳转阿里云授权），绑定后无需更换 Key，直接回来重试即可',
  ],
  [/quota|rate.?limit|throttl/i,
    '该平台返回了限额类错误：Key 鉴权可能已通过，但当前处于限速状态，稍后重试'],
  [
    // Agnes 的 503：官方文档 503 原因含"模型名称不正确/发送到错误的模型/服务暂时不可用"。
    // 探测请求到达模型路由层才会 503（鉴权失败一律 401/403），所以多数情况是探测模型
    // 与站点不匹配或上游繁忙——重试通常可过；持续出现说明该站点确实没有探测模型。
    /\b503\b|service unavailable/i,
    'Agnes 返回 503 表示请求已通过鉴权、但模型路由失败或服务暂时繁忙：请稍等重试；持续出现请更新本工具（探测模型按站点区分）',
  ],
  [
    // Agnes AI 的 401 文案（国内节点中文、国际节点英文）。Key 与签发站点绑定，
    // 本工具已自动探测全部节点；三个节点都 401 只能说明 Key 本身无效。
    /^(无效的令牌|Invalid token)/i,
    '若这是 Agnes AI 的 Key：工具已自动尝试其全部 API 节点（中国站/国际站账号体系独立），仍报此错说明 Key 在所有节点均无效——请到官网重新生成 Key，并确认创建 Key 的站点账号处于正常状态',
  ],
];

/** 读取上游错误正文摘录（401/403 时给用户看真实拒绝原因，如魔搭"未绑定阿里云账号"） */
async function errBodySnippet(res) {
  try {
    const text = (await res.text()).trim();
    if (!text) return '';
    let msg = text;
    try {
      const j = JSON.parse(text);
      msg = j?.error?.message || j?.message || j?.error || text;
    } catch {
      /* 非 JSON，直接用原文 */
    }
    msg = String(msg).replace(/\s+/g, ' ').slice(0, 160);
    const hint = KNOWN_HINTS.find(([re]) => re.test(msg) || re.test(text))?.[1];
    return msg ? `（平台返回：${msg}${hint ? `。${hint}` : ''}）` : '';
  } catch {
    return '';
  }
}

/** 用 /models 可达性做 key 有效性校验（模型列表需要鉴权的平台用） */
export async function testKeyOpenAI({ baseUrl, apiKey, extraHeaders = {} }) {
  try {
    const res = await proxyFetch(`${baseUrl}/models`, {
      headers: { Accept: 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), ...extraHeaders },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, invalid: true, error: `平台拒绝访问（HTTP ${res.status}）${await errBodySnippet(res)}` };
    }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}${await errBodySnippet(res)}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || '网络错误' };
  }
}

/**
 * 模型列表公开（无鉴权）平台的 key 校验：列表接口无法验证 key，
 * 改用一次 1-token 的 /chat/completions 探测（仅在用户点击「测试」时触发）。
 * 401/403 = key 无效；200/429/400（如模型参数问题）都认为鉴权通过。
 */
export async function testKeyByChatProbe({ baseUrl, apiKey, probeModel, extraHeaders = {} }) {
  try {
    const res = await proxyFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, ...extraHeaders },
      body: JSON.stringify({ model: probeModel, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, invalid: true, error: `平台拒绝访问（HTTP ${res.status}）${await errBodySnippet(res)}` };
    }
    if (res.status === 429) return { ok: true };
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (/model/i.test(text) && res.status === 404) return { ok: true }; // 鉴权已过，仅探测模型不存在
      return { ok: false, error: `HTTP ${res.status}${await errBodySnippet(res)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || '网络错误' };
  }
}

/**
 * 平台工厂：把一个 OpenAI 兼容平台的配置变成注册表条目。
 * - isFree / loadable / outputKind 可以是布尔值或 (rawModel) => boolean|string 函数
 * - entryUrl(model, baseUrl) 自定义写入 WorkBuddy 的 url；第二参数是「该 Key 实际
 *   生效的节点」（见 alternateBaseUrls 的探测机制），硬编码完整端点的平台必须
 *   基于它拼接，否则探测选对了节点、载入条目却仍指向默认节点（跨站 401）。
 * - modelsPublic=true 时模型列表无需鉴权，key 校验走 chat 探测（probeModel）
 * - alternateBaseUrls：同平台的多 API 节点。**key 与签发站点绑定**的平台（如 Agnes
 *   的中国站 agnes-ai.cn / 国际站 agnes-ai.com，账号体系互不相通）需要它：
 *   校验 key 时按候选顺序探测，命中哪个节点就把 baseUrl 随 key 保存、后续全程使用。
 */
export function defineOpenAIPlatform(cfg) {
  const {
    id,
    name,
    baseUrl,
    site,
    keyUrl,
    keyPlaceholder,
    modelsPublic = false,
    isFree = true,
    loadable = true,
    outputKind = 'text',
    supportsTools = true,
    supportsReasoning = false,
    entryUrl,
    mapModelId,
    probeModel,
    fetchQuotaForKey,
    keyFormat,
    note = null,
    tutorialUrl = null,
    extraHeaders = {},
    alternateBaseUrls = [],
  } = cfg;

  const normalize = (m) => {
    if (mapModelId && m.id) m = { ...m, id: mapModelId(m.id) };
    return normalizeGeneric(m, { platform: id, isFree, outputKind, supportsTools, supportsReasoning, loadable });
  };

  return {
    id,
    name,
    baseUrl,
    /** baseUrl + 全部备用节点：URL 识别（matchPlatformUrl）用——备用节点上的已载入条目也要能归属到本平台 */
    allBaseUrls: [baseUrl, ...alternateBaseUrls],
    site: site || null,
    keyUrl: keyUrl || null,
    modelsPublic,
    keyFormat: keyFormat || null,
    keyPlaceholder: keyPlaceholder || null,
    note,
    tutorialUrl,
    getModels: async ({ refresh = false, apiKey, baseUrl: baseUrlOverride } = {}) => {
      const base = baseUrlOverride || baseUrl;
      try {
        if (!modelsPublic && !apiKey) {
          throw new Error(`${name} 需要配置 API Key 才能获取模型列表，请先到「设置」添加并设为当前使用`);
        }
        return await getModelsCached({
          platform: id,
          refresh,
          fetcher: async () => {
            const list = await fetchModelsOpenAI({ platform: name, baseUrl: base, apiKey, extraHeaders });
            return list.map(normalize);
          },
        });
      } catch (err) {
        const msg = String(err?.message || err);
        if (/HTTP 40[13]/.test(msg)) {
          throw new Error(`${name} 需要配置 API Key 才能获取模型列表，请到「设置」添加`);
        }
        throw err;
      }
    },
    peek: () => peekModelsCacheFor(id),
    fetchQuotaForKey,
    testKey: async (apiKey) => {
      /**
       * 按候选节点顺序探测；key 与签发站点绑定的平台，第一个鉴权通过的节点即该 key 的归属节点。
       *
       * ⚠️ 多节点平台必须用 chat 探测而不是 /models 校验：实测（2026-10，Agnes）各节点的
       * /models 鉴权行为不一致——国际主节点 apihub.agnes-ai.com 的 /models 公开，**假 key 也
       * 返回 200**，用 /models 校验会把垃圾 key「假通过」并绑定到错误节点；而三个节点的
       * /chat/completions 鉴权行为完全一致（无效 key 一律 401）。
       * 探测模型从任意能拉到列表的节点获取（列表内容同平台一致）。
       */
      const candidates = [baseUrl, ...alternateBaseUrls];
      const useChatProbe = modelsPublic || candidates.length > 1;
      let model = probeModel;
      if (useChatProbe && !model) {
        for (const b of candidates) {
          try {
            const list = await fetchModelsOpenAI({ platform: name, baseUrl: b, apiKey, extraHeaders });
            model = list[0]?.id;
            if (model) break;
          } catch {
            /* 该节点拉不到列表（需鉴权/故障），换下一个 */
          }
        }
      }
      const attempt = async (base) => {
        if (useChatProbe) {
          if (!model) return { ok: false, error: '无法确定探测模型' };
          return testKeyByChatProbe({ baseUrl: base, apiKey, probeModel: model, extraHeaders });
        }
        return testKeyOpenAI({ baseUrl: base, apiKey, extraHeaders });
      };

      let firstFailure = null;
      for (const base of candidates) {
        const r = await attempt(base);
        if (r.ok) return { ...r, baseUrl: base };
        // 网络错误也换下一节点（某节点被墙/宕机时其余节点可能可达）；
        // 只保留第一个失败原因用于最终报错——它来自默认节点，最有代表性
        if (!firstFailure) firstFailure = r;
      }
      return firstFailure || { ok: false, error: '所有节点探测失败' };
    },
    buildEntry: (model, apiKey, baseUrlOverride) => {
      const base = baseUrlOverride || baseUrl;
      return {
        id: model.id,
        name: model.name || model.id,
        vendor: 'Custom',
        url: entryUrl ? entryUrl(model, base) : base,
        apiKey,
        supportsToolCall: !!model.supportsTools,
        supportsImages: !!model.supportsImageInput,
        supportsReasoning: !!model.supportsReasoning,
        useCustomProtocol: false,
      };
    },
  };
}
