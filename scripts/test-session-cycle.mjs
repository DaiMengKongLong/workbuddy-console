/**
 * 多账号轮转复制测试（对应 2026-10-19 用户反馈）：
 * A→B→C→D→A 这种接力复制里，回切到 A 时必须识别出「这段对话 A 早就有了」，
 * 不能又复制一份；列表也要按**整段对话的家族**判定，而不是只看这一对账号的账本。
 *
 * 全程沙箱：临时数据根 + 临时账号库 + 假 auth 文件，不联网、不碰真实会话数据。
 * 运行：node scripts/test-session-cycle.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/* ---------- 隔离环境（必须在 import 业务模块之前设置） ---------- */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cycle-'));
const dataRoot = path.join(tmpRoot, 'data');
const storeHome = path.join(tmpRoot, 'store');
const cfgDir = path.join(tmpRoot, 'cfg');
const lad = path.join(tmpRoot, 'localappdata');
const appdata = path.join(tmpRoot, 'appdata');
for (const d of [dataRoot, storeHome, cfgDir, lad, appdata, path.join(dataRoot, 'projects', 'demo-ws')]) {
  fs.mkdirSync(d, { recursive: true });
}
process.env.WB_DATA_ROOT_CN = dataRoot; // 旧版隔离机制，现已不被读取（保留以防回退）
process.env.WB_SWITCH_HOME = storeHome;
process.env.FREE_TOKEN_CONFIG_DIR = cfgDir;
process.env.LOCALAPPDATA = lad;
process.env.APPDATA = appdata;
process.env.WB_FAKE_APP_RUNNING = '0';
/* 合并版的数据根解析走 config.json 的 settings.workbuddyDir 覆盖（不再读 WB_DATA_ROOT_CN） */
fs.writeFileSync(
  path.join(cfgDir, 'config.json'),
  JSON.stringify({ version: 1, settings: { workbuddyDir: dataRoot } })
);

const out = (s) => fs.writeSync(1, s + '\n');
let pass = 0;
let total = 0;
const ok = (cond, msg, extra = '') => {
  total++;
  out(`${cond ? 'PASS' : 'FAIL'}  ${msg}${!cond && extra ? ` — ${extra}` : ''}`);
  if (cond) pass++;
};

/* ---------- 四个账号 ---------- */
const NAMES = ['A', 'B', 'C', 'D'];
const UID = Object.fromEntries(
  NAMES.map((n, i) => [n, `${String(i + 1).repeat(8)}-1111-4111-8111-00000000000${i + 1}`])
);
const ACC = Object.fromEntries(NAMES.map((n) => [n, `acct-${n}`]));
fs.writeFileSync(
  path.join(storeHome, 'accounts.json'),
  JSON.stringify(
    NAMES.map((n) => ({ id: ACC[n], uid: UID[n], name: `账号${n}`, variant: 'cn', access_token: 'x', refresh_token: 'y' }))
  )
);

/* ---------- 会话库 ---------- */
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(path.join(dataRoot, 'workbuddy.db'));
db.exec(`CREATE TABLE sessions (
  id TEXT PRIMARY KEY, cwd TEXT NOT NULL, user_id TEXT NOT NULL, title TEXT, custom_title TEXT,
  status TEXT NOT NULL DEFAULT 'Pending', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  deleted_at INTEGER, is_playground INTEGER NOT NULL DEFAULT 0, transport TEXT NOT NULL DEFAULT 'local',
  unread INTEGER NOT NULL DEFAULT 0)`);

const projectsDir = path.join(dataRoot, 'projects', 'demo-ws');
function addSession(uid, title, text = 'hi') {
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare('INSERT INTO sessions (id, cwd, user_id, title, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run(
    id,
    'E:\\demo',
    uid,
    title,
    'Pending',
    now,
    now
  );
  fs.writeFileSync(
    path.join(projectsDir, `${id}.jsonl`),
    [
      JSON.stringify({ type: 'session-meta', id: 'm1', sessionId: id, timestamp: 1 }),
      JSON.stringify({ id: `msg-${id}`, sessionId: id, type: 'message', role: 'user', content: [{ type: 'input_text', text: `${text} ${id}` }] }),
    ].join('\n') + '\n'
  );
  return id;
}

function setCurrent(name) {
  const dir = path.join(lad, 'CodeBuddyExtension', 'Data', 'Public', 'auth');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'workbuddy-desktop.info'), JSON.stringify({ account: { uid: UID[name] }, auth: { accessToken: 'x' } }));
}

const { listSessionsForSwitch, copySessions } = await import('../server/workbuddy/sessions.mjs');

/* ---------- 造数据：每号各有一条自己的原生对话 ---------- */
for (const n of NAMES) addSession(UID[n], `${n}自己的对话`);

const countFor = (name, title) =>
  db
    .prepare('SELECT COUNT(*) n FROM sessions WHERE user_id = ? AND deleted_at IS NULL AND COALESCE(custom_title, title) = ?')
    .get(UID[name], title).n;
