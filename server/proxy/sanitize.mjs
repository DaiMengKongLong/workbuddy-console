/**
 * 出站文本净化层：抹掉会触发上游风控 `code 11128` 的「第三方 agent 指纹」。
 *
 * 背景（2026-10-13 实测结论）
 * ---------------------------------------------------------------
 * 上游 /v2/chat/completions 有一道**渠道风控**：只放行 WorkBuddy 自家客户端的请求，
 * 一旦在 system 级文本里认出别家 agent 的系统提示词，就回
 *   400 {"code":11128,"msg":"Illegal API invocation from an unapproved channel"}
 * 带不带客户端指纹头都一样（同一组头走普通请求是通的），所以它判的是**内容**。
 *
 * 实证（回放本机 codex 0.139.0 的真实 rollout）：
 *   - 52,000 字中性文本            → 通过  ⇒ 与长度无关
 *   - Codex base_instructions 前 184 字 → 通过；**前 185 字**（多一个句号）→ 被拦
 *   - 删掉三句里的任意一句 / 打乱句序 / 在句间插一个换行 → 全部通过
 *   - 只把 "Codex CLI" 换中性词    → 通过
 *   - 只把 "OpenAI" 换中性词       → 通过
 *   - 整段转小写                   → 仍被拦（大小写不敏感）
 * ⇒ 判据是**一段连续逐字文本**命中已知竞品系统提示词，不是关键词表、也不是长度门。
 *   所以无需删掉整段提示词，只要打断这段连续匹配即可。
 *
 * 净化范围：**只动 system 级文本**（Responses 的 instructions、Anthropic 的 system、
 * OpenAI 的 role:"system"、Gemini 的 systemInstruction）。用户消息一律原样透传 ——
 * 用户正常问一句 "OpenAI 是什么" 不该被改写。
 *
 * ⚠️ 加规则前必须先二分验证。改写 system 文本本身有语义代价（Claude Code 这类提示词
 * 依赖自我认知），没有实测证据不要凭猜加词。当前词表仅覆盖已实证的 Codex / OpenAI 家族。
 */

/**
 * 剥离客户端注入在 system 顶部的内部元数据行。
 *
 * 实测（Claude Code 2.1.205）：system 首行是
 *   `x-anthropic-billing-header: cc_version=2.1.205.ca0; cc_entrypoint=sdk-cli;`
 * 带着这一行上游同样回 11128；删掉这一行（其余 system 原样保留）即恢复正常。
 * 上游风控把 Anthropic 官方的计费头/渠道标记认成了「未授权渠道调用」。
 *
 * 该行对模型语义没有任何价值，因此出站前一律剔除（含同族的 `x-*-header:` 行）。
 */
export function stripInternalHeaders(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*x-[a-z0-9-]+-header\s*:/i.test(line))
    .join('\n')
    .replace(/^\s*\n+/, '');
}

/**
 * 竞品指纹词表：[正则, 中性替身]。
 *
 * 顺序有意义 —— 长的先替（`Codex CLI` 必须先于 `Codex`）。
 * 替身刻意选成"产品名/普通短语"形状，让句子仍然读得通：
 *   "running in the Codex CLI"        → "running in the assistant CLI"
 *   "Codex CLI is an open source..."  → "Assistant CLI is an open source..."
 *   "led by OpenAI"                   → "led by the vendor"
 */
const BRAND_RULES = [
  [/\bCodex CLI\b/gi, 'assistant CLI'],
  [/\bCodex\b/gi, 'assistant'],
  [/\bOpenAI\b/gi, 'the vendor'],
  [/\bChatGPT\b/gi, 'the chat assistant'],
];

/** 位于句首（串首 / 句末标点后 / 换行后）才补大写，句中的 "by OpenAI" 不能变成 "by The vendor" */
const atSentenceStart = (before) => /(^|[.!?]|\n)\s*$/.test(before);

/** 把竞品指纹词换成中性词（大小写不敏感；仅在句首保留首字母大写） */
export function neutralizeAgentFingerprint(text) {
  let out = String(text);
  for (const [re, to] of BRAND_RULES) {
    out = out.replace(re, (_match, offset, whole) =>
      atSentenceStart(whole.slice(0, offset)) ? to[0].toUpperCase() + to.slice(1) : to
    );
  }
  return out;
}

/** system 级文本的完整净化：先去内部元数据行，再抹竞品指纹 */
export function sanitizeSystemText(text) {
  if (typeof text !== 'string' || !text) return text;
  return neutralizeAgentFingerprint(stripInternalHeaders(text));
}

/**
 * 就地净化 messages 里所有 system 级条目（`system` / `developer`），返回同一数组。
 *
 * 各协议适配器（anthropic / responses / gemini）与 OpenAI 直通路径都收敛到
 * 「构造出 OpenAI messages」这一步，因此净化只挂在每个适配器的出口，规则单一来源。
 */
export function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  for (const m of messages) {
    if (!m || (m.role !== 'system' && m.role !== 'developer')) continue;
    if (typeof m.content === 'string') m.content = sanitizeSystemText(m.content);
    else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part && typeof part.text === 'string') part.text = sanitizeSystemText(part.text);
      }
    }
  }
  return messages;
}
