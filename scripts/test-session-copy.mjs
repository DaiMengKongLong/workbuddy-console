/**
 * 会话复制（账号间同步对话记录）测试 —— 不联网、不碰真实会话数据。
 *
 * 隔离方式（必须在 import 业务模块之前设置）：
 * - `WB_DATA_ROOT_CN`  → 临时数据根（假 `projects/` + 假 `workbuddy.db`）
 * - `WB_SWITCH_HOME`   → 临时账号库与备份目录
 * - `FREE_TOKEN_CONFIG_DIR` → 临时配置目录
 * - `LOCALAPPDATA` / `APPDATA` → 临时目录，让登录态文件也落在沙箱里
 * - `WB_FAKE_APP_RUNNING` → 假装 WorkBuddy 已退出/正在运行（真实进程探测会看见本机的 WorkBuddy）
 *
 * 覆盖：列表（含深一层目录索引、Claw/已删除/他人会话剔除）、正常复制
 * （新 UUID / 正文改写 / 库行归属 / 源数据不动 / 不写 edge-sync 映射）、
 * 账本跳过、各类拒绝、插入失败时的回滚、备份产物。
 *
 * 运行：node scripts/test-session-copy.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* ---------- 隔离环境（必须在 import 业务模块之前设置） ---------- */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-session-'));
const dataRoot = path.join(tmpRoot, 'data');
const storeHome = path.join(tmpRoot, 'store');
const cfgDir = path.join(tmpRoot, 'cfg');
const fakeLocalAppData = path.join(tmpRoot, 'localappdata');
const fakeAppData = path.join(tmpRoot, 'appdata');
for (const d of [dataRoot, storeHome, cfgDir, fakeLocalAppData, fakeAppData]) {
  fs.mkdirSync(d, { recursive: true });
}

process.env.WB_DATA_ROOT_CN = dataRoot;
process.env.WB_SWITCH_HOME = storeHome;
process.env.FREE_TOKEN_CONFIG_DIR = cfgDir;
process.env.LOCALAPPDATA = fakeLocalAppData;
process.env.APPDATA = fakeAppData;
process.env.WB_FAKE_APP_RUNNING = '0';

const out = (s) => fs.writeSync(1, s + '\n');
let pass = 0;
let total = 0;
const ok = (cond, msg) => {
  total++;
  out(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (cond) pass++;
};

/* ---------- 假数据根 ---------- */
const SOURCE_UID = '11111111-1111-4111-8111-111111111111';
const TARGET_UID = '22222222-2222-4222-8222-222222222222';
const TARGET_ACCOUNT_ID = 'acct-target';

const projectsDir = path.join(dataRoot, 'projects');
const slugDir = path.join(projectsDir, 'e-demo-workspace');
const nestedDir = path.join(slugDir, 'sub-session-dir');
fs.mkdirSync(nestedDir, { recursive: true });

const CID = {
  plain: 'aaaaaaaa-0000-4000-8000-000000000001',
  nested: 'bbbbbbbb-0000-4000-8000-000000000002',
  other: 'cccccccc-0000-4000-8000-000000000003',
  deleted: 'dddddddd-0000-4000-8000-000000000004',
  claw: 'eeeeeeee-0000-4000-8000-000000000005',
  bodyless: 'ffffffff-0000-4000-8000-000000000006',
  rollback: 'aaaaaaa1-0000-4000-8000-000000000007',
  /** 专供「自动退出 WorkBuddy」分支使用，避免污染别的用例的账本 */
  stopApp: 'aaaaaaa2-0000-4000-8000-000000000008',
};

/** 与真实客户端同形的 JSONL 正文：每行都有 sessionId，正文里还夹着会话 id */
const bodyText = (cid) =>
  [
    JSON.stringify({ type: 'session-meta', id: 'meta-1', sessionId: cid, timestamp: 1, meta: { host: 'x' } }),
    JSON.stringify({
      id: 'msg-1',
      timestamp: 2,
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: `引用自身 ${cid} 的一行` }],
      sessionId: cid,
    }),
    JSON.stringify({
      id: 'msg-2',
      timestamp: 3,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'ok' }],
      sessionId: cid,
      _meta: { baggage: `codebuddy.session_id=${cid}` },
    }),
  ].join('\n') + '\n';

/** 有正文的会话 → 正文路径 */
const bodyPath = {
  plain: path.join(slugDir, `${CID.plain}.jsonl`),
  nested: path.join(nestedDir, `${CID.nested}.jsonl`),
  other: path.join(slugDir, `${CID.other}.jsonl`),
  deleted: path.join(slugDir, `${CID.deleted}.jsonl`),
  claw: path.join(slugDir, `${CID.claw}.jsonl`),
  rollback: path.join(slugDir, `${CID.rollback}.jsonl`),
  stopApp: path.join(slugDir, `${CID.stopApp}.jsonl`),
};
for (const [key, p] of Object.entries(bodyPath)) fs.writeFileSync(p, bodyText(CID[key]), 'utf8');

