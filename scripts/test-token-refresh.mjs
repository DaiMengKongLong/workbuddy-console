/**
 * 「账号凭据自动刷新 + 版本自检」回归测试（离线，不联网、不碰真实账号库）。
 *
 * 守两条容易写错、写错了又很难在界面上看出来的判据：
 *
 * 1. **刷新时机**：只在 access_token / refresh_token **临期**时才动手。
 *    - 判太早 → 天天轮换凭据，与 WorkBuddy 自己持有的那份互相踩；
 *    - 判太晚 → 账号已经死了才想起来救，只能重新扫码。
 *    两个有效期字段都缺失时必须**一动不动**（判断不了就别猜）。
 * 2. **有没有新版**：必须"远端严格更新"才算。本机开发版常常领先于已发布的 tag
 *    （本地 0.2.0、最新 Release 0.1.2），按"版本号不相等即有更新"会把用户引向一次**降级**安装。
 *
 * 隔离：`WB_SWITCH_HOME`（账号库）+ `FREE_TOKEN_CONFIG_DIR`（配置与缓存），
 * 两者都必须在 **import 之前**设好 —— 目录常量是模块加载时算出来的。
 *
 * 运行：node scripts/test-token-refresh.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-token-refresh-'));
process.env.WB_SWITCH_HOME = path.join(tmp, 'wb-switch');
process.env.FREE_TOKEN_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.WB_SWITCH_HOME, { recursive: true });
fs.mkdirSync(process.env.FREE_TOKEN_CONFIG_DIR, { recursive: true });

const ACCOUNTS_FILE = path.join(process.env.WB_SWITCH_HOME, 'accounts.json');
const REFRESH_LOGS_FILE = path.join(process.env.WB_SWITCH_HOME, 'token_refresh_logs.json');

const { compareVersions, parseVersion, pickAsset, LOCAL_VERSION } = await import('../server/update.mjs');
const { refreshPlanFor, refreshAccounts, ACCESS_MIN_HOURS, REFRESH_MIN_HOURS, loadRefreshLogs } = await import(
  '../server/workbuddy/tokenRefresh.mjs'
);
const { loadAccounts } = await import('../server/workbuddy/accounts.mjs');

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

const NOW = Date.now();
const HOUR = 3600_000;

/** 造一个账号：hours 为剩余小时数（null = 该字段缺失，负数 = 已过期） */
const acct = (id, { accessHours = null, refreshHours = null, refresh = true } = {}) => ({
  id,
  uid: `uid-${id}`,
  name: id,
  variant: 'cn',
  domain: 'https://www.codebuddy.cn',
  access_token: `access-${id}`,
  ...(refresh ? { refresh_token: `refresh-${id}` } : {}),
  ...(accessHours == null ? {} : { expiresAt: NOW + accessHours * HOUR }),
  ...(refreshHours == null ? {} : { refreshExpiresAt: NOW + refreshHours * HOUR }),
});

function writeAccounts(list) {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(list, null, 2), 'utf8');
}

// ---------------------------------------------------------------- 1. 版本比较
section('1. 版本比较：只有远端严格更新才算有新版');
{
  check('本机版本来自 package.json', /^\d+\.\d+\.\d+/.test(LOCAL_VERSION), LOCAL_VERSION);
  check('0.2.1 > 0.2.0', compareVersions('0.2.1', '0.2.0') === 1);
  check('0.2.0 < 0.2.1', compareVersions('0.2.0', '0.2.1') === -1);
  check('v 前缀不影响比较', compareVersions('v0.2.0', '0.2.0') === 0);
  check('缺位补零：0.2 与 0.2.0 相等', compareVersions('0.2', '0.2.0') === 0);
  check('0.10.0 > 0.9.9（按数字而非字符串比）', compareVersions('0.10.0', '0.9.9') === 1);
  check('1.0.0 > 0.99.99', compareVersions('1.0.0', '0.99.99') === 1);
  check('预发布后缀按正式号比较：0.2.1-beta 与 0.2.1 视为相等', compareVersions('0.2.1-beta.3', '0.2.1') === 0);
  check('无法解析时保守视为相等（不会误报升级）', compareVersions('not-a-version', '0.2.0') === 0);
  check('parseVersion 取出数字段', JSON.stringify(parseVersion('v0.2.10')) === '[0,2,10]');
  check('开发版领先于已发布 tag 时 → 不算有新版（关键回归）', compareVersions('0.1.2', '0.2.0') < 0);
}

