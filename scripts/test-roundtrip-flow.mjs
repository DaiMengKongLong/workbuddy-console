/**
 * 往返复制全流程回归 —— 按「另一个用户」的真实操作路径端到端跑，**不预置任何账本**。
 *
 * 为什么要有这个文件：`test-session-copy.mjs` 第 8/9 节是**手工把反向账本塞进去**再验证合并的，
 * 它只证明了「账本里已经有那一条时能合并」，没有证明「真实操作一遍之后账本里会正好有那一条」。
 * 别的用户遇到的重复会话，恰恰出在这条链路的衔接处，所以这里从零开始跑：
 *
 *   登录 A → 把会话复制给 B → 切换登录到 B → 在 B 里继续聊 + 改名 → 切换回 A → 把会话复制回 A
 *
 * 每个场景都断言「目标账号里没有多出无法解释的会话」，并核对新内容是否并回原会话。
 *
 * 隔离方式与 test-session-copy.mjs 一致（WB_DATA_ROOT_CN / WB_SWITCH_HOME / LOCALAPPDATA / APPDATA
 * 全部指向临时目录），绝不碰真实会话数据。
 *
 * 运行：node scripts/test-roundtrip-flow.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* ---------- 隔离环境（必须在 import 业务模块之前设置） ---------- */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-rt-flow-'));
const dataRoot = path.join(tmpRoot, 'data');
const storeHome = path.join(tmpRoot, 'store');
const cfgDir = path.join(tmpRoot, 'cfg');
const fakeLocalAppData = path.join(tmpRoot, 'localappdata');
const fakeAppData = path.join(tmpRoot, 'appdata');
for (const d of [dataRoot, storeHome, cfgDir, fakeLocalAppData, fakeAppData]) fs.mkdirSync(d, { recursive: true });

process.env.WB_DATA_ROOT_CN = dataRoot; // 旧版隔离机制，现已不被读取（保留以防回退）
process.env.WB_SWITCH_HOME = storeHome;
process.env.FREE_TOKEN_CONFIG_DIR = cfgDir;
process.env.LOCALAPPDATA = fakeLocalAppData;
process.env.APPDATA = fakeAppData;
process.env.WB_FAKE_APP_RUNNING = '0';
/* 合并版的数据根解析走 config.json 的 settings.workbuddyDir 覆盖（不再读 WB_DATA_ROOT_CN） */
fs.writeFileSync(
  path.join(cfgDir, 'config.json'),
  JSON.stringify({ version: 1, settings: { workbuddyDir: dataRoot } })
);