/* 假 workbuddy.db：列结构与真实客户端一致（40 列），保证动态 INSERT 走的是真实列集 */
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
  'source_mode TEXT',
  'is_background_automation INTEGER',
  'model TEXT',
  'expert_id TEXT',
  'expert_locale TEXT',
  'expert_runtime_identity TEXT',
  'last_activity_at INTEGER',
  'mode TEXT',
  'expert_marketplace TEXT',
  'permission_mode TEXT',
  'use_sandbox_cli INTEGER',
  'project_id TEXT',
  'plugin_context_json TEXT',
  'last_user_prompt_expert_selection TEXT',
  'context_window INTEGER',
  'thought_level TEXT',
  'addon_selection TEXT',
  'session_settings TEXT',
  'buddy_snapshot_id TEXT',
  'buddy_binding_json TEXT',
  'transport TEXT NOT NULL DEFAULT "local"',
  'conversation_origin TEXT',
  'visibility TEXT',
  'group_id TEXT',
  'group_title TEXT',
  'agent_dirty INTEGER',
  'agent_dirty_at INTEGER',
  'agent_last_synced INTEGER',
  'verified_at INTEGER',
  'unread INTEGER NOT NULL DEFAULT 0',
];

const { DatabaseSync } = await import('node:sqlite');
const dbPath = path.join(dataRoot, 'workbuddy.db');
const seed = new DatabaseSync(dbPath);
seed.exec(`CREATE TABLE sessions (${SESSION_COLUMNS.join(', ')})`);

