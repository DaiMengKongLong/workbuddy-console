import { defineOpenAIPlatform } from './genericOpenAI.mjs';

/**
 * Agnes AI（https://agnes-ai.com，文档 wiki.agnes-ai.com）
 * OpenAI 兼容；推广期文本/图像/视频模型全部免费。
 * 模态从模型 id 前缀推断（agnes-image-* / agnes-video-*）。
 * 载入 WorkBuddy 时 url 写完整端点（与手动配置成功的写法一致），
 * 而不是像 OpenRouter 那样写 base URL。
 */
export const platform = defineOpenAIPlatform({
  id: 'agnes',
  name: 'Agnes AI',
  site: 'https://www.agnes-ai.com',
  keyUrl: 'https://www.agnes-ai.com',
  baseUrl: 'https://api.agnes-ai.cn/v1',
  modelsPublic: false,
  isFree: true,
  outputKind: (m) => (/^agnes-image-/i.test(m.id) ? 'image' : /^agnes-video-/i.test(m.id) ? 'video' : 'text'),
  entryUrl: (model) =>
    model.outputKind === 'image'
      ? 'https://api.agnes-ai.cn/v1/images/generations'
      : model.outputKind === 'video'
        ? 'https://api.agnes-ai.cn/v1/videos'
        : 'https://api.agnes-ai.cn/v1/chat/completions',
  keyFormat: /^[A-Za-z0-9_-]{8,}$/,
  note: '推广期文本/图像/视频模型全部免费；图像/视频模型不支持载入 WorkBuddy但可通过mcp调用，参考教程',
  // 备注末尾的「参考教程」会被渲染成指向这里的外链（见前端 PlatformNote）
  tutorialUrl: 'https://ima.qq.com/note/share/_A0YMLqK9QmYLZ8UbFZvOg?channel=4',
});
