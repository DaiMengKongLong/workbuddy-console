/**
 * 凭据回写登录态文件的回归测试（离线，不联网、不碰真实账号库与真实登录态）。
 *
 * 守护 2026-10-18 用户反馈「登录状态莫名失效 + 刷新凭据提示 refresh token is invalid」的修复：
 * 官方刷新是**轮换式**的，账号库与 WorkBuddy 登录态文件各持一份 refresh_token，
 * 谁刷新谁让另一份作废。因此本工具刷新成功后，若刷新的正是当前登录账号，
 * 必须把新凭据写回登录态文件（syncTokensToAuthFile），否则 WorkBuddy 手里那份立刻失效。
 *
 * 断言：
 *   1. uid 对得上 → 写回成功，accessToken 变新值，refreshToken 同步，其余字段原样保留；
 *   2. uid 对不上（刷的不是当前账号）→ 一个字节都不动；
 *   3. 登录态文件不存在 → 静默返回 synced:false，不抛错（刷新本身不该因此失败）；
 *   4. 写回前留下备份，出问题可回滚。
 *
 * 隔离：`WB_SWITCH_HOME`（备份目录）必须在 import 之前设好；登录态文件用注入路径。
 * 运行：node scripts/test-auth-sync.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-auth-sync-'));
process.env.WB_SWITCH_HOME = path.join(tmp, 'wb-switch');
process.env.FREE_TOKEN_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.WB_SWITCH_HOME, { recursive: true });
fs.mkdirSync(process.env.FREE_TOKEN_CONFIG_DIR, { recursive: true });

const { syncTokensToAuthFile } = await import('../server/workbuddy/auth.mjs');

let pass = 0;
let fail = 0;
const failures = [];
function check(label, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    const detail = extra === undefined ? '' : ` → ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`;
    failures.push(label + detail);
    console.log(`  ✗ ${label}${detail}`);
  }
}
function section(t) {
  console.log(`\n${t}`);
}

const UID = 'u-test-0001';
const now = Date.now();

/** 官方 5.6 形态的登录态文件：token 是加密信封，另有服务端字段需要原样保留 */
function writeAuthFile(file, { uid = UID } = {}) {
  const doc = {
    account: { uid, nickname: '测试账号' },
    accounts: [{ uid }],
    allAccounts: [{ uid }],
    auth: {
      accessToken: { $wbEncrypted: 1, envelope: 'OLD_AT_ENVELOPE' },
      refreshToken: { $wbEncrypted: 1, envelope: 'OLD_RT_ENVELOPE' },
      tokenType: 'Bearer',
      scope: 'openid profile offline_access email',
      sessionState: 'keep-me',
      notBeforePolicy: 0,
      domain: 'https://copilot.tencent.com',
      lastRefreshTime: now - 86400_000,
      expiresAt: now - 1000,
      expiresIn: 0,
    },
  };
  fs.writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8');
  return doc;
}

const account = (overrides = {}) => ({
  id: UID,
  uid: UID,
  variant: 'cn',
  access_token: 'NEW_ACCESS_TOKEN_PLAIN',
  refresh_token: 'NEW_REFRESH_TOKEN_PLAIN',
  token_type: 'Bearer',
  expiresAt: now + 7 * 86400_000,
  refreshExpiresAt: now + 30 * 86400_000,
  ...overrides,
});

section('1. 当前登录账号：刷新后的新凭据写回登录态文件');
{
  const file = path.join(tmp, 'desktop.info');
  writeAuthFile(file);
  const r = await syncTokensToAuthFile(account(), { authPath: file });
  check('返回 synced: true', r.synced === true, r);
  check('留了备份', !!r.backupPath && fs.existsSync(r.backupPath), r.backupPath);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('accessToken 已换成新明文 token', doc.auth.accessToken === 'NEW_ACCESS_TOKEN_PLAIN', doc.auth.accessToken);
  check('refreshToken 已同步', doc.auth.refreshToken === 'NEW_REFRESH_TOKEN_PLAIN', doc.auth.refreshToken);
  check('expiresAt 已更新', doc.auth.expiresAt === now + 7 * 86400_000, doc.auth.expiresAt);
  check('refreshExpiresAt 已更新', doc.auth.refreshExpiresAt === now + 30 * 86400_000, doc.auth.refreshExpiresAt);
  check('lastRefreshTime 已刷新', typeof doc.auth.lastRefreshTime === 'number' && doc.auth.lastRefreshTime > now - 5000, doc.auth.lastRefreshTime);
  check('服务端字段 scope 原样保留', doc.auth.scope === 'openid profile offline_access email', doc.auth.scope);
  check('服务端字段 sessionState 原样保留', doc.auth.sessionState === 'keep-me', doc.auth.sessionState);
  check('account 段未被改动', doc.account.uid === UID && doc.account.nickname === '测试账号', doc.account);
}

section('2. 不是当前登录账号：一个字节都不动');
{
  const file = path.join(tmp, 'desktop-other.info');
  const before = JSON.stringify(writeAuthFile(file, { uid: 'someone-else' }));
  const r = await syncTokensToAuthFile(account(), { authPath: file });
  check('返回 synced: false', r.synced === false, r);
  check('原因是 not-current-account', r.reason === 'not-current-account', r.reason);
  check('文件内容未变', JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8'))) === JSON.stringify(JSON.parse(before)));
}

section('3. 登录态文件不存在：静默返回，不抛错（不能把刷新本身搞失败）');
{
  const r = await syncTokensToAuthFile(account(), { authPath: path.join(tmp, 'nope.info') });
  check('返回 synced: false', r.synced === false, r);
  check('原因是 no-auth-file', r.reason === 'no-auth-file', r.reason);
}

section('4. 没有明文 access_token（加密信封账号）：不写');
{
  const file = path.join(tmp, 'desktop-env.info');
  const before = JSON.stringify(writeAuthFile(file));
  const r = await syncTokensToAuthFile(account({ access_token: { $wbEncrypted: 1, envelope: 'X' } }), { authPath: file });
  check('返回 synced: false', r.synced === false, r);
  check('原因是 no-plain-access-token', r.reason === 'no-plain-access-token', r.reason);
  check('文件内容未变', JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8'))) === JSON.stringify(JSON.parse(before)));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  - ${f}`);
}
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}
process.exit(fail === 0 ? 0 : 1);
