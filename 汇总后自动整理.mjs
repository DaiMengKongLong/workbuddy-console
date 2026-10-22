#!/usr/bin/env node
// 汇总后自动清理：先归档到 D 盘并校验，通过后再删本地
// 由 /api/sessions/sync-all 成功后触发（见 server/index.mjs），也可手动执行
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
// 安装版脚本位于 Program Files 下的 resources/cleanup（只读），日志必须写到用户目录；
// 与归档脚本的状态文件、以及本工具其它备份同在 ~/.wb-switch，便于统一排查
const HOME = process.env.USERPROFILE || process.env.HOME;
const LOG_DIR = path.join(HOME, '.wb-switch');
const LOG = path.join(LOG_DIR, 'cleanup.log');
const log = (m) => {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG, `[${new Date().toLocaleString('zh-CN')}] ${m}\n`);
  } catch {
    /* 日志写不进去不能影响清理主流程 */
  }
};

const run = args => spawnSync(NODE, [path.join(DIR, '归档并清理.mjs'), ...args], { encoding: 'utf8', cwd: DIR, maxBuffer: 1 << 28 });

const before = spawnSync(NODE, ['-e', "const s=require('fs').statfsSync('C:/');console.log(((s.bavail*s.bsize)/1073741824).toFixed(2))"], { encoding: 'utf8' }).stdout?.trim();

// 1) 先修重复：同 cwd+标题+创建时间、内容重合 ≥85% 的会话合并成一份
const d = spawnSync(NODE, [path.join(DIR, '重复对话合并.mjs'), '--apply'], { encoding: 'utf8', cwd: DIR, maxBuffer: 1 << 28 });
const dedupeLine = (d.stdout || '').trim().split('\n').pop();

const a = run(['--archive']);
if (a.status !== 0) { log(`归档失败，跳过删除 | 去重: ${dedupeLine} | ` + (a.stdout || '').trim().slice(-300) + (a.stderr || '').trim().slice(-300)); process.exit(1); }

const p = run(['--purge']);
const after = spawnSync(NODE, ['-e', "const s=require('fs').statfsSync('C:/');console.log(((s.bavail*s.bsize)/1073741824).toFixed(2))"], { encoding: 'utf8' }).stdout?.trim();

log(`去重+归档+清理完成 | C盘可用 ${before}GB → ${after}GB | ${dedupeLine} | ${(p.stdout || '').trim().split('\n').pop()}`);
