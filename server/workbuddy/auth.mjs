// fnOS 版：本机 WorkBuddy 客户端与登录态文件（workbuddy-desktop.info）都不存在，
// 所有「读/写登录态文件、切换账号」的能力已摘除。
//
// 保留同名导出是为了让 wb.mjs / tokenRefresh.mjs 的 import 不断裂。
// detectCurrentAccount 必须返回**对象**而不是 null —— /api/accounts 会读 current.variant，
// 返回 null 会让那里抛 TypeError（2026-10-25 排障结论）。
export function detectCurrentAccount() {
  return {
    variant: 'cn',
    uid: null,
    exists: false,
    authFilePath: null,
    account: null,
    warning: null,
  };
}

/** 写回登录态文件：fnOS 上无此文件，直接跳过 */
export function syncTokensToAuthFile() {
  return { synced: false, reason: 'fnOS 版不维护本机登录态文件' };
}

export function readAuthFile() {
  return null;
}

export function buildAccountObject() {
  return null;
}

export function buildAuthObject() {
  return null;
}

export function switchAccount() {
  throw new Error('fnOS 版没有桌面客户端，不支持切换本机登录态');
}

export function importLocalAccount() {
  throw new Error('fnOS 版没有桌面客户端，无法导入本机登录态');
}

export function deleteAccount() {
  return { ok: false, message: 'fnOS 版不支持删除本机登录态' };
}

export function updateAccountDisplay() {
  return { ok: false };
}
