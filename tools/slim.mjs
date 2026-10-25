// 一次性"减法"脚本：把上游源码里 fnOS 用不到的能力摘掉
// 用法：node tools/slim.mjs（重复执行幂等）
//
// 两条摘除路径：
//   A. 顶层路由块（路径行紧跟 `app.xxx(`）—— 整块删除；
//   B. 大块内部的 if 分支（/api/accounts 那种一个 handler 处理多条子路径）——
//      改成直接返回 410，避免破坏外层结构。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = path.join(ROOT, 'server', 'index.mjs');

const GONE = 'fnOS 版已移除该能力（依赖本机 WorkBuddy 桌面客户端）';
const GONE_MSG = GONE;

const DROP_ROUTES = [
  '/api/workbuddy/status',
  '/api/workbuddy/loaded',
  '/api/workbuddy/load',
  '/api/workbuddy/remove',
  '/api/workbuddy/restart',
  '/api/workbuddy/stop',
  '/api/workbuddy/detect',
  '/api/workbuddy/permissions',
  '/api/workbuddy/backups',
  '/api/workbuddy/backups/restore',
  '/api/workbuddy/backups/clean',
  '/api/workbuddy/backups/:name',
  '/api/stats',
  '/api/accounts/switch',
  '/api/accounts/import',
  '/api/sessions',
  '/api/sessions/copy',
  '/api/sessions/sync-all',
  '/api/sessions/move',
  '/api/sessions/dedupe',
  '/api/diag/tail',
];

const DROP_IMPORTS = [
  './targets/workbuddy.mjs',
  './stats/workbuddyStats.mjs',
  './workbuddy/diagnostics.mjs',
  './workbuddy/backups.mjs',
  './workbuddy/sessions.mjs',
];

let lines = fs.readFileSync(INDEX, 'utf8').split('\n');
const dead = new Set();
const inline = [];

const isRouteHead = (l) => /^app\.(get|post|put|delete|patch)\($/.test((l || '').trim());

function mark(s, e) {
  for (let i = s; i <= e && i < lines.length; i++) dead.add(i);
  if (lines[e + 1] !== undefined && lines[e + 1].trim() === '') dead.add(e + 1);
}

let blockRemoved = 0;
for (const p of DROP_ROUTES) {
  const i = lines.findIndex((l) => l.includes(`'${p}'`));
  if (i < 0) continue;
  // 只有"路径行紧跟在 app.xxx( 之后"才是可整块删除的顶层路由
  if (isRouteHead(lines[i - 1])) {
    const s = i - 1;
    let e = s;
    while (e < lines.length && !(/^\s*\}?\);\s*$/.test(lines[e]) && (lines[e + 1] === undefined || lines[e + 1].trim() === ''))) e++;
    mark(s, e);
    blockRemoved++;
  } else {
    inline.push({ p, i });
  }
}

let importRemoved = 0;
for (const m of DROP_IMPORTS) {
  const i = lines.findIndex((l) => l.includes(`from '${m}'`));
  if (i < 0) continue;
  let s = i;
  while (s > 0 && !/^import /.test(lines[s])) s--;
  let e = s;
  while (e < lines.length && !/;\s*$/.test(lines[e])) e++;
  mark(s, e);
  importRemoved++;
}

// 大块内部子路径：在该分支处直接返回 410（不动外层结构）
lines = lines.filter((_, i) => !dead.has(i));
for (const item of inline.slice().reverse()) {
  const idx = lines.findIndex((l, k) => k > 0 && l.includes(`'${item.p}'`));
  if (idx < 0) continue;
  const indent = (lines[idx].match(/^\s*/) || [''])[0];
  lines.splice(idx + 1, 0, `${indent}return res.status(410).json({ ok: false, message: GONE_MSG });`);
}

fs.writeFileSync(INDEX, lines.join('\n'));
console.log(`整块删除：路由 ${blockRemoved} / import ${importRemoved}；块内分支 ${inline.length} 条改为 410`);