section('2. 安装包挑选：先同后缀同架构，再退一步只按后缀');
{
  const assets = [
    { name: 'WorkBuddy-Console-0.2.1-mac-arm64.dmg', browser_download_url: 'https://x/mac-arm' },
    { name: 'WorkBuddy-Console-0.2.1-mac-x64.dmg', browser_download_url: 'https://x/mac-x64' },
    { name: 'WorkBuddy-Console-0.2.1-win-x64.exe', browser_download_url: 'https://x/win' },
  ];
  check(
    'Windows x64 → 命中 .exe',
    pickAsset(assets, { platform: 'win32', arch: 'x64' })?.url === 'https://x/win'
  );
  check(
    'macOS arm64 → 命中 arm64 dmg 而不是 x64',
    pickAsset(assets, { platform: 'darwin', arch: 'arm64' })?.url === 'https://x/mac-arm'
  );
  check(
    '老命名（Free-Token-0.1.2-win-x64.exe）同样能识别',
    pickAsset([{ name: 'Free-Token-0.1.2-win-x64.exe', browser_download_url: 'https://x/old' }], {
      platform: 'win32',
      arch: 'x64',
    })?.url === 'https://x/old'
  );
  check(
    '只有别的平台的产物时 → 返回 null（由调用方回落到 Release 页面）',
    pickAsset(assets, { platform: 'linux', arch: 'x64' }) === null
  );
  check('空列表不抛错', pickAsset([], { platform: 'win32', arch: 'x64' }) === null);
}

// ---------------------------------------------------------------- 3. 刷新判据
section('3. 刷新判据 refreshPlanFor：只在临期时动手');
{
  const due = refreshPlanFor(acct('a', { accessHours: 10, refreshHours: 300 }), { now: NOW });
  check('access 只剩 10 小时 → 到期必须刷', due.due === true && due.reason === 'access-expiring', due);

  const accessJustOver = refreshPlanFor(acct('b', { accessHours: ACCESS_MIN_HOURS + 1, refreshHours: 300 }), {
    now: NOW,
  });
  check(
    `access 还剩 ${ACCESS_MIN_HOURS + 1} 小时（刚过阈值）→ 不刷`,
    accessJustOver.due === false && accessJustOver.reason === 'ok',
    accessJustOver
  );

  const refreshDue = refreshPlanFor(acct('c', { accessHours: 2000, refreshHours: REFRESH_MIN_HOURS - 1 }), {
    now: NOW,
  });
  check(
    'access 很充裕但 refresh 快到期 → 也要刷（兜底，refresh 一死就救不回来）',
    refreshDue.due === true && refreshDue.reason === 'refresh-expiring',
    refreshDue
  );

  const fresh = refreshPlanFor(acct('d', { accessHours: 300, refreshHours: 400 }), { now: NOW });
  check('两个都充裕 → 不刷', fresh.due === false && fresh.reason === 'ok', fresh);

  const dead = refreshPlanFor(acct('e', { accessHours: -5, refreshHours: -1 }), { now: NOW });
  check('refresh 已过期 → 标记 dead 且不刷（刷了也是白刷）', dead.dead === true && dead.due === false, dead);

  const noRefresh = refreshPlanFor(acct('f', { accessHours: 100, refresh: false }), { now: NOW });
  check(
    '没有 refresh_token → 不刷，给出「需重新扫码」的原因',
    noRefresh.due === false && noRefresh.reason === 'no-refresh-token',
    noRefresh
  );

  const noRefreshDead = refreshPlanFor(acct('g', { accessHours: -1, refresh: false }), { now: NOW });
  check('没有 refresh_token 且 access 也过期 → dead', noRefreshDead.dead === true, noRefreshDead);

  const unknown = refreshPlanFor(acct('h', {}), { now: NOW });
  check(
    '两个有效期字段都缺失 → 一动不动（判断不了就别猜）',
    unknown.due === false && unknown.dead === false && unknown.reason === 'unknown-expiry',
    unknown
  );
  check('缺失的有效期对外是 null 而不是 0', unknown.accessHours === null && unknown.refreshHours === null, unknown);

  const forced = refreshPlanFor(acct('i', { accessHours: 500, refreshHours: 500 }), { now: NOW, force: true });
  check('force → 无条件刷（用户明确要求）', forced.due === true && forced.reason === 'manual', forced);

  const envelopeAccess = refreshPlanFor(
    { ...acct('j', { refreshHours: 500 }), access_token: { $wbEncrypted: true, envelope: 'x' } },
    { now: NOW }
  );
  check('access 是加密信封但有明文 refresh_token → 仍可刷新', envelopeAccess.due === false && !envelopeAccess.hasPlainAccess, envelopeAccess);
}