const out = (s) => fs.writeSync(1, s + '\n');
let pass = 0;
let total = 0;
const ok = (cond, msg) => {
  total++;
  out(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (cond) pass++;
};
const info = (msg) => out(`      ${msg}`);

/* ---------- 三个账号（同一个国内版档位） ---------- */
const UID = {
  A: '11111111-1111-4111-8111-111111111111',
  B: '22222222-2222-4222-8222-222222222222',
  C: '33333333-3333-4333-8333-333333333333',
};
const ACCT = { A: 'acct-a', B: 'acct-b', C: 'acct-c' };

const projectsDir = path.join(dataRoot, 'projects');
const slugDir = path.join(projectsDir, 'e-demo-workspace');
fs.mkdirSync(slugDir, { recursive: true });

const SESSION_COLUMNS = [
  'id TEXT PRIMARY KEY',
  'cwd TEXT NOT NULL',
  'user_id TEXT NOT NULL',
  'title TEXT',
  'custom_title TEXT',
  'status TEXT NOT NULL DEFAULT "Pending"',
  'created_at INTEGER NOT NULL',
  'updated_at INTEGER NOT NULL',
  'deleted_at INTEGER',
  'is_playground INTEGER NOT NULL DEFAULT 0',
  'model TEXT',
  'last_activity_at INTEGER',
  'transport TEXT NOT NULL DEFAULT "local"',
  'unread INTEGER NOT NULL DEFAULT 0',
  'agent_dirty INTEGER',
  'agent_dirty_at INTEGER',
  'agent_last_synced INTEGER',
  'verified_at INTEGER',
];

const { DatabaseSync } = await import('node:sqlite');
const dbPath = path.join(dataRoot, 'workbuddy.db');
{
  const seed = new DatabaseSync(dbPath);
  seed.exec(`CREATE TABLE sessions (${SESSION_COLUMNS.join(', ')})`);
  seed.close();
}

const writeDb = (fn) => {
  const d = new DatabaseSync(dbPath);
  try {
    return fn(d);
  } finally {
    d.close();
  }
};
const readDb = (fn) => {
  const d = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
  try {
    return fn(d);
  } finally {
    d.close();
  }
};

/** 建一个会话（含正文 n 行） */
const seedSession = (id, uid, n, title = '演示会话') => {
  writeDb((d) =>
    d
      .prepare(
        `INSERT INTO sessions (id, cwd, user_id, title, status, created_at, updated_at, last_activity_at, unread)
         VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, 3)`
      )
      .run(id, 'E:\\demo\\workspace', uid, title, 1700000000000, 1700000000000, 1700000000000)
  );
  writeBody(id, 1, n);
};

/** 正文：每行一条消息，行内含 sessionId（与真实客户端同形） */
const bodyLines = (sid, from, to) =>
  Array.from({ length: to - from + 1 }, (_, i) =>
    JSON.stringify({
      id: `msg-${from + i}`,
      timestamp: from + i,
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: `第 ${from + i} 句` }],
      sessionId: sid,
    })
  );

const bodyIndex = () => {
  const map = new Map();
  const walk = (dir) => {
    let es;
    try {
      es = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of es) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) map.set(e.name.slice(0, -6), p);
    }
  };
  walk(projectsDir);
  return map;
};
const writeBody = (id, from, to) => {
  const p = path.join(slugDir, `${id}.jsonl`);
  fs.writeFileSync(p, bodyLines(id, from, to).join('\n') + '\n', 'utf8');
  return p;
};
/** 在会话正文末尾追加 n 行（模拟用户继续聊） */
const appendChat = (id, n, base) => {
  const p = bodyIndex().get(id);
  if (!p) throw new Error(`正文不存在：${id}`);
  const cur = fs.readFileSync(p, 'utf8');
  fs.writeFileSync(p, cur + bodyLines(id, base, base + n - 1).join('\n') + '\n', 'utf8');
};
const lineCount = (id) => {
  const p = bodyIndex().get(id);
  if (!p) return null;
  return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).length;
};
/** 会话正文里是否残留别的会话 id */
const bodyOf = (id) => fs.readFileSync(bodyIndex().get(id), 'utf8');
/** 正文里重复行数（每行是一条带唯一消息 id 的 JSON，重复行 == 同一条消息被追加了两次） */
const dupLines = (id) => {
  const a = bodyOf(id).split('\n').filter((l) => l.trim());
  return a.length - new Set(a).size;
};

/** 模拟在客户端里改名（title + custom_title 一起写） */
const renameSession = (id, title) =>
  writeDb((d) => d.prepare('UPDATE sessions SET title = ?, custom_title = ? WHERE id = ?').run(title, title, id));
const titleOf = (id) =>
  readDb((d) => d.prepare('SELECT title, custom_title FROM sessions WHERE id = ?').get(id));

/** 某账号名下（未删除）的全部会话 id */
const idSet = (uid) =>
  readDb((d) =>
    d
      .prepare('SELECT id FROM sessions WHERE user_id = ? AND deleted_at IS NULL')
      .all(uid)
      .map((r) => String(r.id))
  ).sort();
const addedIn = (uid, before) => idSet(uid).filter((x) => !before.includes(x));

