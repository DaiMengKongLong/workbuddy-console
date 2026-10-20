import { defineOpenAIPlatform } from './genericOpenAI.mjs';

/**
 * 魔搭 ModelScope API-Inference（https://modelscope.cn）
 * 模型列表公开；每模型每日 2000 次免费调用，需在魔搭绑定阿里云账号后创建 SDK Token（ms- 开头）。
 */
export const platform = defineOpenAIPlatform({
  id: 'modelscope',
  name: 'ModelScope 魔搭',
  site: 'https://modelscope.cn',
  keyUrl: 'https://modelscope.cn/my/myaccesstoken',
  baseUrl: 'https://api-inference.modelscope.cn/v1',
  modelsPublic: true,
  isFree: true,
  keyPlaceholder: 'ms-…',
  keyFormat: /^ms-[A-Za-z0-9-]+$/,
  note:
    '每模型每日 2000 次免费调用。注意：必须先绑定阿里云账号（modelscope.cn → 头像 → 账号设置 → 账号绑定），否则调用一律 401；绑定后无需更换 Token。' +
    '添加 Key 时若提示 HTTP 400，那是探测请求被模型侧拒绝，不是 Key 无效（真失效的 Key 一律返回 401）——工具会自动换几个模型重试。',
});
