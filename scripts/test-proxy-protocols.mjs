/**
 * 反向代理「多协议」协议级测试 —— 不联网、不碰真实账号。
 *
 * 覆盖两件事：
 * A. 四个协议适配器的纯函数与流式管道（OpenAI / Anthropic / Responses / Gemini），
 *    断言"入站转换"与"出站形状"（尤其流式终止事件、工具调用），
 *    以及 system 文本的风控净化（上游 code 11128，见 sanitize.mjs）。
 * B. 路由与鉴权冒烟：把 registerProxyRoutes 挂在临时 Express 上，验证
 *    - /v1beta 前缀不会与 /v1 混淆，Gemini 带冒号方法后缀的正则路由能匹配
 *    - 三种鉴权头（Bearer / x-api-key / x-goog-api-key）都生效
 *    - 关闭时 403、无账号时 503、未知方法后缀 404
 *
 * 隔离：FREE_TOKEN_CONFIG_DIR（配置）/ WB_SWITCH_HOME（账号库）都指向临时目录。
 * 运行：node scripts/test-proxy-protocols.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

/* ---------- 隔离环境（必须在 import 业务模块之前设置） ---------- */
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-proxy-cfg-'));
const acctDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-proxy-acct-'));
process.env.FREE_TOKEN_CONFIG_DIR = cfgDir;
process.env.WB_SWITCH_HOME = acctDir;

const writeConfig = (proxy) =>
  fs.writeFileSync(
    path.join(cfgDir, 'config.json'),
    JSON.stringify({ version: 1, keys: [], settings: {}, proxy })
  );
fs.writeFileSync(path.join(acctDir, 'accounts.json'), JSON.stringify({ accounts: [] }));

const out = (s) => fs.writeSync(1, s + '\n');
let pass = 0;
let total = 0;
const ok = (cond, msg) => {
  total++;
  out(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (cond) pass++;
};

/* ---------- 适配器 ---------- */
const { geminiToOpenAi, buildGeminiResponse, geminiModelsPayload, pipeGeminiStream } = await import(
  '../server/proxy/gemini.mjs'
);
const { anthropicToOpenAi, buildAnthropicMessage, pipeAnthropicStream } = await import('../server/proxy/anthropic.mjs');
const { responsesToOpenAi, buildResponsesReply, pipeResponsesStream } = await import('../server/proxy/responses.mjs');

/** 收集 SSE 输出的假 res */
function fakeRes() {
  const chunks = [];
  return {
    chunks,
    text: () => chunks.join(''),
    write: (s) => {
      chunks.push(String(s));
      return true;
    },
    end: () => {},
    writableEnded: false,
  };
}
/** 把 SSE 文本拆成事件对象数组 */
const parseSse = (text) =>
  text
    .split('\n\n')
    .map((b) => b.trim())
    .filter(Boolean)
    .map((block) => {
      const ev = { event: null, data: null };
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) ev.event = line.slice(6).trim();
        else if (line.startsWith('data:')) {
          try {
            ev.data = JSON.parse(line.slice(5).trim());
          } catch {
            ev.data = line.slice(5).trim();
          }
        }
      }
      return ev;
    });