/* ---------- 账号库 + 登录态 ---------- */
fs.writeFileSync(
  path.join(storeHome, 'accounts.json'),
  JSON.stringify([
    { id: ACCT.A, uid: UID.A, variant: 'cn', nickname: '账号A' },
    { id: ACCT.B, uid: UID.B, variant: 'cn', nickname: '账号B' },
    { id: ACCT.C, uid: UID.C, variant: 'cn', nickname: '账号C' },
  ])
);
const authDir = path.join(fakeLocalAppData, 'CodeBuddyExtension', 'Data', 'Public', 'auth');
fs.mkdirSync(authDir, { recursive: true });
const AUTH_FILE = path.join(authDir, 'workbuddy-desktop.info');
/** 模拟账号切换：登录态文件的 account.uid 变了，工具就是靠它判断"当前是哪个账号" */
const loginAs = (uid) => fs.writeFileSync(AUTH_FILE, JSON.stringify({ account: { uid }, auth: { accessToken: 'x' } }));
loginAs(UID.A);

/* ---------- 被测模块 ---------- */
const { copySessions, sessionCopyLedger } = await import('../server/workbuddy/sessions.mjs');

/**
 * 跑一轮完整往返，返回各步骤结果。cycle 只是给正文编号用。
 * 返回 { copyAB, copyBA, idB, addedBack }
 */
const roundTrip = async (sessionId, cycle) => {
  loginAs(UID.A);
  const beforeB = idSet(UID.B);
  const copyAB = await copySessions({ targetAccountId: ACCT.B, ids: [sessionId] });
  const addedB = addedIn(UID.B, beforeB);
  const idB = copyAB.copied[0]?.newId || sessionCopyLedger('cn', UID.A, UID.B)[sessionId] || addedB[0];

  // 切到 B，像用户那样继续干活：聊 2 句 + 改名
  loginAs(UID.B);
  appendChat(idB, 2, 100 + cycle * 10);
  renameSession(idB, `B 里改的名字（第 ${cycle} 轮）`);

  // 切回 A，把会话复制回来
  const beforeA = idSet(UID.A);
  const copyBA = await copySessions({ targetAccountId: ACCT.A, ids: [idB] });
  return { copyAB, copyBA, idB, addedBack: addedIn(UID.A, beforeA), addedB };
};

/* ================================================================== *
 * 场景 1：两个账号往返 3 轮（用户反馈的原样操作）
 * ================================================================== */
out('== 场景 1：A→B → 在 B 干活 → 复制回 A，共 3 轮 ==');
const X = 'aaaaaaaa-0000-4000-8000-00000000000f';
loginAs(UID.A);
seedSession(X, UID.A, 3, '原始会话');
const A0 = idSet(UID.A);

let last;
for (let cycle = 1; cycle <= 3; cycle++) {
  const linesBefore = lineCount(X);
  const r = await roundTrip(X, cycle);
  last = r;
  out(`  — 第 ${cycle} 轮 —`);
  info(
    `A→B: copied=${r.copyAB.copied.length} skipped=${r.copyAB.skipped.length} errors=${r.copyAB.errors.length}` +
      ` | B→A: copied=${r.copyBA.copied.length} skipped=${r.copyBA.skipped.length} errors=${r.copyBA.errors.length}` +
      ` | B 侧副本=${String(r.idB).slice(0, 8)}…`
  );

  ok(r.copyAB.errors.length === 0, `[第${cycle}轮] A→B 无报错`);
  ok(r.copyBA.errors.length === 0, `[第${cycle}轮] B→A 无报错（${JSON.stringify(r.copyBA.errors)}）`);
  ok(r.addedBack.length === 0, `[第${cycle}轮] 复制回 A 时没有多出任何会话（多出：${r.addedBack.map((s) => s.slice(0, 8)).join(',') || '无'}）`);
  ok(idSet(UID.A).length === A0.length, `[第${cycle}轮] A 账号会话总数不变（${A0.length}）`);
  ok(
    (r.copyBA.contentSynced || []).length === 1 && r.copyBA.contentSynced[0].targetId === X,
    `[第${cycle}轮] 新内容并回了原会话 X（${(r.copyBA.contentSynced || []).map((c) => `${c.appendedLines}行`).join(',') || '无'}）`
  );
  ok(lineCount(X) === linesBefore + 2, `[第${cycle}轮] X 正文 ${linesBefore} → ${lineCount(X)} 行（应 +2）`);
  ok(titleOf(X)?.custom_title === `B 里改的名字（第 ${cycle} 轮）`, `[第${cycle}轮] 改名已同步回 X`);
  ok(dupLines(X) === 0, `[第${cycle}轮] X 正文没有重复行`);  ok(!bodyOf(X).includes(r.idB), `[第${cycle}轮] X 正文不残留副本 id`);
}
// 多轮之后：A 里仍然只有那一个会话，B 里也只有一个副本
ok(idSet(UID.A).length === A0.length, '3 轮之后 A 账号会话总数仍然不变');
ok(idSet(UID.B).filter((s) => s === last.idB).length === 1, 'B 里始终只有那一个副本');