// ---------------------------------------------------------------- 4. 端到端
section('4. refreshAccounts：真的刷、真的写回、真的记账');
{
  const realFetch = globalThis.fetch;
  const called = [];
  globalThis.fetch = async (url) => {
    called.push(String(url));
    return new Response(
      JSON.stringify({
        code: 0,
        data: {
          accessToken: 'brand-new-access',
          refreshToken: 'brand-new-refresh',
          expiresIn: 30 * 24 * 3600,
          refreshExpiresIn: 45 * 24 * 3600,
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };

  try {
    writeAccounts([
      acct('due', { accessHours: 2, refreshHours: 200 }),
      acct('fresh', { accessHours: 400, refreshHours: 800 }),
      acct('dead', { accessHours: -10, refreshHours: -5 }),
      acct('noRefresh', { accessHours: 5, refresh: false }),
    ]);

    const { results, summary } = await refreshAccounts({ delayMs: 0 });
    const byId = Object.fromEntries(results.map((r) => [r.accountId, r]));

    check('临期账号被刷新', byId.due?.action === 'refreshed', byId.due);
    check('刷新原因被记录（access-expiring）', byId.due?.reason === 'access-expiring', byId.due);
    check('有效期充裕的账号被跳过', byId.fresh?.action === 'skipped', byId.fresh);
    check('refresh 已过期的账号被标记 dead', byId.dead?.action === 'dead', byId.dead);
    check('无 refresh_token 的账号不刷并给出原因', byId.noRefresh?.action === 'dead' || byId.noRefresh?.action === 'skipped', byId.noRefresh);

    check('汇总口径正确', summary.refreshed === 1 && summary.skipped === 1 && summary.dead === 2, summary);
    check('只对真正要刷的账号发了请求（1 次）', called.length === 1, called.length);

    const after = loadAccounts().find((a) => a.id === 'due');
    check('新 access_token 已原子写回账号库', after?.access_token === 'brand-new-access', after?.access_token);
    check('refresh_token 一并更新', after?.refresh_token === 'brand-new-refresh');
    check(
      '到期时间按 expiresIn 顺延（≈30 天）',
      Math.abs((after.expiresAt - Date.now()) / HOUR - 30 * 24) < 1,
      Math.round((after.expiresAt - Date.now()) / HOUR)
    );
    check(
      '刷新后的判定变成「有效期充足」',
      refreshPlanFor(after, { now: Date.now() }).due === false,
      refreshPlanFor(after, { now: Date.now() })
    );

    const untouched = loadAccounts().find((a) => a.id === 'fresh');
    check('未临期的账号内容一字未动', untouched?.access_token === 'access-fresh');

    const logs = loadRefreshLogs();
    check('刷新动作写入了日志', logs.length >= 1 && logs[0].action === 'refreshed', logs[0]);
    check('日志里不含任何 token', !JSON.stringify(logs).includes('brand-new-access'));

    // 按账号 + force：用户明确点在某一个账号上时不看临期
    const one = await refreshAccounts({ accountIds: ['fresh'], force: true, delayMs: 0 });
    check('force + 指定账号 → 即使充裕也刷', one.results[0]?.action === 'refreshed', one.results[0]);

    // 反向验证：force=false 时不会因为"指定了账号"就刷
    writeAccounts([acct('fresh2', { accessHours: 400, refreshHours: 800 })]);
    const quiet = await refreshAccounts({ accountIds: ['fresh2'], delayMs: 0 });
    check('指定账号但未临期 → 仍然跳过', quiet.results[0]?.action === 'skipped', quiet.results[0]);
    check('跳过时不发任何网络请求', called.length === 2, called.length);

    // 官方报错时不得抛，而是逐账号记失败原因
    writeAccounts([acct('boom', { accessHours: 1, refreshHours: 100 })]);
    globalThis.fetch = async () => new Response('{"code":400,"message":"refresh_token 无效"}', { status: 400 });
    const failed = await refreshAccounts({ delayMs: 0 });
    check('官方拒绝时不抛错，回报为 failed', failed.results[0]?.action === 'failed', failed.results[0]);
    check('失败原因带上官方返回内容', /HTTP 400/.test(failed.results[0]?.message || ''), failed.results[0]?.message);
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('失败项：\n' + failures.map((f) => `  - ${f}`).join('\n'));
  process.exitCode = 1;
}
