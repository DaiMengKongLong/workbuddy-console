/**
 * 会话搬家（「转到此账号」）回归测试 —— 不联网、不碰真实会话数据。
 *
 * 隔离方式与 test-session-copy.mjs 一致（必须在 import 业务模块之前设置）：
 * WB_SWITCH_HOME / FREE_TOKEN_CONFIG_DIR / LOCALAPPDATA / APPDATA 全部指向临时目录，
 * 数据根通过 config.json 的 settings.workbuddyDir 覆盖。
 *
 * 重点覆盖 2026-10-25 的两个线上问题：
 * 1. 搬家「报成功但库没动」——现在写盘后有回读校验（report.verified）；
 * 2. 撞锁/被杀软拦一下就整条算失败——UPDATE 现在有重试。
 *
 * 运行：node scripts/test-session-move.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* ---------- 隔离环境 ---------- */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-move-'));
const dataRoot = path.join(tmpRoot, 'data');
const storeHome = path.join(tmpRoot, 'store');
const cfgDir = path.join(tmpRoot, 'cfg');
const fakeLocalAppData = path.join(tmpRoot, 'localappdata');
const fakeAppData = path.join(tmpRoot, 'appdata');
for (const d of [dataRoot, storeHome, cfgDir, fakeLocalAppData, fakeAppData]) fs.mkdirSync(d, { recursive: true });

process.env.WB_SWITCH_HOME = storeHome;
process.env.FREE_TOKEN_CONFIG_DIR = cfgDir;
process.env.LOCALAPPDATA = fakeLocalAppData;
process.env.APPDATA = fakeAppData;
process.env.WB_FAKE_APP_RUNNING = '0';
fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ version: 1, settings: { workbuddyDir: dataRoot } }));

const out = (s) => fs.writeSync(1, s + '\n');
let pass = 0;
let total = 0;
const ok = (cond, msg) => {
  total++;
  out(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (cond) pass++;
};

/* ---------- 夹具 ---------- */
const SOURCE_UID = '11111111-1111-4111-8111-111111111111';
const TARGET_UID = '22222222-2222-4222-8222-222222222222';
const TARGET_ACCOUNT_ID = 'acct-target';
const SOURCE_ACCOUNT_ID = 'acct-source';

const CID = {
  plain: 'aaaaaaaa-0000-4000-8000-000000000001',
  second: 'bbbbbbbb-0000-4000-8000-000000000002',
  twinSrc: 'cccccccc-0000-4000-8000-000000000003',
  twinDst: 'cccccccc-0000-4000-8000-000000000004',
  other: 'dddddddd-0000-4000-8000-000000000005',
};

const projectsDir = path.join(dataRoot, 'projects');
const slugDir = path.join(projectsDir, 'e-demo-workspace');
fs.mkdirSync(slugDir, { recursive: true });

/** 与真实客户端同形的 JSONL 正文（含 sessionId 行） */
const bodyText = (cid, extra = '') =>
  [
    JSON.stringify({ type: 'session-meta', id: 'meta-1', sessionId: cid, timestamp: 1, meta: { host: 'x' } }),
    JSON.stringify({
      id: 'msg-1',
      timestamp: 2,
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: `正文 ${cid} ${extra}` }],
      sessionId: cid,
    }),
  ].join('\n') + '\n';

const bodyPath = {
  plain: path.join(slugDir, `${CID.plain}.jsonl`),
  second: path.join(slugDir, `${CID.second}.jsonl`),
  twinSrc: path.join(slugDir, `${CID.twinSrc}.jsonl`),
  // 目标账号里「同一对话」：正文完全一致 → 走合并分支
  twinDst: path.join(slugDir, `${CID.twinDst}.jsonl`),
  other: path.join(slugDir, `${CID.other}.jsonl`),
};
fs.writeFileSync(bodyPath.plain, bodyText(CID.plain), 'utf8');
fs.writeFileSync(bodyPath.second, bodyText(CID.second), 'utf8');
fs.writeFileSync(bodyPath.twinSrc, bodyText(CID.twinSrc, 'same'), 'utf8');
fs.writeFileSync(bodyPath.twinDst, bodyText(CID.twinSrc, 'same'), 'utf8'); // 刻意与源同内容
fs.writeFileSync(bodyPath.other, bodyText(CID.other), 'utf8');

const { DatabaseSync } = await import('node:sqlite');
const dbPath = path.join(dataRoot, 'workbuddy.db');
const seed = new DatabaseSync(dbPath);
seed.exec(`CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  cwd TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT,
  custom_title TEXT,
  status TEXT NOT NULL DEFAULT 'Completed',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
)`);
const insertSeed = (id, uid, title) =>
  seed
    .prepare('INSERT INTO sessions (id, cwd, user_id, title, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,NULL)')
    .run(id, 'E:\\demo\\workspace', uid, title, 1700000000000, 1700000001000);
insertSeed(CID.plain, SOURCE_UID, '普通会话');
insertSeed(CID.second, SOURCE_UID, '第二个会话');
insertSeed(CID.twinSrc, SOURCE_UID, '同一对话（源）');
insertSeed(CID.twinDst, TARGET_UID, '同一对话（目标）');
insertSeed(CID.other, TARGET_UID, '目标账号自己的会话');
seed.close();