/* ================================================================== *
 * 场景 2：同一个会话复制给两个账号，再从第二个账号复制回来
 * ================================================================== */
out('\n== 场景 2：A→B、A→C 各一份，再从 C 复制回 A ==');
const Y = 'bbbbbbbb-0000-4000-8000-00000000000f';
loginAs(UID.A);
seedSession(Y, UID.A, 4, '多账号会话');
const beforeB2 = idSet(UID.B);
const beforeC2 = idSet(UID.C);
const yToB = await copySessions({ targetAccountId: ACCT.B, ids: [Y] });
const yToC = await copySessions({ targetAccountId: ACCT.C, ids: [Y] });
const YB = yToB.copied[0]?.newId;
const YC = yToC.copied[0]?.newId;
ok(!!YB && !!YC, `复制出两份副本（B:${String(YB).slice(0, 8)}… C:${String(YC).slice(0, 8)}…）`);
loginAs(UID.C);
appendChat(YC, 3, 300);
const beforeA2 = idSet(UID.A);
const yBack = await copySessions({ targetAccountId: ACCT.A, ids: [YC] });
ok(yBack.copied.length === 0, `从 C 复制回 A 不新建会话（copied=${yBack.copied.length}）`);
ok(addedIn(UID.A, beforeA2).length === 0, '从 C 复制回 A 后 A 里没有多出会话');
ok(yBack.contentSynced?.[0]?.targetId === Y, '新内容并回了原会话 Y');
ok(yBack.contentSynced?.[0]?.appendedLines === 3, `并回 3 行（实际 ${yBack.contentSynced?.[0]?.appendedLines}）`);
ok(
  idSet(UID.B).length === beforeB2.length + 1 && idSet(UID.C).length === beforeC2.length + 1,
  `B/C 各多出 1 份副本（B ${beforeB2.length}→${idSet(UID.B).length}，C ${beforeC2.length}→${idSet(UID.C).length}）`
);

/* ================================================================== *
 * 场景 3：三个账号接力（A→B→C，再从 C 复制回 A）
 * ================================================================== */
