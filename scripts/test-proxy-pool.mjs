/**
 * 反向代理「账号池」回归测试（离线，不联网、不碰真实账号库）。
 *
 * 守的是一条真实踩过的坑：账号池曾经用 `hasPlainToken` 当准入判据，
 * 而那个函数**顺带把"已过期"也算成不可用**。于是「控制台离线几天、access_token 正好过期」
 * 的账号会被静默踢出池子 —— 明明 refresh_token 还有效、一次刷新就能救回来，
 * 界面却只回一句"没有可用账号"，把人往"重新扫码"上引。
 *
 * 隔离：`WB_SWITCH_HOME`（账号库）+ `FREE_TOKEN_CONFIG_DIR`（配置里的账号选择）。
 * 两者都必须在 **import 之前**设好 —— 目录常量是模块加载时算出来的。
 *
 * 运行：node scripts/test-proxy-pool.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-proxy-pool-'));
process.env.WB_SWITCH_HOME = path.join(tmp, 'wb-switch');
process.env.FREE_TOKEN_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.WB_SWITCH_HOME, { recursive: true });
fs.mkdirSync(process.env.FREE_TOKEN_CONFIG_DIR, { recursive: true });

const ACCOUNTS_FILE = path.join(process.env.WB_SWITCH_HOME, 'accounts.json');
const CONFIG_FILE = path.join(process.env.FREE_TOKEN_CONFIG_DIR, 'config.json');

const { poolAccounts, canEgress, needsRefresh } = await import('../server/proxy/index.mjs');

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
const ENVELOPE = { $wbEncrypted: true, envelope: 'ciphertext' };

/** 纯明文账号（脚本里不用真 token，只验证选择逻辑） */
const plain = (id, expiresAt) => ({
  id,
  name: id,
  uid: `uid-${id}`,
  variant: 'cn',
  access_token: `access-${id}`,
  refresh_token: `refresh-${id}`,
  expiresAt,
});

const ACCOUNTS = {
  alive: plain('alive', NOW + 7 * 24 * 3600_000), // 未过期
  stale: plain('stale', NOW - 3600_000), // 已过期，但 refresh_token 可用
  envelopeOnly: { id: 'envelopeOnly', name: 'envelopeOnly', variant: 'cn', access_token: ENVELOPE },
  envelopeWithRefresh: {
    id: 'envelopeWithRefresh',
    name: 'envelopeWithRefresh',
    variant: 'cn',
    access_token: ENVELOPE,
    refresh_token: 'refresh-x',
  },
  empty: { id: 'empty', name: 'empty', variant: 'cn' },
};

function writeAccounts(list) {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(list, null, 2), 'utf8');
}
function writeConfig(proxy) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ version: 1, settings: {}, proxy }, null, 2), 'utf8');
}
const ids = (list) => list.map((a) => a.id).sort();

// ---------------------------------------------------------------- 1. 判据本身
section('1. canEgress：什么账号能出站');
{
  check('明文 token 未过期 → 可出站', canEgress(ACCOUNTS.alive) === true);
  check('明文 token 已过期 → 仍可出站（靠 refresh_token 换新的）', canEgress(ACCOUNTS.stale) === true);
  check('加密信封 + 有 refresh_token → 可出站', canEgress(ACCOUNTS.envelopeWithRefresh) === true);
  check('加密信封 + 无 refresh_token → 不可出站', canEgress(ACCOUNTS.envelopeOnly) === false);
  check('什么都没有 → 不可出站', canEgress(ACCOUNTS.empty) === false);
}