/* 用「列名 → 值」建行，避免手工对位 20 个占位符时错列 */
const insertSeed = (id, uid, cwd, opts = {}) => {
  const row = {
    id,
    cwd,
    user_id: uid,
    title: opts.title ?? `标题 ${String(id).slice(0, 4)}`,
    status: opts.status ?? 'completed',
    created_at: 1700000000000,
    updated_at: 1700000001000,
    deleted_at: opts.deletedAt ?? null,
    is_playground: opts.isPlayground ?? 0,
    model: 'kimi-k2.6',
    transport: 'local',
    unread: 3, // 故意非 0，验证副本会归零
    agent_dirty: 1,
    agent_dirty_at: 1700000002000,
    agent_last_synced: 1700000003000,
    verified_at: 1700000004000,
    last_activity_at: 1700000004500,
    buddy_snapshot_id: 'bs_shared_template',
    group_id: 'grp-1',
    group_title: '分组标题',
  };
  const cols = Object.keys(row);
  seed
    .prepare(`INSERT INTO sessions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((c) => row[c]));
};
insertSeed(CID.plain, SOURCE_UID, 'E:\\demo\\workspace', { title: '普通会话' });
insertSeed(CID.nested, SOURCE_UID, 'E:\\demo\\workspace', { title: '深层目录会话', status: 'working' });
insertSeed(CID.rollback, SOURCE_UID, 'E:\\demo\\workspace', { title: '回滚用会话' });
insertSeed(CID.stopApp, SOURCE_UID, 'E:\\demo\\workspace', { title: '自动退出用会话' });
insertSeed(CID.other, TARGET_UID, 'E:\\demo\\workspace', { title: '属于目标账号的会话' });
insertSeed(CID.deleted, SOURCE_UID, 'E:\\demo\\workspace', { title: '已删除会话', deletedAt: 1700000005000 });
insertSeed(CID.claw, SOURCE_UID, 'C:\\Users\\demo\\.workbuddy\\claw', { title: 'Claw 会话' });
insertSeed(CID.bodyless, SOURCE_UID, 'E:\\demo\\workspace', { title: '没有正文的会话' });
seed.close();

/* 假账号库 + 假登录态（源账号 = 当前登录账号） */
fs.writeFileSync(
  path.join(storeHome, 'accounts.json'),
  JSON.stringify([
    { id: 'acct-source', uid: SOURCE_UID, variant: 'cn', nickname: '源账号' },
    { id: TARGET_ACCOUNT_ID, uid: TARGET_UID, variant: 'cn', nickname: '目标账号' },
  ])
);
const authDir = path.join(fakeLocalAppData, 'CodeBuddyExtension', 'Data', 'Public', 'auth');
fs.mkdirSync(authDir, { recursive: true });
fs.writeFileSync(
  path.join(authDir, 'workbuddy-desktop.info'),
  JSON.stringify({ account: { uid: SOURCE_UID }, auth: { accessToken: 'x' } })
);

/* 预置一份 edge-sync 映射库：复制**绝不能**动它 */
const edgeSyncPath = path.join(dataRoot, 'edge-sync-mapping-v4.db');
fs.writeFileSync(edgeSyncPath, Buffer.from('EDGE-SYNC-PLACEHOLDER'));
const edgeSyncBytes = fs.readFileSync(edgeSyncPath).toString();

/* ---------- 被测模块 ---------- */
const { listSessionsForSwitch, copySessions, sessionDataRoot, sessionCopySupported, sessionCopyLedger, SESSION_COPIES_FILE } =
  await import('../server/workbuddy/sessions.mjs');

const readDb = () => new DatabaseSync(dbPath, { readOnly: true });
const countRows = (uid) => {
  const d = readDb();
  const n = d.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(uid).n;
  d.close();
  return Number(n);
};
const listJsonl = () => {
  const found = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) found.push(p);
    }
  };
  walk(projectsDir);
  return found.sort();
};
const baselineJsonl = listJsonl().length;

/* ---------- 1. 基础能力 ---------- */
out('== 1. 基础能力 ==');
ok(sessionDataRoot('cn') === path.resolve(dataRoot), 'WB_DATA_ROOT_CN 覆盖生效（测试不碰真实数据根）');
ok((await sessionCopySupported('cn')) === true, '档位能力探测：projects/ + sessions 表 → 支持');

/* ---------- 2. 会话列表 ---------- */
out('\n== 2. 会话列表 ==');
const listed = await listSessionsForSwitch({ targetAccountId: TARGET_ACCOUNT_ID });
ok(listed.sourceUid === SOURCE_UID && listed.targetUid === TARGET_UID, '源/目标 uid 解析正确');
ok(listed.sessions.length === 5, `只列出源账号未删除的会话（实际 ${listed.sessions.length}，期望 5）`);
const listedIds = listed.sessions.map((s) => s.id);
ok(
  listedIds.includes(CID.plain) && listedIds.includes(CID.nested) && listedIds.includes(CID.bodyless),
  '包含普通会话 / 深层目录会话 / 无正文会话'
);
ok(!listedIds.includes(CID.other), '剔除属于其他账号的会话');
ok(!listedIds.includes(CID.deleted), '剔除已删除的会话');
ok(!listedIds.includes(CID.claw), '剔除 Claw 工作区的会话');
ok(listed.sessions.find((s) => s.id === CID.nested)?.hasBody === true, '一层子目录里的正文能被找到');
ok(listed.sessions.find((s) => s.id === CID.plain)?.hasBody === true, '直接在工作区目录里的正文能被找到');
ok(listed.sessions.find((s) => s.id === CID.bodyless)?.hasBody === false, '没有正文的会话标为 hasBody=false');
ok(listed.stats.withBody === 4 && listed.stats.bytes > 0, `体积与非空正文计数正确（withBody=${listed.stats.withBody}）`);
ok(listed.sessions.find((s) => s.id === CID.plain)?.workspace === 'workspace', '工作区名取 cwd 末段');
ok(listed.sessions.every((s) => s.copied === false && s.copiedTo === null), '尚未复制时会话都标为未复制');

/* ---------- 3. 门禁：App 运行中 ---------- */
out('\n== 3. 门禁：WorkBuddy 正在运行 ==');
process.env.WB_FAKE_APP_RUNNING = '1';
let gateError = '';
try {
  await copySessions({ targetAccountId: TARGET_ACCOUNT_ID, ids: [CID.plain] });
} catch (err) {
  gateError = err?.message || String(err);
}
ok(gateError.includes('正在运行'), '运行中复制被拒绝，提示要求先退出 WorkBuddy');
ok(listJsonl().length === baselineJsonl, '被拒绝时没有产生任何新文件');
ok(countRows(TARGET_UID) === 1, '被拒绝时库里没有多出副本行');
process.env.WB_FAKE_APP_RUNNING = '0';

/* ---------- 4. 正常复制 ---------- */
out('\n== 4. 正常复制 ==');
const srcPlainBefore = fs.readFileSync(bodyPath.plain, 'utf8');
const srcNestedBefore = fs.readFileSync(bodyPath.nested, 'utf8');
const report = await copySessions({ targetAccountId: TARGET_ACCOUNT_ID, ids: [CID.plain, CID.nested] });
ok(report.ok === true && report.errors.length === 0, '复制报告 ok、无错误');
ok(report.copied.length === 2, '两个会话都复制成功');
ok(report.backupPath && fs.existsSync(path.join(report.backupPath, 'workbuddy.db')), '复制前备份了 workbuddy.db');
ok(
  path.basename(report.backupPath).startsWith('session-copy-') &&
    report.backupPath.includes(path.join('backups', 'session-copy-')),
  '备份落在 <存储根>/backups/session-copy-*'
);
ok(report.totalBytes > 0 && report.elapsedMs >= 0, '报告带出复制总字节数与耗时');
ok(new Set(report.copied.map((c) => c.newId)).size === 2, '两个副本用的是不同的新 UUID');

const db = readDb();
for (const item of report.copied) {
  const label = item.id === CID.nested ? '深层目录会话' : '普通会话';
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(item.newId);
  ok(!!row, `副本行已写入库（${label}）`);
  ok(row?.user_id === TARGET_UID, `副本行归属目标账号（${label}）`);
  ok(row?.deleted_at === null, `副本行 deleted_at 为空（${label}）`);
  ok(row?.created_at > 1700000005000 && row?.updated_at > 1700000005000, `副本行时间戳已刷新（${label}）`);
  ok(row?.last_activity_at > 1700000005000, `副本行 last_activity_at 已刷新（${label}）`);
  ok(
    row?.agent_last_synced === null && row?.agent_dirty === null && row?.agent_dirty_at === null && row?.verified_at === null,
    `副本行清空了云端同步痕迹（${label}）`
  );
  ok(row?.unread === 0, `副本行未读归零（${label}）`);
  ok(row?.cwd === 'E:\\demo\\workspace', `副本行保留 cwd（${label}）`);
  ok(row?.buddy_snapshot_id === 'bs_shared_template' && row?.group_title === '分组标题', `副本行保留业务字段（${label}）`);
  ok(row?.model === 'kimi-k2.6' && row?.is_playground === 0, `副本行保留模型等字段（${label}）`);

  const dest = path.join(item.id === CID.nested ? nestedDir : slugDir, `${item.newId}.jsonl`);
  ok(fs.existsSync(dest), `副本正文写在源文件同目录（${label}）`);
  const text = fs.readFileSync(dest, 'utf8');
  const lines = text.split('\n').filter((l) => l.trim());
  ok(!text.includes(item.id), `副本正文里没有残留旧会话 id（${label}）`);
  ok(
    lines.every((l) => String(JSON.parse(l).sessionId) === item.newId),
    `副本正文每行 sessionId 都指向新 id（${label}）`
  );
  ok(!text.includes('codebuddy.session_id=' + item.id), `_meta.baggage 里的旧 id 也被替换（${label}）`);
  ok(
    lines.length === (item.id === CID.nested ? srcNestedBefore : srcPlainBefore).split('\n').filter((l) => l.trim()).length,
    `副本正文行数与源一致（${label}）`
  );
}
const nestedCopy = report.copied.find((c) => c.id === CID.nested);
ok(
  db.prepare('SELECT status FROM sessions WHERE id = ?').get(nestedCopy.newId)?.status === 'completed',
  '源会话是 working 时，副本改写为 completed（避免客户端续跑副本）'
);
db.close();

ok(fs.readFileSync(bodyPath.plain, 'utf8') === srcPlainBefore, '源会话正文一字未改');
ok(fs.readFileSync(bodyPath.nested, 'utf8') === srcNestedBefore, '源会话（深层目录）正文一字未改');
ok(
  (() => {
    const d = readDb();
    const r = d.prepare('SELECT user_id, deleted_at FROM sessions WHERE id = ?').get(CID.plain);
    d.close();
    return r.user_id === SOURCE_UID && r.deleted_at === null;
  })(),
  '源会话在库里的归属未变（源账号数据不受影响）'
);
ok(fs.readFileSync(edgeSyncPath).toString() === edgeSyncBytes, '没有触碰 edge-sync-mapping 云端映射库（交给客户端自行登记）');
ok(listJsonl().length === baselineJsonl + 2, '正文文件只新增了 2 份副本');
ok(countRows(TARGET_UID) === 3, '目标账号库里的会话行从 1 增至 3');

/* ---------- 5. 复制账本去重 ---------- */
out('\n== 5. 复制账本 ==');
const ledger = sessionCopyLedger('cn', SOURCE_UID, TARGET_UID);
ok(Object.keys(ledger).length === 2, '账本记录了 2 个已复制的源会话');
ok(ledger[CID.plain] === report.copied.find((c) => c.id === CID.plain).newId, '账本里「源 id → 副本 id」对应正确');
ok(fs.existsSync(path.join(storeHome, 'session_copies.json')), '账本落在 <存储根>/session_copies.json');

const again = await copySessions({ targetAccountId: TARGET_ACCOUNT_ID, ids: [CID.plain, CID.nested] });
ok(again.copied.length === 0 && again.skipped.length === 2, '重复复制被账本跳过，不再产生新副本');
ok(again.skipped.every((s) => s.reason.includes('已复制过') && s.newId), '跳过项写明原因并回带原副本 id');
ok(listJsonl().length === baselineJsonl + 2 && countRows(TARGET_UID) === 3, '跳过时文件和库都没有变化');

const relisted = await listSessionsForSwitch({ targetAccountId: TARGET_ACCOUNT_ID });
const relistedPlain = relisted.sessions.find((s) => s.id === CID.plain);
ok(relistedPlain?.copied === true && relistedPlain?.copiedTo === ledger[CID.plain], '列表接口回传 copied/copiedTo，供界面提示');
ok(relisted.sessions.find((s) => s.id === CID.bodyless)?.copied === false, '未复制的会话仍标为未复制');

/* ---------- 6. 拒绝场景 ---------- */
out('\n== 6. 拒绝场景 ==');
// 含 `/` 的 id 会被形状校验拦下（同时也是路径穿越防护的验证）
const BAD_ID = '../escape-me';
const rejectReport = await copySessions({
  targetAccountId: TARGET_ACCOUNT_ID,
  ids: [CID.other, CID.deleted, CID.claw, CID.bodyless, BAD_ID],
});
const errById = new Map(rejectReport.errors.map((e) => [e.id, e.error]));
ok(rejectReport.copied.length === 0 && rejectReport.ok === false, '拒绝场景下没有任何会话被复制，ok=false');
ok((errById.get(CID.other) || '').includes('不属于当前登录账号'), '他人账号的会话被拒绝');
ok((errById.get(CID.deleted) || '').includes('已被删除'), '已删除的会话被拒绝');
ok((errById.get(CID.claw) || '').includes('Claw'), 'Claw 工作区被拒绝');
ok((errById.get(CID.bodyless) || '').includes('正文不存在'), '没有正文的会话被拒绝');
ok((errById.get(BAD_ID) || '').includes('形状异常'), '含路径分隔符的会话 id 被拒绝（路径穿越防护）');
ok(listJsonl().length === baselineJsonl + 2, '全部拒绝时文件数不变，没有留下半成品');
ok(countRows(TARGET_UID) === 3, '全部拒绝时库里没有多出副本行');

/* ---------- 6b. 源账号 = 目标账号 ---------- */
out('\n== 6b. 源账号与目标账号相同 ==');
let sameError = '';
try {
  await copySessions({ targetAccountId: 'acct-source', ids: [CID.plain] });
} catch (err) {
  sameError = err?.message || String(err);
}
ok(sameError.includes('相同'), '源与目标同一账号时被拒绝');
let listSameError = '';
try {
  await listSessionsForSwitch({ targetAccountId: 'acct-source' });
} catch (err) {
  listSameError = err?.message || String(err);
}
ok(listSameError.includes('相同'), '列表接口对同一账号也明确拒绝');

/* ---------- 6c. 自动退出 WorkBuddy（stopApp） ---------- */
out('\n== 6c. 自动退出 WorkBuddy ==');
// 关不掉时必须中止，不能带着运行中的实例往库里写
process.env.WB_FAKE_APP_RUNNING = '1';
process.env.WB_FAKE_STOP_FAIL = '1';
const filesBeforeStopFail = listJsonl().length;
const rowsBeforeStopFail = countRows(TARGET_UID);
let stopFailError = '';
try {
  await copySessions({ targetAccountId: TARGET_ACCOUNT_ID, ids: [CID.stopApp], stopApp: true });
} catch (err) {
  stopFailError = err?.message || String(err);
}
ok(stopFailError.includes('无法退出'), '授权自动退出但进程关不掉时，明确报错并中止');
ok(
  listJsonl().length === filesBeforeStopFail && countRows(TARGET_UID) === rowsBeforeStopFail,
  '关不掉时没有任何文件或库写入'
);

// 允许自动退出 → 正常复制，并在报告里带出"确实关过进程"
delete process.env.WB_FAKE_STOP_FAIL;
const stopReport = await copySessions({ targetAccountId: TARGET_ACCOUNT_ID, ids: [CID.stopApp], stopApp: true });
ok(stopReport.ok && stopReport.copied.length === 1, '允许自动退出时复制成功');
ok(stopReport.appStop?.wasRunning === true, '报告带出「WorkBuddy 原本在运行、已被结束」');
ok(listJsonl().length === filesBeforeStopFail + 1, '复制产生了一份新正文');
ok(countRows(TARGET_UID) === rowsBeforeStopFail + 1, '目标账号库里多了一行副本');
// 未授权时仍然拒绝（默认行为不变）
process.env.WB_FAKE_APP_RUNNING = '1';
let refuseAgain = '';
try {
  await copySessions({ targetAccountId: TARGET_ACCOUNT_ID, ids: [CID.rollback] });
} catch (err) {
  refuseAgain = err?.message || String(err);
}
ok(refuseAgain.includes('正在运行'), '未勾选自动退出时，运行中仍然拒绝（默认不放行）');
process.env.WB_FAKE_APP_RUNNING = '0';

/* ---------- 7. 插入失败时回滚 ---------- */
out('\n== 7. 插入失败时的回滚 ==');
const beforeFiles = listJsonl();
const beforeTargetRows = countRows(TARGET_UID);
const blockDb = new DatabaseSync(dbPath);
// 用触发器精确制造「写正文成功、插库失败」：这是回滚路径唯一能被触发的时机
blockDb.exec(
  `CREATE TRIGGER block_target_insert BEFORE INSERT ON sessions
     WHEN NEW.user_id = '${TARGET_UID}'
     BEGIN SELECT RAISE(ABORT, '测试制造的插入失败'); END;`
);
blockDb.close();

const rollbackReport = await copySessions({ targetAccountId: TARGET_ACCOUNT_ID, ids: [CID.rollback] });
ok(rollbackReport.errors.length === 1, '插入失败被如实上报（不静默降级成成功）');
ok((rollbackReport.errors[0]?.error || '').includes('插入失败'), `错误原因透出底层约束（${rollbackReport.errors[0]?.error || '无'}）`);
ok(rollbackReport.copied.length === 0, '失败的会话不计入 copied');
ok(listJsonl().length === beforeFiles.length, '回滚后刚写出的副本正文已被清理（没有留下孤儿文件）');
ok(countRows(TARGET_UID) === beforeTargetRows, '回滚后库里没有留下副本行');
ok(
  fs.readFileSync(edgeSyncPath).toString() === edgeSyncBytes,
  '回滚路径同样没有触碰 edge-sync-mapping'
);

/* ---------- 8. 往返复制：改名同步回原会话 ---------- */
out('\n== 8. 往返复制：改名同步回原会话 ==');
// 场景：CID.other（目标账号）曾复制给源账号成为 CID.plain（反向账本可查）；
// 用户在源账号里给 CID.plain 改了名，再次切回目标账号时，新名字要回到 CID.other 上。
const REVERSE_KEY = `cn|${TARGET_UID}|${SOURCE_UID}`;
const ledgerFile = JSON.parse(fs.readFileSync(SESSION_COPIES_FILE, 'utf8'));
ledgerFile.pairs[REVERSE_KEY] = { [CID.other]: CID.plain };
fs.writeFileSync(SESSION_COPIES_FILE, JSON.stringify(ledgerFile), 'utf8');

// 模拟用户在源账号里改名（客户端会同时写 title 与 custom_title）
{
  const d = new DatabaseSync(dbPath);
  d.prepare('UPDATE sessions SET title = ?, custom_title = ? WHERE id = ?').run(
    '往返改名后的标题',
    '往返改名后的标题',
    CID.plain
  );
  d.close();
}

const beforeRoundFiles = listJsonl().length;
const beforeRoundRows = countRows(TARGET_UID);
const roundReport = await copySessions({ targetAccountId: TARGET_ACCOUNT_ID, ids: [CID.plain] });
ok(roundReport.skipped.length === 1 && roundReport.copied.length === 0, '往返复制命中账本被跳过（不产生重复会话）');
ok(
  Array.isArray(roundReport.titleSynced) && roundReport.titleSynced.length === 1,
  '报告带出 titleSynced 记录'
);
ok(
  roundReport.titleSynced?.[0]?.originId === CID.other && roundReport.titleSynced?.[0]?.title === '往返改名后的标题',
  'titleSynced 指向目标账号的原会话并带回新标题'
);
{
  const d = readDb();
  const row = d.prepare('SELECT title, custom_title FROM sessions WHERE id = ? AND user_id = ?').get(CID.other, TARGET_UID);
  d.close();
  ok(row?.title === '往返改名后的标题' && row?.custom_title === '往返改名后的标题', '原会话行的 title 与 custom_title 都已更新');
}
ok(listJsonl().length === beforeRoundFiles && countRows(TARGET_UID) === beforeRoundRows, '标题同步不产生新的正文文件或会话行');
// 只动标题两列：其他列原样保留
{
  const d = readDb();
  const row = d.prepare('SELECT unread, agent_dirty, group_title, status FROM sessions WHERE id = ?').get(CID.other);
  d.close();
  ok(row?.unread === 3 && Number(row?.agent_dirty) === 1 && row?.group_title === '分组标题', '原会话的其他列不受标题回写影响');
}

/* ---------- 9. 往返复制：副本新增内容原位回写 ---------- */
out('\n== 9. 往返复制：副本新增内容原位回写 ==');
// 接第 8 节的账本（TARGET→SOURCE: CID.other → CID.plain）。
// 用户在源账号里继续聊副本 CID.plain（正文多了 2 行），切回目标账号时
// 新增内容要合并回 CID.other 的正文，而不是跳过了事或重复复制。
{
  const d = new DatabaseSync(dbPath);
  // 副本被聊过：updated_at 推进到比原会话新的值
  d.prepare('UPDATE sessions SET updated_at = ?, last_activity_at = ? WHERE id = ?').run(
    1700000099000,
    1700000099001,
    CID.plain
  );
  d.close();
}
const plainBody = fs.readFileSync(bodyPath.plain, 'utf8');
const extraLines = [
  JSON.stringify({ id: 'msg-3', timestamp: 4, type: 'message', role: 'user', content: [{ type: 'input_text', text: '副本里新聊的第一句' }], sessionId: CID.plain }),
  JSON.stringify({ id: 'msg-4', timestamp: 5, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '副本里新聊的第二句' }], sessionId: CID.plain }),
];
fs.writeFileSync(bodyPath.plain, plainBody + extraLines.join('\n') + '\n', 'utf8');

const beforeSyncFiles = listJsonl().length;
const beforeSyncRows = countRows(TARGET_UID);
const syncReport = await copySessions({ targetAccountId: TARGET_ACCOUNT_ID, ids: [CID.plain] });
ok(
  syncReport.skipped.length === 1 && syncReport.copied.length === 0,
  '往返副本不再走复制路径（不产生重复会话）'
);
ok(
  Array.isArray(syncReport.contentSynced) && syncReport.contentSynced.length === 1,
  '报告带出 contentSynced 记录'
);
ok(
  syncReport.contentSynced?.[0]?.targetId === CID.other && syncReport.contentSynced?.[0]?.appendedLines === 2,
  'contentSynced 指向原会话且追加 2 行增量'
);
{
  const merged = fs.readFileSync(bodyPath.other, 'utf8');
  const lines = merged.split('\n').filter((l) => l.trim());
  ok(lines.length === 5, '原会话正文从 3 行变为 5 行（追加了 2 行增量）');
  ok(!merged.includes(CID.plain), '回写后的原正文不残留副本会话 id');
  ok(lines[3].includes('msg-3') && lines[4].includes('msg-4'), '追加的两行就是副本新增的消息');
}
ok(listJsonl().length === beforeSyncFiles && countRows(TARGET_UID) === beforeSyncRows, '内容回写不产生新的正文文件或会话行');
{
  const d = readDb();
  const row = d.prepare('SELECT updated_at, last_activity_at FROM sessions WHERE id = ? AND user_id = ?').get(CID.other, TARGET_UID);
  d.close();
  ok(row?.updated_at === 1700000099000 && row?.last_activity_at === 1700000099001, '原会话行的活动时间已推进到副本的新值');
}
// 备份产物里要有回写前的原正文
ok(
  fs.existsSync(path.join(syncReport.backupPath, `${CID.other}.jsonl`)),
  '回写前的原正文已备份到本次操作的备份目录'
);
// 幂等：再跑一次，没有新增量就不追加
const rerunReport = await copySessions({ targetAccountId: TARGET_ACCOUNT_ID, ids: [CID.plain] });
ok(
  (rerunReport.contentSynced || []).length === 0,
  '再次往返时无新增量，不做重复追加（幂等）'
);
ok(
  fs.readFileSync(bodyPath.other, 'utf8').split('\n').filter((l) => l.trim()).length === 5,
  '原会话正文仍为 5 行（没有被二次追加）'
);

/* ---------- 10. 两侧都新增过内容时，重复往返不得重复追加 ---------- */
out('\n== 10. 分叉后的幂等：两侧都聊过，重复往返不重复追加 ==');
// 第 7 节为了验证回滚装了 BEFORE INSERT 触发器，后面的场景要真的插入副本，先摘掉
{
  const d = new DatabaseSync(dbPath);
  d.exec('DROP TRIGGER IF EXISTS block_target_insert');
  d.close();
}
// 第 9 节结束时两侧已收敛（都是 5 行）。现在制造"分叉"：原会话与副本各自又新增了内容。
// 这时 LCP 只能停在复制时刻的快照边界，副本"新增的部分"每次都会被重算成同一段——
// 没有幂等护栏的话，同一段内容会被一遍遍追加进原会话。
{
  const d = new DatabaseSync(dbPath);
  d.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(1700000188000, CID.plain);
  d.close();
}
const originOnlyLine = JSON.stringify({
  id: 'msg-5',
  timestamp: 6,
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text: '原会话这边自己新增的一句' }],
  sessionId: CID.other,
});
const copyOnlyLine = JSON.stringify({
  id: 'msg-6',
  timestamp: 7,
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text: '副本这边新聊的一句' }],
  sessionId: CID.plain,
});
fs.appendFileSync(bodyPath.other, originOnlyLine + '\n', 'utf8');
fs.appendFileSync(bodyPath.plain, copyOnlyLine + '\n', 'utf8');
const readOriginLines = () => fs.readFileSync(bodyPath.other, 'utf8').split('\n').filter((l) => l.trim());

const forkReport = await copySessions({ targetAccountId: TARGET_ACCOUNT_ID, ids: [CID.plain] });
ok(
  forkReport.contentSynced?.[0]?.appendedLines === 1,
  `分叉后只追加副本那一行增量（实际 ${forkReport.contentSynced?.[0]?.appendedLines} 行）`
);
ok(readOriginLines().length === 7, '原会话变为 7 行（原3 + 双向各1 + 合并1）');
ok(readOriginLines().some((l) => l.includes('msg-5')) && readOriginLines().some((l) => l.includes('msg-6')), '两侧新增内容都在：没有丢内容');

const forkRerun = await copySessions({ targetAccountId: TARGET_ACCOUNT_ID, ids: [CID.plain] });
ok((forkRerun.contentSynced || []).length === 0, '同一操作重复执行不再追加（幂等护栏生效）');
ok(readOriginLines().length === 7, `重复执行后原会话仍是 7 行（实际 ${readOriginLines().length} 行，旧实现会变成 8 行）`);

/* ---------- 11. 账本记着的副本已被删除 → 不能"跳过" ---------- */
out('\n== 11. 陈旧账本：目标账号里的副本已被删除 ==');
const nestedCopyId = sessionCopyLedger('cn', SOURCE_UID, TARGET_UID)[CID.nested];
ok(!!nestedCopyId, `账本里有 CID.nested 的副本记录（${String(nestedCopyId).slice(0, 8)}…）`);
{
  const d = new DatabaseSync(dbPath);
  d.prepare('UPDATE sessions SET deleted_at = ? WHERE id = ? AND user_id = ?').run(1700000200000, nestedCopyId, TARGET_UID);
  d.close();
}
const beforeStaleRows = countRows(TARGET_UID);
// 列表也要跟着变：副本没了就不能再标「已复制」，否则界面上它会被隐藏且不可勾选，
// 用户根本点不到它去重新复制（后端修好了也够不着）。
{
  const relisted2 = await listSessionsForSwitch({ targetAccountId: TARGET_ACCOUNT_ID });
  const nestedEntry = relisted2.sessions.find((s) => s.id === CID.nested);
  const plainEntry = relisted2.sessions.find((s) => s.id === CID.plain);
  ok(nestedEntry?.copied === false, '副本被删除后列表不再标「已复制」');
  ok(plainEntry?.copied === true, '副本仍在的会话照旧标「已复制」（正向用例没被误伤）');
}
const staleReport = await copySessions({ targetAccountId: TARGET_ACCOUNT_ID, ids: [CID.nested] });
const staleDetail = staleReport.errors.length ? `（报错：${JSON.stringify(staleReport.errors)}）` : '';
ok(staleReport.skipped.length === 0, '副本已被删除时不再跳过（旧实现会误判为「已复制过」）');
ok(staleReport.copied.length === 1, `重新复制了一份${staleDetail}`);
ok(
  staleReport.copied[0]?.newId && staleReport.copied[0].newId !== nestedCopyId,
  '新副本是一个全新 id（不会复活那条已删除的行）'
);
ok(countRows(TARGET_UID) === beforeStaleRows + 1, '目标账号多了一条副本行');
ok(
  sessionCopyLedger('cn', SOURCE_UID, TARGET_UID)[CID.nested] === staleReport.copied[0].newId,
  '账本已覆盖为新副本 id（下次不会再重复复制）'
);

/* ---------- 12. 往返副本的"原会话"已被删除 → 改为普通复制 ---------- */
out('\n== 12. 往返副本的原会话已被删除 ==');
// 摘掉正向账本里 CID.plain 的记录，隔离出"原会话被删"这一个变量
{
  const f = JSON.parse(fs.readFileSync(SESSION_COPIES_FILE, 'utf8'));
  const fwdKey = `cn|${SOURCE_UID}|${TARGET_UID}`;
  if (f.pairs[fwdKey]) {
    delete f.pairs[fwdKey][CID.plain];
    fs.writeFileSync(SESSION_COPIES_FILE, JSON.stringify(f), 'utf8');
  }
}
{
  const d = new DatabaseSync(dbPath);
  // 原会话（目标账号侧）被用户删掉了：这时"原位合并"没有落点
  d.prepare('UPDATE sessions SET deleted_at = ? WHERE id = ? AND user_id = ?').run(1700000300000, CID.other, TARGET_UID);
  d.close();
}
const beforeOrphanRows = countRows(TARGET_UID);
const orphanReport = await copySessions({ targetAccountId: TARGET_ACCOUNT_ID, ids: [CID.plain] });
ok(orphanReport.skipped.length === 0, '原会话没了就不再报「已同步」（旧实现会把内容闷在副本里）');
ok(orphanReport.copied.length === 1, '改为普通复制把内容带过去');
ok(countRows(TARGET_UID) === beforeOrphanRows + 1, '目标账号多了一条新会话');
ok(
  fs.readFileSync(bodyPath.other, 'utf8').split('\n').filter((l) => l.trim()).length === 7,
  '已删除的原会话正文没有被改写'
);

/* ---------- 汇总 ---------- */
out(`\n${pass}/${total} 断言通过`);
fs.rmSync(tmpRoot, { recursive: true, force: true });
process.exit(pass === total ? 0 : 1);
