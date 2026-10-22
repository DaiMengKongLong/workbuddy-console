#!/usr/bin/env node
// 同账号内容级去重：cwd+标题+创建时间 相同、且消息内容重合 ≥85% 的会话 → 合并进内容最全的一份，其余软删
// node 重复对话合并.mjs --dry
// node 重复对话合并.mjs --apply
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mergeUnion } from './合并内核.mjs';

const DRY = !process.argv.includes('--apply');
const HOME = process.env.USERPROFILE || process.env.HOME;
const WB = path.join(HOME, '.workbuddy');
const PROJ = path.join(WB, 'projects');
const DB = path.join(WB, 'workbuddy.db');
const BACKUP = path.join(HOME, '.wb-switch', 'backups', 'merged-in', new Date().toISOString().slice(0, 10));
const mb = n => (n / 1048576).toFixed(1) + 'MB';

const txt = o => {
  try { const c = o.message ? o.message.content : o.content; if (Array.isArray(c)) return c.map(x => x.text || '').join(''); if (typeof c === 'string') return c; } catch {}
  return '';
};
const load = p => fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const msgSig = recs => new Set(recs.filter(o => o.type === 'message').map(o => (o.role || '') + '|' + txt(o).replace(/\s+/g, '').slice(0, 200)));

function findFile(id) {
  const dirs = fs.readdirSync(PROJ, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(PROJ, d.name));
  for (const d of dirs) {
    const p = path.join(d, id + '.jsonl');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const db = new DatabaseSync(DB, { timeout: 15000 });
const rows = db.prepare(`SELECT id, cwd, COALESCE(custom_title,title) t, created_at, updated_at
  FROM sessions WHERE deleted_at IS NULL ORDER BY created_at`).all();

const groups = new Map();
for (const r of rows) {
  const k = r.cwd + '|' + (r.t || '') + '|' + r.created_at;
  (groups.get(k) || groups.set(k, []).get(k)).push(r);
}

const now = Date.now();
let fixed = 0, freedBytes = 0;
for (const [k, list] of groups) {
  if (list.length < 2) continue;
  if (list.some(r => now - r.updated_at < 5 * 60 * 1000)) { console.log('跳过（5 分钟内有活动）: ' + list[0].t); continue; }

  const infos = [];
  for (const r of list) {
    const f = findFile(r.id);
    if (!f) continue;
    const recs = load(f);
    infos.push({ id: r.id, file: f, recs, sig: msgSig(recs), size: fs.statSync(f).size, row: r });
  }
  if (infos.length < 2) continue;

  // 与第一份的重合度
  const base = infos.slice().sort((a, b) => b.recs.length - a.recs.length)[0];
  const dup = infos.filter(x => x !== base && (() => {
    let hit = 0; for (const s of x.sig) if (base.sig.has(s)) hit++;
    return x.sig.size ? hit / Math.max(x.sig.size, 1) >= 0.85 : false;
  })());
  if (!dup.length) { console.log('同名但内容不同，跳过: ' + (list[0].t || list[0].id.slice(0, 8)) + '（' + infos.length + ' 份）'); continue; }

  console.log(`\n聚合: ${list[0].t || base.id.slice(0, 8)} | 保留 ${base.id.slice(0, 8)}（${base.recs.length} 行 ${mb(base.size)}）`);
  for (const d of dup) console.log(`  合并 ${d.id.slice(0, 8)}（${d.recs.length} 行 ${mb(d.size)}）`);

  if (DRY) { fixed++; continue; }

  const tmp = base.file + '.merged.tmp';
  const r = mergeUnion([{ id: base.id, file: base.file }, ...dup.map(d => ({ id: d.id, file: d.file }))], base.id, tmp);
  if (!r.ok) { console.log('  合并失败: ' + r.error); continue; }
  fs.renameSync(tmp, base.file);

  const tx = db.prepare("UPDATE sessions SET deleted_at=?, status='pruned' WHERE id=?");
  for (const d of dup) {
    tx.run(Date.now(), d.id);
    fs.mkdirSync(BACKUP, { recursive: true });
    try { fs.renameSync(d.file, path.join(BACKUP, d.id + '.jsonl')); } catch {}
    freedBytes += d.size;
  }
  fixed++;
}

if (!DRY) {
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
}
db.close();
console.log(`\n${DRY ? '预演' : '实际'}：处理 ${fixed} 组，回收 ${mb(freedBytes)}`);