/* ---------------- A1. Gemini 入站转换 ---------------- */
{
  const openai = geminiToOpenAi(
    {
      systemInstruction: { parts: [{ text: '你是助手' }] },
      contents: [
        { role: 'user', parts: [{ text: '今天北京天气？' }] },
        {
          role: 'model',
          parts: [{ functionCall: { name: 'get_weather', args: { city: '北京' } } }],
        },
        {
          role: 'user',
          parts: [{ functionResponse: { name: 'get_weather', response: { temp: 21 } } }],
        },
      ],
      tools: [{ functionDeclarations: [{ name: 'get_weather', description: '查天气', parameters: { type: 'object' } }] }],
      toolConfig: { functionCallingConfig: { mode: 'ANY' } },
      generationConfig: { temperature: 0.3, topP: 0.9, maxOutputTokens: 256, stopSequences: ['END'] },
    },
    'glm-5.3-flash'
  );

  ok(openai.model === 'glm-5.3-flash', 'Gemini：模型取自 URL 路径');
  ok(openai.messages[0].role === 'system' && openai.messages[0].content === '你是助手', 'Gemini：systemInstruction → system 消息');
  ok(openai.messages[1].role === 'user' && openai.messages[1].content === '今天北京天气？', 'Gemini：user 文本');
  ok(openai.messages[2].role === 'assistant' && openai.messages[2].tool_calls?.length === 1, 'Gemini：model.role → assistant + tool_calls');
  const callId = openai.messages[2].tool_calls[0].id;
  ok(
    openai.messages[2].tool_calls[0].function.name === 'get_weather' &&
      JSON.parse(openai.messages[2].tool_calls[0].function.arguments).city === '北京',
    'Gemini：functionCall.args 序列化进 arguments'
  );
  ok(
    openai.messages[3].role === 'tool' && openai.messages[3].tool_call_id === callId,
    'Gemini：functionResponse 合成 tool_call_id 与 functionCall 对齐'
  );
  ok(openai.tools?.[0]?.function?.name === 'get_weather', 'Gemini：functionDeclarations → OpenAI tools');
  ok(openai.tool_choice === 'required', 'Gemini：toolConfig ANY → required');
  ok(openai.temperature === 0.3 && openai.top_p === 0.9 && openai.max_tokens === 256, 'Gemini：generationConfig 采样参数映射');
  ok(Array.isArray(openai.stop) && openai.stop[0] === 'END', 'Gemini：stopSequences → stop');
}

