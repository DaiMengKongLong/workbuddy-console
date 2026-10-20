/**
 * 「新账号入库即验活」回归测试（离线，不联网、不碰真实账号库）。
 *
 * 守的行为（2026-10-20 用户反馈：扫码添加后一直显示「待验活」，点「刷新凭据」才变绿）：
 *
 * 1. **有明文 token 就验**：拿到的是账号库里的**原始记录**（带 token），而不是给界面的
 *    `accountMeta`（token 已抹掉）——喂错对象会让验活恒失败。
 * 2. **加密信封 / 无 token 一律跳过**：这类账号发不出鉴权请求，硬验只会把徽章染红，
 *    巡检也是同样的跳过策略。
 * 3. **慢验活不能拖住响应**：扫码结果轮询是前端 1.5 秒一轮的请求，超时就先返回 null；
 *    超时之后才失败的 promise 必须已被 catch 掉，否则会冒成 unhandledRejection。
 * 4. 任何异常都吞掉返回 null —— 验活失败绝不能影响"账号已入库"这个事实。
 *
 * 隔离：`WB_SWITCH_HOME` + `FREE_TOKEN_CONFIG_DIR` 必须在 **import 之前**设好
 * （目录常量在模块加载时就算出来了）。
 *
 * 运行：node scripts/test-auto-verify.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-auto-verify-'));
process.env.WB_SWITCH_HOME = path.join(tmp, 'wb-switch');
process.env.FREE_TOKEN_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.WB_SWITCH_HOME, { recursive: true });
fs.mkdirSync(process.env.FREE_TOKEN_CONFIG_DIR, { recursive: true });

const ACCOUNTS_FILE = path.join(process.env.WB_SWITCH_HOME, 'accounts.json');

const { verifyNewAccount, NEW_ACCOUNT_VERIFY_TIMEOUT_MS, verifyStateOf } = await import(
  '../server/workbuddy/tokenRefresh.mjs'
);

let pass = 0;
let fail = 0;
const failures = [];
function check(label, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    const detail = extra === undefined ? '' : `  → ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`;
    failures.push(`${label}${detail}`);
    console.log(`  ✗ ${label}${detail}`);
  }
}

function writeAccounts(list) {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(list, null, 2));
}

const hour = 3600_000;
const plainAccount = { id: 'a1', uid: 'u1', name: '明文号', access_token: 'tok-a1', variant: 'cn', expiresAt: Date.now() + 5 * hour };
const envelopeAccount = {
  id: 'a2',
  uid: 'u2',
  name: '信封号',
  access_token: { $wbEncrypted: true, envelope: 'ZW52ZWxvcGU=' },
  variant: 'cn',
};
const bareAccount = { id: 'a3', uid: 'u3', name: '无 token 号', variant: 'cn' };

/* ---------------- 1. 正常路径：拿到原始记录并透传结论 ---------------- */
console.log('\n[1] 有明文 token：验一次，参数是原始记录，结论原样返回');
writeAccounts([plainAccount, envelopeAccount, bareAccount]);
{
  const seen = [];
  const state = { at: Date.now(), valid: true, unauthorized: false, message: '' };
  const r = await verifyNewAccount('a1', {
    verify: async (acc) => {
      seen.push(acc);
      return state;
    },
  });
  check('验活被调用一次', seen.length === 1, `调用 ${seen.length} 次`);
  check('传入的是带 token 的原始记录', seen[0]?.access_token === 'tok-a1', seen[0]);
  check('结论原样返回', r === state);
}

/* ---------------- 2. id / uid 都能定位 ---------------- */
console.log('\n[2] id 与 uid 都能命中同一条记录');
{
  const seen = [];
  const verify = async (acc) => {
    seen.push(acc.id);
    return { valid: true };
  };
  await verifyNewAccount('u1', { verify });
  await verifyNewAccount('a1', { verify });
  check('uid 可定位', seen[0] === 'a1', seen);
  check('id 可定位', seen[1] === 'a1', seen);
}

/* ---------------- 3. 该跳过的三类 ---------------- */
console.log('\n[3] 加密信封 / 无 token / 查不到 —— 一律不验');
{
  let calls = 0;
  const verify = async () => {
    calls++;
    return { valid: true };
  };
  const rEnvelope = await verifyNewAccount('a2', { verify });
  const rBare = await verifyNewAccount('a3', { verify });
  const rMissing = await verifyNewAccount('nope', { verify });
  const rEmpty = await verifyNewAccount('', { verify });
  check('信封账号返回 null', rEnvelope === null);
  check('无 token 账号返回 null', rBare === null);
  check('查不到的 id 返回 null', rMissing === null);
  check('空 id 返回 null', rEmpty === null);
  check('四种情况都没打接口', calls === 0, `实际调用 ${calls} 次`);
}

/* ---------------- 4. 慢验活：超时先返回，且不留 unhandled rejection ---------------- */
console.log('\n[4] 验活挂住/晚失败：按超时返回 null，不拖住调用方');
const unhandled = [];
process.on('unhandledRejection', (err) => unhandled.push(err));
{
  const t0 = Date.now();
  const r = await verifyNewAccount('a1', { timeoutMs: 120, verify: () => new Promise(() => {}) });
  const cost = Date.now() - t0;
  check('挂住的验活不会永远阻塞', r === null);
  check('按 timeoutMs 返回（120±120ms）', cost >= 100 && cost < 600, `${cost}ms`);
  check('超时没有写入任何验活结论', verifyStateOf('a1') === null);
}
{
  const t0 = Date.now();
  const r = await verifyNewAccount('a1', {
    timeoutMs: 80,
    // 超时之后才失败：如果不挂 catch，就会变成 unhandledRejection 把进程打崩
    verify: () => new Promise((_, reject) => setTimeout(() => reject(new Error('晚到的网络错误')), 200)),
  });
  const cost = Date.now() - t0;
  await new Promise((resolve) => setTimeout(resolve, 260));
  check('晚失败也先按超时返回 null', r === null);
  check('超时生效（80ms 左右）', cost < 200, `${cost}ms`);
  check('晚到的 rejection 被吞掉，没有 unhandledRejection', unhandled.length === 0, unhandled.map(String));
}

/* ---------------- 5. 同步抛异常也不影响入库 ---------------- */
console.log('\n[5] 验活抛异常：吞掉，返回 null');
{
  const r = await verifyNewAccount('a1', {
    verify: () => {
      throw new Error('同步炸了');
    },
  });
  check('抛异常时返回 null', r === null);
}

/* ---------------- 6. 默认超时常量 ---------------- */
console.log('\n[6] 默认超时');
check('默认超时为 5 秒且导出给测试用', NEW_ACCOUNT_VERIFY_TIMEOUT_MS === 5000, String(NEW_ACCOUNT_VERIFY_TIMEOUT_MS));

/* ---------------- 汇总 ---------------- */
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
