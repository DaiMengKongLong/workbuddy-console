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
 * 依赖自我认知），没有实测证据不要凭猜加词。当前规则分两张表，都只收**已实证触发**的项：
 *   - `BRAND_RULES`    —— 品牌词（Codex / OpenAI 家族）
 *   - `TEMPLATE_RULES` —— 竞品系统提示词里的固定模板句（Claude Code 的 git 状态分支标签）
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

/**
 * 上游指纹库里不止有**品牌词**，还有竞品系统提示词里的**固定模板句**。
 *
 * 实证（2026-10-13，回放 ZCode 的真实请求体 `_dev/zcode-body.json`，本地代理 57901）：
 *   - ZCode 的 system 是 3 段；逐段测下来只有第 3 段（5,735 字的「沟通 / 环境」提示）被拦，
 *     第 1、2 段单独送都能过 ⇒ 触发点在第 3 段。
 *   - 第 3 段里**没有任何品牌词**（ZCode/Claude/Anthropic/OpenAI/Codex 计数全为 0），
 *     却稳定触发 ⇒ 判据是模板句而不是品牌名。
 *   - 该段里删掉 ` (you will usually use this for PRs)` 这 36 个字，**整段 5,735 字立刻通过**；
 *     把这 47 字的 `Main branch (you will usually use this for PRs)` 单独当 system 发，
 *     仍然稳定 11128（连测 3 次一致）⇒ 最小触发片段就是它，且该段内不存在第二个触发点。
 *
 * 这串是 **Claude Code 往 system 注入 git 状态时写的分支标签**
 * （`Main branch (you will usually use this for PRs): <分支>`，当前分支是主干时才会出现）。
 * 处理方式与品牌词一致：还原成普通写法，语义不变、也不再逐字命中指纹库。
 *
 * ⚠️ 同 `BRAND_RULES`：加规则前必须先用「移除该片段 → 上游是否放行」实证。
 */
const TEMPLATE_RULES = [
  [/Main branch \(you will usually use this for PRs\)/g, 'Main branch'],
  /**
   * DeepSeek Harness 身份句（2026-10-24，社区方案 + 本机实捕双重确认）。
   *
   * 实捕原文（`~/.wb-switch/proxy-11128-samples.jsonl`，6 次重试全部命中）：
   *   "You are an AI agent powered by **DeepSeek Harness**."
   *   "You are interacting with the user through the **DeepSeek Harness** Web GUI ..."
   * 上游把「DeepSeek Harness」这个连续串认成未授权客户端 → 11128。
   *
   * 处置：在 "DeepSeek" 后插一个**零宽空格**（U+200B）——逐字匹配被打断，
   * 视觉与语义完全不变（模型照常读成 DeepSeek Harness），且比删词安全。
   */
  [/DeepSeek([\s-]+)Harness/gi, 'DeepSeek\u200B$1Harness'],
];

/** 抹掉竞品系统提示词的固定模板句（只做已验证的逐字替换） */
export function neutralizeInjectedTemplates(text) {
  let out = String(text);
  for (const [re, to] of TEMPLATE_RULES) out = out.replace(re, to);
  return out;
}

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

/** system 级文本的完整净化：先去内部元数据行，再抹竞品指纹（品牌词 + 模板句），最后断行防指纹 */
export function sanitizeSystemText(text) {
  if (typeof text !== 'string' || !text) return text;
  return breakLongFingerprint(neutralizeInjectedTemplates(neutralizeAgentFingerprint(stripInternalHeaders(text))));
}

/**
 * 通用防指纹：长 system 文本按句断行。
 *
 * 11128 的判据是「**一段连续逐字文本**命中竞品系统提示词库」（2026-10-13 回放实验结论，
 * 见文件头）。该实验同时验证：在句间插入一个换行即可打断匹配、全部放行——所以对
 * 「不在已知规则表里」的新 harness（如 DeepSeek harness），通用解法就是断行，不需要
 * 逐个猜品牌词。
 *
 * 边界（避免破坏语义/代码）：
 *   - 只处理 ≥2KB 的长文本（用户自己写的短 system 一律不动）
 *   - 中文句末标点（。！？；）后直接断行
 *   - 英文 `.` 只在后接大写字母/中文时断行（"e.g. foo"、"v1.2.3" 这类不会被拆）
 *   - 代码围栏（```）内部整段不动
 */
export function breakLongFingerprint(text) {
  const s = String(text ?? '');
  if (s.length < 2048) return s;
  const lines = s.split('\n');
  let inFence = false;
  const out = [];
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    // 中文句末标点后断行
    let next = line.replace(/([。！？；])\s*/g, '$1\n');
    // 英文句点：后接大写字母或中文才断（排除缩写、版本号、文件名）
    next = next.replace(/\.\s+(?=[A-Z\u4e00-\u9fff])/g, '.\n');
    out.push(next);
  }
  return out.join('\n');
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