/* ---------------- A2. Gemini 出站（非流式 + 模型清单） ---------------- */
{
  const reply = buildGeminiResponse(
    {
      model: 'glm-5.3-flash',
      choices: [
        {
          message: {
            content: '21 度',
            tool_calls: [{ id: 'call_1', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    },
    'glm-5.3-flash'
  );
  ok(reply.candidates[0].content.role === 'model', 'Gemini：出站 role = model');
  ok(reply.candidates[0].content.parts[0].text === '21 度', 'Gemini：text part');
  ok(reply.candidates[0].content.parts[1].functionCall.args.city === '北京', 'Gemini：functionCall.args 还原为对象');
  ok(reply.candidates[0].finishReason === 'STOP', 'Gemini：tool_calls → finishReason STOP');
  ok(reply.usageMetadata.totalTokenCount === 18, 'Gemini：usageMetadata 汇总正确');

  const list = geminiModelsPayload(['glm-5.3-flash', 'claude-4.5']);
  ok(list.models[0].name === 'models/glm-5.3-flash', 'Gemini：模型清单 name 带 models/ 前缀');
  ok(list.models[0].supportedGenerationMethods.includes('generateContent'), 'Gemini：模型清单声明支持 generateContent');
}

/* ---------------- A3. Gemini 流式管道 ---------------- */
{
  const frames = (async function* () {
    yield { type: 'delta', model: 'glm-5.3-flash', content: '你好', toolCalls: [], finishReason: null, usage: null };
    yield { type: 'delta', model: null, content: '，世界', toolCalls: [], finishReason: null, usage: null };
    yield {
      type: 'delta',
      model: null,
      content: '',
      toolCalls: [{ index: 0, id: 'call_a', function: { name: 'get_weather', arguments: '{"city"' } }],
      finishReason: null,
      usage: null,
    };
    yield {
      type: 'delta',
      model: null,
      content: '',
      toolCalls: [{ index: 0, function: { arguments: ':"北京"}' } }],
      finishReason: 'tool_calls',
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    };
    yield { type: 'done' };
  })();

  const res = fakeRes();
  await pipeGeminiStream(frames, res, { model: 'glm-5.3-flash' });
  const events = parseSse(res.text());
  const datas = events.map((e) => e.data).filter(Boolean);

  ok(!events.some((e) => e.event), 'Gemini 流：chunk 无 event 名（裸 data:）');
  ok(datas[0].candidates[0].content.parts[0].text === '你好', 'Gemini 流：首个文本 delta');
  ok(datas[1].candidates[0].content.parts[0].text === '，世界', 'Gemini 流：第二个文本 delta');
  const fc = datas.find((d) => d.candidates?.[0]?.content?.parts?.[0]?.functionCall);
  ok(fc && fc.candidates[0].content.parts[0].functionCall.args.city === '北京', 'Gemini 流：分片参数拼成完整 functionCall');
  const last = datas[datas.length - 1];
  ok(last.candidates[0].finishReason === 'STOP', 'Gemini 流：收尾 chunk 带 finishReason');
  ok(last.usageMetadata?.totalTokenCount === 8, 'Gemini 流：收尾 chunk 带 usageMetadata');
}

/* ---------------- A4. Anthropic 管道回归 ---------------- */
{
  const openai = anthropicToOpenAi({
    model: 'glm-5.3-flash',
    system: 'x-anthropic-billing-header: cc_version=2.1.205;\n你是 Claude Code 助手',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    max_tokens: 128,
  });
  ok(!/x-anthropic-billing-header/.test(openai.messages[0].content), 'Anthropic：剔除计费头（上游会 400）');
  ok(openai.messages[0].content.includes('助手'), 'Anthropic：system 保留正文');
  ok(openai.max_tokens === 128, 'Anthropic：max_tokens 透传');

  const msg = buildAnthropicMessage({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }, 'glm-5.3-flash');
  ok(msg.type === 'message' && msg.content[0].text === 'ok' && msg.stop_reason === 'end_turn', 'Anthropic：非流式响应形状');

  const frames = (async function* () {
    yield { type: 'delta', model: 'm', content: '你', toolCalls: [], finishReason: null, usage: null };
    yield { type: 'delta', model: null, content: '好', toolCalls: [], finishReason: 'stop', usage: { completion_tokens: 2 } };
    yield { type: 'done' };
  })();
  const res = fakeRes();
  await pipeAnthropicStream(frames, res, { model: 'glm-5.3-flash' });
  const seq = parseSse(res.text()).map((e) => e.event);
  ok(seq[0] === 'message_start', 'Anthropic 流：以 message_start 开头');
  ok(seq.includes('content_block_delta'), 'Anthropic 流：含 content_block_delta');
  ok(seq[seq.length - 1] === 'message_stop', 'Anthropic 流：以 message_stop 收尾');
}

/* ---------------- A5. Responses 管道回归 ---------------- */
{
  const openai = responsesToOpenAi({
    model: 'glm-5.3-flash',
    instructions: '你是 Codex',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
  });
  ok(openai.messages[0].role === 'system', 'Responses：instructions → system 消息');
  ok(openai.messages[1].content === 'hi', 'Responses：input_text 抽取');

  const frames = (async function* () {
    yield { type: 'delta', model: 'm', content: 'hi', toolCalls: [], finishReason: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1 } };
    yield { type: 'done' };
  })();
  const res = fakeRes();
  await pipeResponsesStream(frames, res, { model: 'glm-5.3-flash' });
  const seq = parseSse(res.text()).map((e) => e.event);
  ok(seq[0] === 'response.created', 'Responses 流：以 response.created 开头');
  ok(seq[seq.length - 1] === 'response.completed', 'Responses 流：必须以 response.completed 收尾（否则 Codex 判流中断）');
}

/* ---------------- A6. 上游风控净化（code 11128） ---------------- */
{
  const { sanitizeSystemText, neutralizeAgentFingerprint, stripInternalHeaders, sanitizeMessages } = await import(
    '../server/proxy/sanitize.mjs'
  );

  // 实证过的真实触发文本：codex 0.139.0 的 base_instructions 前 185 字。
  // 前 184 字（少末尾句号）上游放行、第 185 字起被 400 code 11128 拦截，
  // 说明判据是「连续逐字文本命中竞品系统提示词」。本用例锁住"净化后不再含指纹词"。
  const TRIGGER =
    'You are a coding agent running in the Codex CLI, a terminal-based coding assistant. ' +
    'Codex CLI is an open source project led by OpenAI. ' +
    'You are expected to be precise, safe, and helpful.';

  const cleaned = sanitizeSystemText(TRIGGER);
  ok(!/Codex|OpenAI/i.test(cleaned), '净化：触发前缀里已无 Codex / OpenAI 字样');
  ok(cleaned.startsWith('You are a coding agent running in the assistant CLI'), '净化：替换为中性词且句中不误补大写');
  ok(cleaned.includes('Assistant CLI is an open source project led by the vendor.'), '净化：句首补大写、句中保持小写');
  ok(cleaned.length >= TRIGGER.length * 0.7, '净化：只做词级替换，不截断正文');

  ok(neutralizeAgentFingerprint('by openai') === 'by the vendor', '净化：小写 brand 同样命中，句中不改大写');
  ok(neutralizeAgentFingerprint('OpenAI leads') === 'The vendor leads', '净化：句首补首字母大写');
  ok(neutralizeAgentFingerprint('x. chatgpt 说') === 'x. The chat assistant 说', '净化：句末标点后算句首');
  ok(neutralizeAgentFingerprint('普通中文文本') === '普通中文文本', '净化：无指纹词时原样返回');
  ok(stripInternalHeaders('x-anthropic-billing-header: a=1;\n正文') === '正文', '净化：剔除 x-*-header 元数据行');

  // 四条入站路径的 system 级文本都必须被净化
  const anthropic = anthropicToOpenAi({ system: TRIGGER, messages: [{ role: 'user', content: 'hi' }] });
  ok(!/Codex|OpenAI/i.test(anthropic.messages[0].content), '净化：Anthropic system 被净化');

  const responses = responsesToOpenAi({
    instructions: TRIGGER,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Codex CLI 和 OpenAI 是什么' }] }],
  });
  ok(!/Codex|OpenAI/i.test(responses.messages[0].content), '净化：Responses instructions 被净化');
  ok(responses.messages[1].content === 'Codex CLI 和 OpenAI 是什么', '净化：用户消息原样透传（问 OpenAI 不该被改写）');

  const gemini = geminiToOpenAi(
    { systemInstruction: { parts: [{ text: TRIGGER }] }, contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    'glm-5.3-flash'
  );
  ok(!/Codex|OpenAI/i.test(gemini.messages[0].content), '净化：Gemini systemInstruction 被净化');

  // OpenAI 直通路径：buildUpstreamBody 出口调用的就是 sanitizeMessages
  const { buildUpstreamBody } = await import('../server/proxy/index.mjs');
  const passthrough = buildUpstreamBody({
    model: 'glm-5.3-flash',
    messages: [
      { role: 'system', content: TRIGGER },
      { role: 'user', content: 'OpenAI 是什么' },
    ],
  });
  ok(!/Codex|OpenAI/i.test(passthrough.messages[0].content), '净化：OpenAI 直通路径 role:"system" 被净化');
  ok(passthrough.messages[1].content === 'OpenAI 是什么', '净化：OpenAI 直通路径不动 user 消息');
  ok(passthrough.model === 'glm-5.3-flash' && !('foo' in passthrough), '净化：白名单仍生效（未知字段被丢弃）');

  const devMsgs = [{ role: 'developer', content: 'see OpenAI docs' }];
  sanitizeMessages(devMsgs);
  ok(devMsgs[0].content === 'see the vendor docs', '净化：developer 条目同样处理');
}

/* ---------------- B0. 上游错误简报（把一坨 JSON 压成一行人话） ---------------- */
{
  const { briefUpstream, briefErrors } = await import('../server/proxy/index.mjs');
  const raw =
    '时光悠悠: HTTP 400: {"code":11128,"msg":"Illegal API invocation from an unapproved channel",' +
    '"requestId":"de10c63a7fe09264","displayMsg":{"en":"Request blocked","zh":"请求被拦截，请重新发送"}}';
  const b = briefUpstream(raw);
  ok(b.startsWith('时光悠悠: ') && b.includes('11128') && b.includes('渠道风控'), `简报：保留账号名并给出 11128 中文含义（${b}）`);
  ok(!b.includes('requestId'), '简报：丢掉 requestId 之类的噪音');
  ok(
    briefUpstream('laopo的手机: HTTP 400: {"code":11102,"msg":"model [gpt-4o] service info not found"}').includes('模型不可用'),
    '简报：11102 → 模型不可用（提示换模型）'
  );
  ok(briefUpstream('账号: 连接超时').includes('连接超时'), '简报：非上游 JSON 的错误原样保留');
  ok(briefErrors(['a: {"code":11128}', 'b: {"code":11128}'], 1).split('|').length === 1, '简报：多账号列表按 n 截断');
}

/* ---------------- B. 路由与鉴权冒烟 ---------------- */
{
  const express = (await import('express')).default;
  const { registerProxyRoutes } = await import('../server/proxy/index.mjs');

  const app = express();
  // 与 server/index.mjs 完全一致的解析器挂载顺序
  app.use('/v1', express.json({ limit: '12mb' }));
  app.use('/v1beta', express.json({ limit: '12mb' }));
  app.use(express.json({ limit: '1mb' }));

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  registerProxyRoutes(app, { port });
  const base = `http://127.0.0.1:${port}`;
  const KEY = 'sk-wb-testkey';

  const call = async (method, p, { key, rawKey, goog, apiKey, body } = {}) => {
    const headers = { 'content-type': 'application/json' };
    if (key) headers.authorization = `Bearer ${key}`;
    if (rawKey) headers.authorization = rawKey; // 不带 Bearer 前缀
    if (goog) headers['x-goog-api-key'] = goog;
    if (apiKey) headers['x-api-key'] = apiKey;
    const r = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let json = null;
    try {
      json = await r.json();
    } catch {
      /* 非 JSON */
    }
    return { status: r.status, json };
  };

  // —— 关闭态：所有端点 403 ——
  writeConfig({ enabled: false, apiKey: KEY, accountIds: null });
  const g1 = await call('POST', '/v1beta/models/glm-5.3-flash:generateContent', { goog: KEY, body: { contents: [] } });
  ok(g1.status === 403 && g1.json?.error?.status === 'PERMISSION_DENIED', `Gemini 路由匹配 + 关闭态 403（status=${g1.status}）`);
  const g2 = await call('POST', '/v1beta/models/glm-5.3-flash:streamGenerateContent?alt=sse', { goog: KEY, body: { contents: [] } });
  ok(g2.status === 403, 'Gemini 流式端点命中（含 ?alt=sse 查询串）');
  const g3 = await call('GET', '/v1beta/models', { goog: KEY });
  ok(g3.status === 403 && !!g3.json?.error, 'Gemini 模型清单端点命中');
  ok((await call('POST', '/v1/chat/completions', { body: {} })).status === 403, 'OpenAI 端点仍走 /v1（未被 /v1beta 影响）');
  ok((await call('POST', '/v1beta/models/glm-5.3-flash:bogusMethod', { goog: KEY, body: {} })).status === 404, 'Gemini 未知方法后缀 → 404（正则路由不过度匹配）');

  // —— 开启态 + 空账号池：鉴权生效、然后 503 ——
  writeConfig({ enabled: true, apiKey: KEY, accountIds: [] });
  const badKey = await call('POST', '/v1beta/models/glm-5.3-flash:generateContent', { goog: 'wrong', body: { contents: [] } });
  ok(badKey.status === 401 && badKey.json?.error?.status === 'UNAUTHENTICATED', 'Gemini：x-goog-api-key 错误 → 401');
  const noAuth = await call('POST', '/v1beta/models/glm-5.3-flash:generateContent', { body: { contents: [] } });
  ok(noAuth.status === 401, 'Gemini：缺 Key → 401');
  const goodKey = await call('POST', '/v1beta/models/glm-5.3-flash:generateContent', { goog: KEY, body: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] } });
  ok(goodKey.status === 503, 'Gemini：鉴权通过后因账号池为空 → 503（证明 Key 与路由链路通了）');
  const slashModel = await call('POST', '/v1beta/models/google%2Fgemini-3-pro:generateContent', { goog: KEY, body: { contents: [] } });
  ok(slashModel.status === 503, 'Gemini：模型名含 `/`（编码后）仍能匹配路由');

  const count = await call('POST', '/v1beta/models/glm-5.3-flash:countTokens', {
    goog: KEY,
    body: { contents: [{ role: 'user', parts: [{ text: '一二三四五六七八' }] }] },
  });
  ok(count.status === 200 && count.json?.totalTokens === 2, 'Gemini：countTokens 本地估算返回 totalTokens');

  const models = await call('GET', '/v1beta/models', { goog: KEY });
  ok(models.status === 200 && Array.isArray(models.json?.models), 'Gemini：模型清单返回 { models: [] }');

  // 三种鉴权头互认（OpenAI 端点先校验请求体，故给合法 body）
  const okBody = { model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }] };
  ok((await call('POST', '/v1/chat/completions', { key: KEY, body: okBody })).status === 503, 'OpenAI：Bearer 鉴权');
  ok((await call('POST', '/v1/messages', { apiKey: KEY, body: { messages: [] } })).status === 503, 'Anthropic：x-api-key 鉴权');
  ok((await call('POST', '/v1/responses', { key: KEY, body: { input: [] } })).status === 503, 'Responses：Bearer 鉴权');

  // —— Authorization 不带 Bearer 前缀（少数脚本客户端直接塞 Key） ——
  const bareAuth = await call('POST', '/v1/chat/completions', { rawKey: KEY, body: okBody });
  ok(bareAuth.status === 503, 'OpenAI：Authorization 裸 Key 也认（不走 Bearer 前缀）');

  // —— 被拒绝的请求必须留痕：否则界面「请求日志」一片空白，
  //     用户看到的现象就是「反向代理用不了，却查不到任何线索」 ——
  const wrongKey = await call('POST', '/v1/chat/completions', { key: 'sk-wb-wrong', body: okBody });
  ok(wrongKey.status === 401, 'OpenAI：Key 不对 → 401');
  const logWrong = await call('GET', '/api/proxy/logs');
  const lw = logWrong.json?.logs?.[0];
  ok(lw?.status === 401 && lw?.ok === false, '拒绝留痕：401 也写进请求日志');
  ok(lw?.auth === 'mismatch', `拒绝留痕：能区分「带了但不对」（auth=${lw?.auth}）`);
  ok(typeof lw?.path === 'string' && lw.path.endsWith('/v1/chat/completions'), `拒绝留痕：记下请求路径（${lw?.path}）`);

  const noKey = await call('POST', '/v1/chat/completions', { body: okBody });
  ok(noKey.status === 401, 'OpenAI：没带 Key → 401');
  const lnk = (await call('GET', '/api/proxy/logs')).json?.logs?.[0];
  ok(lnk?.auth === 'absent', `拒绝留痕：能区分「根本没带」（auth=${lnk?.auth}）`);

  server.close();
}

fs.rmSync(cfgDir, { recursive: true, force: true });
fs.rmSync(acctDir, { recursive: true, force: true });
out(`\n${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
