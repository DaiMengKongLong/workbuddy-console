/**
 * Key 探测语义回归测试（离线，fetch 打桩，不联网）。
 *
 * 守的是 2026-10-19 的真实用户事故：魔搭（ModelScope）添加 Key 连点 6 次才成功，
 * 前 5 次都报「Key 无效：400」。原因不是 Key 坏了，而是：
 *   1. 魔搭模型列表公开 → 校验走 /chat/completions 探测；
 *   2. 探测模型取列表**首项**，首项不一定能跑 chat，上游回 400；
 *   3. 旧代码把 400 当成"校验失败" → /api/keys 直接返回「Key 无效」。
 *
 * 现在的判据：
 *   - 401/403 = Key 无效（决定性）
 *   - 200/429 = 鉴权通过
 *   - 404 且正文含 model = 鉴权通过（只是模型不存在）
 *   - 400 = 鉴权已通过、请求被拒 → 换下一个探测模型；全部被拒则**放行**并带 warn
 *   - 400 且正文明确是 invalid api key / unauthorized token → 仍判无效
 *
 * 运行：node scripts/test-key-probe.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-keyprobe-'));
process.env.FREE_TOKEN_CONFIG_DIR = path.join(tmp, 'config');
process.env.WB_SWITCH_HOME = path.join(tmp, 'wb-switch');
fs.mkdirSync(process.env.FREE_TOKEN_CONFIG_DIR, { recursive: true });
fs.mkdirSync(process.env.WB_SWITCH_HOME, { recursive: true });

// 出站必须走 fetch 桩：清代理环境变量，并在调用时传 systemProxy:false 跳过系统代理探测
for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
  delete process.env[k];
}

const { getProvider } = await import('../server/providers/registry.mjs');
const NET = { systemProxy: false };

let pass = 0;
let fail = 0;
const failures = [];
function check(label, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    const detail = extra === undefined ? '' : ` → ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`;
    failures.push(label + detail);
    console.log(`  ✗ ${label}${detail}`);
  }
}

const jsonRes = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** 当前场景的模型列表与 chat 行为 */
let listIds = ['deepseek-ai/DeepSeek-V4-Flash-0731', 'Qwen/Qwen3.5-27B', 'ZhipuAI/GLM-5.2'];
let chatBehavior = () => jsonRes({ error: { message: 'unset' } }, 200);
let chatCalls = [];

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.endsWith('/models')) {
    return jsonRes({ object: 'list', data: listIds.map((id) => ({ id, object: 'model' })) });
  }
  if (u.endsWith('/chat/completions')) {
    const body = JSON.parse(opts.body || '{}');
    chatCalls.push(body.model);
    return chatBehavior(body, opts);
  }
  return jsonRes({ error: { message: `unexpected ${u}` } }, 404);
};

const modelscope = getProvider('modelscope');
const reset = (behavior) => {
  chatBehavior = behavior;
  chatCalls = [];
};

console.log('\n[1] 401 → Key 无效（决定性，且不再尝试其它探测模型）');
reset(() => jsonRes({ error: { message: 'Authentication failed, please make sure that a valid ModelScope token is supplied.' } }, 401));
{
  const r = await modelscope.testKey('ms-bad', NET);
  check('401 判为无效', r.ok === false && r.invalid === true, r);
  check('401 只探测一次就收手', chatCalls.length === 1, `calls=${chatCalls.length}`);
}

console.log('\n[2] 200 → 有效');
reset(() => jsonRes({ id: 'chatcmpl-1', choices: [] }, 200));
{
  const r = await modelscope.testKey('ms-good', NET);
  check('200 判为有效', r.ok === true && !r.warn, r);
  check('返回生效节点 baseUrl', r.baseUrl === modelscope.baseUrl, r.baseUrl);
}

console.log('\n[3] 429（限速）→ 鉴权通过');
reset(() => jsonRes({ error: { message: 'rate limit exceeded' } }, 429));
{
  const r = await modelscope.testKey('ms-slow', NET);
  check('429 不算 Key 无效', r.ok === true, r);
}

console.log('\n[4] 首项模型 400、第二个模型 200 → 有效（本次事故的正面用例）');
listIds = ['deepseek-ai/DeepSeek-V4-Flash-0731', 'Qwen/Qwen3.5-27B', 'ZhipuAI/GLM-5.2'];
reset((body) => {
  if (body.model === 'deepseek-ai/DeepSeek-V4-Flash-0731') {
    return jsonRes({ error: { message: 'Model not supported for chat inference' } }, 400);
  }
  return jsonRes({ id: 'chatcmpl-2', choices: [] }, 200);
});
{
  const r = await modelscope.testKey('ms-real', NET);
  check('400 后自动换模型并最终成功', r.ok === true && !r.warn, r);
  check('按顺序试了前两个模型', chatCalls.length === 2, chatCalls);
}

console.log('\n[5] 全部模型都 400 → 放行 + warn（绝不报"Key 无效"）');
reset(() => jsonRes({ error: { message: 'Model not supported for chat inference' } }, 400));
{
  const r = await modelscope.testKey('ms-ok', NET);
  check('全部 400 仍判有效', r.ok === true, r);
  check('带 warn 说明探测被拒', typeof r.warn === 'string' && r.warn.length > 0, r.warn);
  check('warn 明说不代表 Key 无效', /不代表 Key 无效/.test(r.warn || ''), r.warn);
  check('最多只试 3 个模型（不打爆上游）', chatCalls.length <= 3, chatCalls);
}

console.log('\n[6] 400 但正文是鉴权错误 → 仍判无效（别放过真·坏 Key）');
reset(() => jsonRes({ error: { message: 'invalid api key provided' } }, 400));
{
  const r = await modelscope.testKey('ms-lying', NET);
  check('伪 400 鉴权错误判为无效', r.ok === false && r.invalid === true, r);
}

console.log('\n[7] 404 且正文含 model → 鉴权通过');
reset((body) => {
  if (body.model === 'deepseek-ai/DeepSeek-V4-Flash-0731') return jsonRes({ error: { message: 'model not exist' } }, 404);
  return jsonRes({ id: 'chatcmpl-3', choices: [] }, 200);
});
{
  const r = await modelscope.testKey('ms-404', NET);
  check('404 model 视为鉴权通过', r.ok === true, r);
}

console.log('\n[8] 模型列表为空 → 明确报错而不是瞎判无效');
listIds = [];
reset(() => jsonRes({ id: 'x' }, 200));
{
  const r = await modelscope.testKey('ms-empty', NET);
  check('拿不到探测模型时给出可读错误', r.ok === false && /无法确定探测模型/.test(r.error || ''), r);
}

console.log('\n[9] 400 的报错正文要带到提示里（便于用户自查）');
listIds = ['m1'];
reset(() => jsonRes({ error: { message: 'Model not supported for chat inference' } }, 400));
{
  const r = await modelscope.testKey('ms-x', NET);
  check('warn 里带上平台原文', /Model not supported/.test(r.warn || ''), r.warn);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('失败项：\n' + failures.map((f) => '  - ' + f).join('\n'));
  process.exit(1);
}