out('\n== 场景 3：三个账号接力 A→B→C→A ==');
const Z = 'cccccccc-0000-4000-8000-00000000000f';
loginAs(UID.A);
seedSession(Z, UID.A, 5, '三角色会话');
const zToB = await copySessions({ targetAccountId: ACCT.B, ids: [Z] });
const ZB = zToB.copied[0]?.newId;
loginAs(UID.B);
const zToC = await copySessions({ targetAccountId: ACCT.C, ids: [ZB] });
const ZC = zToC.copied[0]?.newId;
ok(!!ZC, `A→B→C 复制到第三账号（C:${String(ZC).slice(0, 8)}…）`);
loginAs(UID.C);
appendChat(ZC, 2, 500);
const beforeA3 = idSet(UID.A);
const zBack = await copySessions({ targetAccountId: ACCT.A, ids: [ZC] });
ok(zBack.copied.length === 0, `从 C 复制回 A 不新建会话（copied=${zBack.copied.length}）`);
ok(addedIn(UID.A, beforeA3).length === 0, `A 里没有多出会话（多出：${addedIn(UID.A, beforeA3).map((s) => s.slice(0, 8)).join(',') || '无'}）`);
ok(zBack.contentSynced?.[0]?.targetId === Z, `新内容并回了最初的 Z（实际 ${String(zBack.contentSynced?.[0]?.targetId || '').slice(0, 8)}）`);

/* ================================================================== *
 * 场景 4：两边都继续聊 —— 正向复制也要把本账号的新内容带给旧副本
 * ================================================================== */
out('\n== 场景 4：两侧都有新内容时的双向同步 ==');
const W = 'dddddddd-0000-4000-8000-00000000000f';
loginAs(UID.A);
seedSession(W, UID.A, 3, '双向会话');
const wToB = await copySessions({ targetAccountId: ACCT.B, ids: [W] });
const WB = wToB.copied[0]?.newId;
ok(!!WB, `A→B 先复制出一份副本（${String(WB).slice(0, 8)}…）`);

// 在 B 里聊 2 句，复制回 A
loginAs(UID.B);
appendChat(WB, 2, 400);
const wBack = await copySessions({ targetAccountId: ACCT.A, ids: [WB] });
ok(wBack.contentSynced?.[0]?.appendedLines === 2, `B 侧 2 行已并回 A 的原会话（${wBack.contentSynced?.[0]?.appendedLines}）`);

// 回到 A 又聊 1 句，然后再复制给 B：应当把这一行带给 B 的旧副本，而不是「已复制过」什么都不做
loginAs(UID.A);
appendChat(W, 1, 500);
const beforeB4 = idSet(UID.B);
const wFwd = await copySessions({ targetAccountId: ACCT.B, ids: [W] });
ok(wFwd.copied.length === 0, `A→B 不新建会话（copied=${wFwd.copied.length}）`);
ok(addedIn(UID.B, beforeB4).length === 0, 'B 里没有多出会话');
ok(
  wFwd.contentSynced?.[0]?.targetId === WB && wFwd.contentSynced[0].appendedLines === 1,
  `A 侧新聊的 1 行已同步给 B 的旧副本（实际 ${wFwd.contentSynced?.[0]?.appendedLines} 行）`
);
ok(lineCount(WB) === 6, `B 侧副本正文 3+2+1=6 行（实际 ${lineCount(WB)}）`);

// 再走一轮往返，确认两侧都不会出现重复行
loginAs(UID.B);
appendChat(WB, 2, 600);
const wBack2 = await copySessions({ targetAccountId: ACCT.A, ids: [WB] });
loginAs(UID.A);
const wFwd2 = await copySessions({ targetAccountId: ACCT.B, ids: [W] });
ok(wBack2.copied.length === 0 && wFwd2.copied.length === 0, '再走一轮往返仍然不新建会话');
ok(
  (wBack2.contentSynced?.[0]?.appendedLines ?? 0) + (wFwd2.contentSynced?.[0]?.appendedLines ?? 0) === 2,
  '第二轮只有 B 侧新增的 2 行被同步（没有把老内容重复搬）'
);
ok(dupLines(W) === 0, `A 侧原会话没有重复行（重复 ${dupLines(W)} 行）`);
ok(dupLines(WB) === 0, `B 侧副本没有重复行（重复 ${dupLines(WB)} 行）`);

/* ---------- 汇总 ---------- */
out(`\n${pass}/${total} 断言通过`);
fs.rmSync(tmpRoot, { recursive: true, force: true });
process.exit(pass === total ? 0 : 1);
