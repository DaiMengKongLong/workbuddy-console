#!/usr/bin/env node
// 归档并清理：先逐文件 gzip 归档到 D 盘（避开 bsdtar 的中文路径问题），校验通过后再删 C 盘
// node 归档并清理.mjs --plan
// node 归档并清理.mjs --archive
// node 归档并清理.mjs --purge
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';

const HOME = process.env.USERPROFILE || process.env.HOME;
const WB = path.join(HOME, '.workbuddy');
const PROJ = path.join(WB, 'projects');
const BLOBS = path.join(WB, 'blobs');
const LOGS = path.join(WB, 'logs');
const MANIFESTS = path.join(WB, 'file-tree-manifests');
const ARCHIVE_DIR = 'D:/WB-archive';
const STAMP = new Date().toISOString().slice(0, 10);
const ROOT_OUT = path.join(ARCHIVE_DIR, `wb-deleted-${STAMP}`);
// 状态文件必须落在可写目录：桌面安装版运行在 Program Files 下的 resources/cleanup，
// 进程工作目录通常无写权限，写到 cwd 会在 --purge 阶段读不到而崩溃
const STATE_DIR = path.join(HOME, '.wb-switch');
const STATE = path.join(STATE_DIR, 'archive-state.json');

const argv = process.argv.slice(2);
const mb = n => (n / 1048576).toFixed(0) + 'MB';

const walk = (dir, filter, out = []) => {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, filter, out);
    else if (!filter || filter(p)) { try { out.push([p, fs.statSync(p).size]); } catch {} }
  }
  return out;
};

function buildPlan() {
  const db = new DatabaseSync(path.join(WB, 'workbuddy.db'), { timeout: 15000 });
  const alive = new Set(db.prepare('SELECT id FROM sessions WHERE deleted_at IS NULL').all().map(r => r.id));
  const all = new Set(db.prepare('SELECT id FROM sessions').all().map(r => r.id));
  db.close();

  const files = walk(PROJ, p => p.endsWith('.jsonl'));
  const dead = [], orphan = [];
  for (const [p, s] of files) {
    const id = path.basename(p, '.jsonl');
    if (!all.has(id)) orphan.push([p, s]);
    else if (!alive.has(id)) dead.push([p, s]);
  }

  const re = /blobs\\\\+([0-9a-f]{2})\\\\+([0-9a-f]{64})/g;
  const refAlive = new Set(), refDead = new Set();
  for (const [p] of files) {
    const id = path.basename(p, '.jsonl');
    const isAlive = alive.has(id), isDead = all.has(id) && !isAlive;
    if (!isAlive && !isDead) continue;
    const txt = fs.readFileSync(p, 'utf8');
    let m; while ((m = re.exec(txt))) (isAlive ? refAlive : refDead).add(m[2]);
    re.lastIndex = 0;
  }
  const blobIdx = new Map();
  for (const e of fs.readdirSync(BLOBS, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(BLOBS, e.name))) {
      const p = path.join(BLOBS, e.name, f);
      blobIdx.set(f.replace(/\.[^.]+$/, ''), [p, fs.statSync(p).size]);
    }
  }
  const deadBlobs = [];
  for (const h of refDead) if (!refAlive.has(h)) { const r = blobIdx.get(h); if (r) deadBlobs.push(r); }

  const cutoff = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
  const oldLogs = [];
  for (const e of fs.readdirSync(LOGS, { withFileTypes: true })) {
    const p = path.join(LOGS, e.name);
    if (e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name) && e.name < cutoff) {
      let s = 0; for (const [, ss] of walk(p)) s += ss; oldLogs.push([p, s]);
    } else if (e.isFile() && e.name.endsWith('.old.log')) { try { oldLogs.push([p, fs.statSync(p).size]); } catch {} }
  }
  // 旧备份：历次合并/清理时挪进来的原文件，仍在 C 盘占地方（排除数据库备份，那个要留）
  const BACKUPS = path.join(HOME, '.wb-switch', 'backups');
  const oldBackups = [];
  const keepBackup = /^(accounts|.*\.db$|.*\.db-wal$|.*\.db-shm$)/i;
  if (fs.existsSync(BACKUPS)) {
    for (const e of fs.readdirSync(BACKUPS, { withFileTypes: true })) {
      const p = path.join(BACKUPS, e.name);
      if (keepBackup.test(e.name)) continue;
      let s = 0;
      if (e.isDirectory()) { for (const [, ss] of walk(p)) s += ss; } else { try { s = fs.statSync(p).size; } catch { s = 0; } }
      if (s > 0) oldBackups.push([p, s]);
    }
  }
  return { dead, orphan, deadBlobs, oldLogs, cache: walk(MANIFESTS), oldBackups };
}

const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const plan = buildPlan();
const sum = a => a.reduce((x, [, s]) => x + s, 0);
const archiveSet = [...plan.dead, ...plan.orphan, ...plan.deadBlobs, ...plan.oldBackups];

