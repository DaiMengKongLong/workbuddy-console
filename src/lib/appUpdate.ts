/**
 * 「检查更新」结果的前端广播。
 *
 * 为什么需要它：设置页里点「检查更新」会强制打一次 GitHub 接口，结果只落到设置页自己的
 * state；而左下角的版本区是**常驻组件**，有它自己的取数节奏。两条链路各存一份，
 * 就会出现「设置页已经显示『发现新版本』，左下角却还是没按钮」的割裂
 * （2026-10-18 用户反馈，当时装的是 v0.2.8：那份代码只在本组件挂载时查一次，
 * 界面上不做强制刷新就永远看不到按钮）。
 *
 * 所以检查完就把结果广播一次，常驻组件直接复用——点完马上有反应，不用等轮询。
 */
import type { AppUpdateInfo } from './types';

const UPDATE_CHECKED_EVENT = 'wb:update-checked';

/** 广播一次最新的更新检查结果（页面 → 常驻组件） */
export function emitUpdateChecked(info: AppUpdateInfo) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<AppUpdateInfo>(UPDATE_CHECKED_EVENT, { detail: info }));
}

/** 订阅广播，返回取消订阅函数 */
export function onUpdateChecked(cb: (info: AppUpdateInfo) => void) {
  if (typeof window === 'undefined') return () => {};
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<AppUpdateInfo>).detail;
    if (detail) cb(detail);
  };
  window.addEventListener(UPDATE_CHECKED_EVENT, handler);
  return () => window.removeEventListener(UPDATE_CHECKED_EVENT, handler);
}