fs.writeFileSync(
  path.join(storeHome, 'accounts.json'),
  JSON.stringify([
    { id: SOURCE_ACCOUNT_ID, uid: SOURCE_UID, variant: 'cn', nickname: '源账号' },
    { id: TARGET_ACCOUNT_ID, uid: TARGET_UID, variant: 'cn', nickname: '目标账号' },
  ])
);
const authDir = path.join(fakeLocalAppData, 'CodeBuddyExtension', 'Data', 'Public', 'auth');
fs.mkdirSync(authDir, { recursive: true });
fs.writeFileSync(
  path.join(authDir, 'workbuddy-desktop.info'),
  JSON.stringify({ account: { uid: SOURCE_UID }, auth: { accessToken: 'x' } })
);

/* ---------- 被测模块 ---------- */
const { moveSessionsToAccount } = await import('../server/workbuddy/sessions.mjs');

const ownedBy = (id) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const row = db.prepare('SELECT user_id, deleted_at FROM sessions WHERE id = ?').get(id);
  db.close();
  return row ? { uid: row.user_id, deleted: row.deleted_at != null } : null;
};

/* ---------- 1. 预演不写库 ---------- */
out('\n== 1. dryRun 只统计、不改库 ==');
{
  const r = await moveSessionsToAccount({ targetAccountId: TARGET_ACCOUNT_ID, ids: [CID.plain], dryRun: true, sourceVariant: 'cn' });
  ok(r.moved.length === 1, `预演报出 1 个待过户（实际 ${r.moved.length}）`);
  ok(r.moved[0].id === CID.plain, '预演命中的正是选中的会话');
  ok(ownedBy(CID.plain).uid === SOURCE_UID, '预演后库里的归属没变');
  ok(r.verified === undefined, '预演不做回读校验（verified 未设置）');
}

/* ---------- 2. 真实过户 ---------- */
out('\n== 2. 真实过户：改归属、正文原地不动、回读校验通过 ==');
{
  const before = fs.readFileSync(bodyPath.plain, 'utf8');
  const r = await moveSessionsToAccount({ targetAccountId: TARGET_ACCOUNT_ID, ids: [CID.plain, CID.second], sourceVariant: 'cn' });
  ok(r.ok === true, '整体 ok');
  ok(r.moved.length === 2, `2 个会话过户成功（实际 ${r.moved.length}）`);
  ok(r.errors.length === 0, `没有错误（${r.errors.map((e) => e.error).join('; ') || '无'}）`);
  ok(r.verified === true, '回读校验通过（verified = true）');
  ok(!!r.backupPath, '执行前留了会话库备份');
  ok(ownedBy(CID.plain).uid === TARGET_UID, '库里的归属已改成目标账号');
  ok(ownedBy(CID.second).uid === TARGET_UID, '第二个会话也过户了');
  ok(!ownedBy(CID.plain).deleted, '过户不是软删除（会话仍然可见）');
  ok(fs.readFileSync(bodyPath.plain, 'utf8') === before, '正文文件原地不动（磁盘零增长）');
  ok(ownedBy(CID.other).uid === TARGET_UID, '目标账号原本的会话没有被误改');
}

/* ---------- 3. 目标已有同一对话 → 合并 ---------- */
out('\n== 3. 目标账号已有同一对话：合并取全 + 源副本软删 ==');
{
  const r = await moveSessionsToAccount({ targetAccountId: TARGET_ACCOUNT_ID, ids: [CID.twinSrc], sourceVariant: 'cn' });
  ok(r.merged.length === 1, `走了合并分支（merged=${r.merged.length}）`);
  ok(r.merged[0]?.targetId === CID.twinDst, '合并到目标账号那份底稿上');
  ok(r.errors.length === 0, '合并没有报错');
  ok(r.verified === true, '回读校验通过');
  ok(ownedBy(CID.twinSrc).deleted === true, '源副本被软删除（磁盘只留一份）');
  ok(ownedBy(CID.twinDst).uid === TARGET_UID, '目标底稿仍在目标账号名下');
}

/* ---------- 4. 幂等：再搬一次没有可搬的 ---------- */
out('\n== 4. 重复执行是幂等的 ==');
{
  const r = await moveSessionsToAccount({ targetAccountId: TARGET_ACCOUNT_ID, ids: [CID.plain], sourceVariant: 'cn' });
  ok(r.moved.length === 0 && r.merged.length === 0, '源账号名下已经没有这条会话，什么都不搬');
  ok(r.ok === true && r.errors.length === 0, '也不报错（不是失败）');
}

/* ---------- 5. 源=目标 直接拒绝 ---------- */
out('\n== 5. 源账号与目标账号相同：明确报错 ==');
{
  let err = '';
  try {
    await moveSessionsToAccount({ targetAccountId: SOURCE_ACCOUNT_ID, ids: [CID.plain], sourceVariant: 'cn' });
  } catch (e) {
    err = e?.message || String(e);
  }
  ok(/源账号与目标账号相同/.test(err), `拒绝并给出原因（${err || '没有抛错'}）`);
}

fs.rmSync(tmpRoot, { recursive: true, force: true });
out(`\n结果：${pass} 通过 / ${total - pass} 失败`);
if (pass !== total) process.exit(1);