section('2. needsRefresh：什么时候必须先刷');
{
  check('未过期且离到期还早 → 不需要刷', needsRefresh(ACCOUNTS.alive) === false);
  check('已过期 → 必须先刷', needsRefresh(ACCOUNTS.stale) === true);
  check('加密信封 → 必须先刷（换明文）', needsRefresh(ACCOUNTS.envelopeWithRefresh) === true);
  check('空 token → 必须先刷', needsRefresh(ACCOUNTS.empty) === true);
  check(
    '到期前 30 秒 → 提前刷（避免请求打到一半过期）',
    needsRefresh({ ...ACCOUNTS.alive, expiresAt: NOW + 30_000 }) === true
  );
  check(
    '到期前 10 分钟 → 还不刷',
    needsRefresh({ ...ACCOUNTS.alive, expiresAt: NOW + 10 * 60_000 }) === false
  );
}

// ---------------------------------------------------------------- 3. 池子的组成
section('3. poolAccounts：池子收谁');
{
  writeAccounts([ACCOUNTS.alive, ACCOUNTS.stale, ACCOUNTS.envelopeOnly, ACCOUNTS.envelopeWithRefresh, ACCOUNTS.empty]);
  writeConfig({ enabled: true, accountIds: null });
  check(
    '未指定 accountIds → 全部可出站账号进池',
    JSON.stringify(ids(poolAccounts())) ===
      JSON.stringify(['alive', 'envelopeWithRefresh', 'stale']),
    ids(poolAccounts())
  );
  check(
    '已过期的账号**没有被踢出池子**（这是本测试守的核心回归点）',
    poolAccounts().some((a) => a.id === 'stale')
  );

  writeConfig({ enabled: true, accountIds: ['alive'] });
  check('显式只选一个 → 池里就一个', JSON.stringify(ids(poolAccounts())) === JSON.stringify(['alive']));

  writeConfig({ enabled: true, accountIds: ['stale', 'envelopeOnly'] });
  check(
    '选中的账号里混了不可出站的 → 只留下可出站的那个',
    JSON.stringify(ids(poolAccounts())) === JSON.stringify(['stale']),
    ids(poolAccounts())
  );

  // 「一个都不选」要靠 migratedPool 标记区分于"旧配置遗留的 []"：
  // 老版本里 [] 表示"全部"，loadConfig 会把没有该标记的 [] 迁移成 null，
  // 否则老用户升级后会看到账号池突然空了。
  writeConfig({ enabled: true, accountIds: [], migratedPool: true });
  check('空数组 + 已带迁移标记 = 一个都不选 → 池为空', poolAccounts().length === 0);

  writeConfig({ enabled: true, accountIds: [] });
  check(
    '旧配置遗留的 [] 被迁移成 null（老用户升级后池子不会突然变空）',
    poolAccounts().length === 3,
    poolAccounts().length
  );

  writeConfig({ enabled: true, accountIds: ['不存在的id'] });
  check('选中的 id 都不存在 → 池为空', poolAccounts().length === 0);

  writeAccounts([]);
  check('账号库为空 → 池为空', poolAccounts().length === 0);

  writeAccounts([ACCOUNTS.envelopeOnly, ACCOUNTS.empty]);
  writeConfig({ enabled: true, accountIds: null });
  check('只剩不可出站的账号 → 池为空（界面据此提示去扫码）', poolAccounts().length === 0);
}

// ---------------------------------------------------------------- 4. 离线跨过期的场景
section('4. 场景复现：控制台离线，access_token 在离线期间过期');
{
  // 离线前（离到期还有 1 天）：在池
  writeAccounts([plain('gap', NOW + 24 * 3600_000)]);
  writeConfig({ enabled: true, accountIds: null });
  check('离线前：账号在池中', poolAccounts().length === 1);

  // 离线 3 天后回来（token 已过期 2 天）：以前会在这一步变成"没有可用账号"
  writeAccounts([plain('gap', NOW - 2 * 24 * 3600_000)]);
  const after = poolAccounts();
  check('离线跨过期后：账号仍在池中（不再静默消失）', after.length === 1, ids(after));
  check('离线跨过期后：该账号被标记为需要先刷新', needsRefresh(after[0]) === true);
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail ? 1 : 0);
