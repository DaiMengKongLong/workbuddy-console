import { defineOpenAIPlatform } from './genericOpenAI.mjs';

/**
 * Agnes AI —— 拆成「中国站」「国际站」两个平台条目（2026-10-17 用户拍板）。
 *
 * ⚠️ 为什么必须拆：中国站（agnes-ai.cn）与国际站（agnes-ai.com）是两套**完全独立**
 * 的账号体系，key 只在签发站点的 API 节点上有效，跨站调用一律 401「无效的令牌」。
 * 平台层虽有 alternateBaseUrls 自动探测，但用户实测一把 key 在全部已知节点都被拒时
 * （2026-10-17），探测无从分辨「站点选错」还是「key 本身无效」。拆成两个入口后：
 * 用户按创建 Key 的站点选择平台，选对站点仍 401 即可确定 key 无效，去官网重建。
 *
 * 节点实测（2026-10-16/17，假 key；代理与直连结果一致）：
 * - api.agnes-ai.cn      /models 需鉴权；chat 401 中文「无效的令牌」→ 中国站节点
 * - apihub.agnes-ai.com  /models 对部分客户端公开（不可用于校验）；chat 401 英文 → 国际站主节点（官方文档唯一权威 Base URL）
 * - apihub.agnes-ai.cn   同上 → 国际站备用节点
 * - api.agnes-ai.com     /v1 404 Resource not found（不是 API 节点，勿再加）
 * 三节点 /chat/completions 的鉴权行为完全一致（无效 key 一律 401）。
 *
 * 共享部分：模型结构（outputKind 推断）、entryUrl（按生效节点拼完整端点）、
 * keyFormat、固定 probeModel（校验走 chat 探测，不依赖 /models 的鉴权公开性）。
 */

/** 两个站点共用的平台配置骨架（site 必须由各条目覆盖为各自官网） */
function agnesPlatform(overrides) {
  return defineOpenAIPlatform({
    site: 'https://www.agnes-ai.com',
    modelsPublic: false,
    isFree: true,
    // 模态从模型 id 前缀推断（agnes-image-* / agnes-video-*）
    outputKind: (m) => (/^agnes-image-/i.test(m.id) ? 'image' : /^agnes-video-/i.test(m.id) ? 'video' : 'text'),
    // 第二参数是该 key 实际生效的节点，必须基于它拼完整端点（不能硬编码域名）
    entryUrl: (model, base) =>
      model.outputKind === 'image'
        ? `${base}/images/generations`
        : model.outputKind === 'video'
          ? `${base}/videos`
          : `${base}/chat/completions`,
    keyFormat: /^[A-Za-z0-9_-]{8,}$/,
    // key 校验统一走 /chat/completions（1 token）：/models 的鉴权公开性各节点
    // 不一致且不稳定，不能作为校验依据。模型下线时 404 按"鉴权通过"处理。
    // ⚠️ probeModel 必须是**本站点真实存在**的模型：探错模型会 503（官方文档：
    // 503 常见原因含"模型名称不正确/发送到错误的模型"），被误判为添加失败。
    // 2026-10-17 实测踩过：中国站模型 id 拿去国际站探测 → 503。
    tutorialUrl: 'https://ima.qq.com/note/share/_A0YMLqK9QmYLZ8UbFZvOg?channel=4',
    ...overrides,
  });
}

/** 中国站：agnes-ai.cn 创建的 Key。id 保持 'agnes'，兼容历史已存数据与已载入条目 */
export const agnesCn = agnesPlatform({
  id: 'agnes',
  name: 'Agnes AI 中国站',
  site: 'https://www.agnes-ai.cn',
  keyUrl: 'https://www.agnes-ai.cn',
  baseUrl: 'https://api.agnes-ai.cn/v1',
  // 来源：中国站节点公开模型列表（2026-10-16 实测）
  probeModel: 'deepseek-ai/DeepSeek-V4-Flash-0731',
  note: '推广期全部模型免费。仅接受在「中国站 agnes-ai.cn」创建的 Key；国际站 Key 请选「Agnes AI 国际站」。图像/视频模型不支持载入 WorkBuddy但可通过mcp调用，参考教程',
});

/** 国际站：agnes-ai.com 创建的 Key。主节点 apihub.agnes-ai.com，不通时自动尝试备用节点 */
export const agnesIntl = agnesPlatform({
  id: 'agnes-intl',
  name: 'Agnes AI 国际站',
  keyUrl: 'https://www.agnes-ai.com',
  baseUrl: 'https://apihub.agnes-ai.com/v1',
  alternateBaseUrls: ['https://apihub.agnes-ai.cn/v1'],
  // 来源：官方 FAQ / Cherry Studio 集成指南 / 快速开始三处示例模型，国际站长期存在
  probeModel: 'agnes-2.5-flash',
  note: '推广期全部模型免费。仅接受在「国际站 agnes-ai.com」创建的 Key；中国站 Key 请选「Agnes AI 中国站」。主节点不通时自动尝试备用节点。图像/视频模型不支持载入 WorkBuddy但可通过mcp调用，参考教程',
});