console.log('=== 先备份到 D 盘（这些删掉也能找回）===');
console.log(`  已删除对话的分身文件 ${plan.dead.length} 个 ${mb(sum(plan.dead))}`);
console.log(`  没有归属的残留文件     ${plan.orphan.length} 个 ${mb(sum(plan.orphan))}`);
console.log(`  只有它用得到的图片和附件            ${plan.deadBlobs.length} 个 ${mb(sum(plan.deadBlobs))}`);
console.log(`  历次清理留下的旧备份   ${plan.oldBackups.length} 项 ${mb(sum(plan.oldBackups))}`);
console.log(`  归档合计 ${archiveSet.length} 个 / ${mb(sum(archiveSet))}`);
console.log('=== 直接删除（日志和缓存，删了会自动重建）===');
console.log(`  旧日志 ${plan.oldLogs.length} 项 ${mb(sum(plan.oldLogs))}`);
console.log(`  目录缓存 ${plan.cache.length} 个 ${mb(sum(plan.cache))}`);

if (argv.includes('--plan') || argv.length === 0) process.exit(0);

if (argv.includes('--archive')) {
  fs.mkdirSync(ROOT_OUT, { recursive: true });
  // 归档与校验必须用同一套路径推导：oldBackups 在 ~/.wb-switch 下，
  // 曾因校验处误用 path.relative(WB, p) 算出 `..` 前缀，导致永远「缺归档」→ purge 被永久阻断。
  const archiveDestOf = (p) => {
    const r = path.relative(HOME, p);
    return path.join(ROOT_OUT, (r.startsWith('..') ? path.basename(p) : r) + '.gz');
  };
  let done = 0, outBytes = 0, fail = 0;
  for (const [p, s] of archiveSet) {
    const dest = archiveDestOf(p);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await pipeline(fs.createReadStream(p), zlib.createGzip({ level: 6 }), fs.createWriteStream(dest));
      outBytes += fs.statSync(dest).size; done++;
    } catch (e) { fail++; if (fail <= 3) console.log('  跳过 ' + path.basename(p) + ': ' + e.code); }
  }
  console.log(`归档完成 ${done}/${archiveSet.length} 个，失败 ${fail}，压缩包 ${mb(outBytes)} → ${ROOT_OUT}`);

  // 抽样校验：解压后 sha256 必须与源文件一致
  const sample = [archiveSet[0], archiveSet[Math.floor(archiveSet.length / 2)], archiveSet[archiveSet.length - 1]].filter(Boolean);
  let sampleOk = true;
  for (const [p] of sample) {
    const dest = archiveDestOf(p);
    if (!fs.existsSync(dest)) { sampleOk = false; console.log('  缺归档: ' + path.basename(p)); continue; }
    const back = zlib.gunzipSync(fs.readFileSync(dest));
    const ok = crypto.createHash('sha256').update(back).digest('hex') === sha(p);
    if (!ok) { sampleOk = false; console.log('  校验不符: ' + path.basename(p)); }
  }
  const ok = fail === 0 && sampleOk && done === archiveSet.length;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify({ root: ROOT_OUT, expect: archiveSet.length, done, fail, sampleOk, ok, at: new Date().toISOString() }, null, 1));
  console.log(ok ? '✅ 归档校验通过，可执行 --purge' : '❌ 归档不完整，已阻止删除');
  process.exit(ok ? 0 : 1);
}

if (argv.includes('--purge')) {
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  if (!st.ok) { console.log('❌ 上次归档未通过校验，拒绝删除'); process.exit(1); }
  // 归档目录以状态文件里记录的为准：--purge 若在归档次日运行，按当天日期重算
  // ROOT_OUT 会指向一个不存在的目录（历史潜伏 bug），用它校验必然全部「缺归档」
  const purgeRoot = st.root || ROOT_OUT;
  const destOf = (p) => {
    const r = path.relative(HOME, p);
    return path.join(purgeRoot, (r.startsWith('..') ? path.basename(p) : r) + '.gz');
  };
  // 计划一致性：--purge 进程里 buildPlan() 是重算的，若归档后数据有变化（用户删了会话等），
  // 新计划里会出现没归档过的新文件——直接删就是无归档丢数据。对不上就要求重新归档
  if (Number(st.expect) !== archiveSet.length) {
    console.log(`❌ 当前计划 ${archiveSet.length} 项 ≠ 归档时 ${st.expect} 项（期间数据有变化），请重新 --archive 后再 --purge`);
    process.exit(1);
  }
  // 逐项确认归档真实存在（状态文件说 ok 也信不过：磁盘可能被清理）
  const missing = archiveSet.filter(([p]) => !fs.existsSync(destOf(p)));
  if (missing.length) {
    console.log(`❌ 有 ${missing.length} 个文件找不到对应归档（${purgeRoot}），拒绝删除；请重新 --archive`);
    process.exit(1);
  }
  let freed = 0, ok = 0, fail = 0;
  for (const [p, s] of [...archiveSet, ...plan.oldLogs, ...plan.cache]) {
    try { fs.rmSync(p, { recursive: true, force: true }); freed += s; ok++; } catch { fail++; }
  }
  console.log(`删除 ${ok} 项，失败 ${fail}，回收 ${mb(freed)}（归档在 ${purgeRoot}）`);
  process.exit(0);
}