const totalFor = (name) =>
  db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id = ? AND deleted_at IS NULL').get(UID[name]).n;

/** 一次切号：列出源账号所有可复制会话 → 客户端默认全选 → 复制 → 切走 */
async function step(from, to) {
  setCurrent(from);
  const list = await listSessionsForSwitch({ targetAccountId: ACC[to] });
  const ids = list.sessions.filter((s) => s.hasBody).map((s) => s.id);
  const rep = await copySessions({ targetAccountId: ACC[to], ids });
  setCurrent(to);
  return { list, rep };
}

out('1. 直连复制（A→B）：共享对话复制一份');
{
  const { rep } = await step('A', 'B');
  ok(rep.copied.length === 1 && rep.skipped.length === 0, 'A→B 复制 1 个、无跳过', `copied=${rep.copied.length} skipped=${rep.skipped.length}`);
  ok(countFor('B', 'A自己的对话') === 1, 'B 里出现一份 A 的对话');
}

out('2. 接力（B→C、C→D）：副本继续往下传');
{
  const r1 = await step('B', 'C');
  ok(r1.rep.copied.length === 2, 'B→C 复制 2 个（A 的副本 + B 自己的）', `copied=${r1.rep.copied.length}`);
  const r2 = await step('C', 'D');
  ok(r2.rep.copied.length === 3, 'C→D 复制 3 个', `copied=${r2.rep.copied.length}`);
}

out('3. 回切（D→A）：列表按「整段对话」判定，A 已有的不再列成待复制');
{
  setCurrent('D');
  const list = await listSessionsForSwitch({ targetAccountId: ACC.A });
  const shared = list.sessions.find((s) => s.title === 'A自己的对话');
  ok(!!shared, '列表里能看到「A自己的对话」');
  ok(shared?.copied === true, '它被判定为已存在于 A（不是待复制）');
  ok(shared?.copiedScope === 'family', '判定来源是跨账号家族（copiedScope=family）', String(shared?.copiedScope));
  const pending = list.sessions.filter((s) => !s.copied);
  ok(pending.length === 3, '待复制的只剩另外 3 条（B/C/D 各自的对话）', `pending=${pending.length}`);

  const ids = list.sessions.filter((s) => s.hasBody).map((s) => s.id);
  const rep = await copySessions({ targetAccountId: ACC.A, ids });
  ok(rep.skipped.length === 1, 'D→A 里那条共享对话走往返合并（不新增副本）', `skipped=${rep.skipped.length}`);
  ok(rep.copied.length === 3, '另外 3 条才真正新复制', `copied=${rep.copied.length}`);
  ok(countFor('A', 'A自己的对话') === 1, 'A 里仍然只有一份「A自己的对话」（没被复制成两份）');
  setCurrent('A');
}

out('4. 再轮一轮（A→B）：已同步的对话继续被识别，只复制真正缺的');
{
  const { list, rep } = await step('A', 'B');
  const synced = list.sessions.filter((s) => s.copied).length;
  ok(synced === 2, '列表识别出 2 条已在 B 里（共享对话 + B 自己的对话回传）', `synced=${synced}`);
  ok(rep.copied.length === 2, '只复制真正缺的 2 条', `copied=${rep.copied.length}`);
}

out('5. 持续轮转直到收敛：最终每个账号各持一份、不再有新增副本');
{
  let rounds = 0;
  let guard = 0;
  while (guard++ < 12) {
    rounds++;
    let copiedAny = 0;
    for (let i = 0; i < NAMES.length; i++) {
      const from = NAMES[i];
      const to = NAMES[(i + 1) % NAMES.length];
      const { rep } = await step(from, to);
      copiedAny += rep.copied.length;
      if (!rep.ok) ok(false, `轮转 ${from}→${to} 出现错误`, rep.errors.map((e) => e.error).join('; '));
    }
    if (copiedAny === 0) break;
  }
  ok(rounds <= 4, `最多 4 轮就收敛（实际 ${rounds} 轮）`, `rounds=${rounds}`);
  const counts = NAMES.map((n) => totalFor(n));
  ok(new Set(counts).size === 1, '收敛后四个账号会话数一致', JSON.stringify(counts));
  for (const title of ['A自己的对话', 'B自己的对话', 'C自己的对话', 'D自己的对话']) {
    const per = NAMES.map((n) => countFor(n, title));
    ok(per.every((x) => x === 1), `「${title}」在每个账号里恰好 1 份`, JSON.stringify(per));
  }
}

out(`\n结果：${pass} 通过 / ${total - pass} 失败`);
try {
  db.close();
} catch {
  /* 关不掉也不影响结论 */
}
try {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch {
  /* 沙箱目录清不掉无所谓（Windows 上 sqlite 句柄释放有延迟） */
}
process.exit(pass === total ? 0 : 1);
