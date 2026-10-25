/**
 * 官方登录态文件 `workbuddy-desktop.info` 的读写与账号切换。
 *
 * 该文件是 WorkBuddy 桌面端的登录凭据，结构为四段 JSON：
 * `{ account, accounts, allAccounts, auth }`。
 *
 * 安全约束（切换前必须满足，缺一不可）：
 * 1. 先备份当前文件到 ~/.wb-switch/backups/，切换失败可回滚；
 * 2. token 字段可能是明文也可能是 WorkBuddy 5.6 加密信封，
 *    两种形态都**原样写回**——信封降级为空串会静默毁掉登录态；
 * 3. 写完立即回读校验，解析失败或结构不对就回滚到备份。
 */
import fs from 'node:fs';
import path from 'node:path';
import { authFilePath, getVariant, variantOf } from './variant.mjs';
import { durableWriteTextAsync, CRITICAL_WRITE_DELAYS } from '../store/config.mjs';
import { detectWorkbuddyProcess, killWorkbuddy, waitForWorkbuddyGone } from '../targets/workbuddy.mjs';
import {
  findAccount,
  loadAccounts,
  saveAccountsAsync,
  secretValue,
  backupAuthFile,
  isEnvelope,
  accountDisplayName,
  hasPlainToken,
  accountMeta,
} from './accounts.mjs';

/** 读取登录态文件；不存在或解析失败返回 null */
export function readAuthFile(variant) {
  try {
    const p = authFilePath(variant);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 从账号库记录构造官方 `account` 段。
 * 以 profile_raw 为底（保留服务端下发的完整字段），再覆盖关键身份字段。
 */
export function buildAccountObject(account) {
  const obj = {};
  const raw = account?.profile_raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    Object.assign(obj, structuredClone(raw));
  }
  obj.uid = account?.uid || '';
  obj.nickname = account?.nickname || '';
  // 以下字段缺失时补默认值，避免 WorkBuddy 读到不完整结构
  const defaults = {
    type: 'personal',
    accountType: '',
    idp: '',
    oneidAccountId: '',
    areaInfoComplete: false,
    isCurrentOneIdEnterprise: false,
    isCurrentOneIdPersonal: false,
    isFirstLogin: false,
    isCreator: false,
    isAdmin: false,
    uin: '',
    phoneNumber: '',
    lastLogin: true,
    pluginEnabled: true,
    deployStatus: { statusCode: 0, statusMsg: '', detailMsg: '' },
  };
  for (const [k, v] of Object.entries(defaults)) {
    if (obj[k] === undefined) obj[k] = v;
  }
  return obj;
}

/**
 * 从账号库记录构造官方 `auth` 段。
 *
 * 以 auth_raw 的内层为底，保留 scope / sessionState 等服务端字段；
 * token 用 `secretValue` 原样写入（明文字符串或加密信封都保持原形态）。
 */
export function buildAuthObject(account) {
  const obj = {};
  const raw = account?.auth_raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const inner = raw.auth && typeof raw.auth === 'object' ? raw.auth : raw;
    Object.assign(obj, structuredClone(inner));
  }
  const now = Date.now();
  obj.accessToken = secretValue(account, 'access_token') || '';
  obj.refreshToken = secretValue(account, 'refresh_token') || '';
  obj.tokenType = account?.token_type || 'Bearer';
  obj.domain = account?.domain || getVariant(variantOf(account)).apiEndpoint;
  obj.lastRefreshTime = now;
  if (obj.scope === undefined) obj.scope = 'openid profile offline_access email';

  const expiresAt = Number(account?.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt > 0) {
    obj.expiresAt = expiresAt;
    obj.expiresIn = Math.max(0, Math.floor((expiresAt - now) / 1000));
    const refreshExpiresAt = Number(account?.refreshExpiresAt) || expiresAt;
    if (obj.refreshExpiresAt === undefined) obj.refreshExpiresAt = refreshExpiresAt;
    obj.refreshExpiresIn = Math.max(0, Math.floor((refreshExpiresAt - now) / 1000));
  } else {
    if (obj.expiresIn === undefined) obj.expiresIn = 0;
    if (obj.refreshExpiresIn === undefined) obj.refreshExpiresIn = 0;
  }
  return obj;
}

/**
 * 把账号库里的**最新凭据**回写到登录态文件（仅当该账号就是当前登录账号时）。
 *
 * ## 为什么必须有这一步（2026-10-18 用户反馈「登录状态莫名失效」）
 *
 * 官方刷新是**轮换式**的：一次刷新成功，旧 refresh_token 立即作废。而同一账号的凭据
 * 同时存在两处——账号库（本工具刷新后更新）与登录态文件（WorkBuddy 自己维护）。
 * 只更新账号库时，WorkBuddy 手里还攥着已经作废的旧 refresh_token，它下一次自己刷新
 * 就会失败 → 用户看到「登录状态莫名其妙失效」。
 *
 * 所以本工具刷新成功后，只要刷新的就是**当前登录账号**，就顺手把新凭据写回登录态文件，
 * 让两边保持一致。写入方式与 `switchAccount` 相同：备份 → 原子写 → 回读校验 → 失败回滚。
 * token 用明文写入（官方客户端接受明文并在自己下次刷新时重新加密），
 * **其余字段（scope/sessionState/notBeforePolicy 等）原样保留**。
 *
 * 非当前账号（或登录态文件不存在/uid 对不上）时不做任何事，返回 `{ synced: false }`。
 */
export async function syncTokensToAuthFile(account, { authPath: overridePath = null } = {}) {
  const variant = variantOf(account);
  const authPath = overridePath || authFilePath(variant);
  let doc;
  try {
    if (!fs.existsSync(authPath)) return { synced: false, reason: 'no-auth-file' };
    doc = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  } catch {
    return { synced: false, reason: 'auth-file-unreadable' };
  }
  const liveUid = doc?.account?.uid;
  if (!liveUid || !account?.uid || String(liveUid) !== String(account.uid)) {
    return { synced: false, reason: 'not-current-account' };
  }
  const access = secretValue(account, 'access_token');
  const refresh = secretValue(account, 'refresh_token');
  if (typeof access !== 'string' || !access) return { synced: false, reason: 'no-plain-access-token' };

  const auth = doc.auth && typeof doc.auth === 'object' ? doc.auth : {};
  const now = Date.now();
  const before = { accessToken: auth.accessToken, refreshToken: auth.refreshToken };
  auth.accessToken = access;
  if (typeof refresh === 'string' && refresh) auth.refreshToken = refresh;
  auth.lastRefreshTime = now;
  const expiresAt = Number(account?.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt > 0) {
    auth.expiresAt = expiresAt;
    auth.expiresIn = Math.max(0, Math.floor((expiresAt - now) / 1000));
  }
  const refreshExpiresAt = Number(account?.refreshExpiresAt);
  if (Number.isFinite(refreshExpiresAt) && refreshExpiresAt > 0) {
    auth.refreshExpiresAt = refreshExpiresAt;
    auth.refreshExpiresIn = Math.max(0, Math.floor((refreshExpiresAt - now) / 1000));
  }
  doc.auth = auth;

  const backup = backupAuthFile(authPath, `authsync-${variant.id}`);
  try {
    // 带退避重试的持久写（异步，不冻结事件循环）：本机写盘会被间歇拦截（EPERM），
    // 裸写一次失败就整条链路放弃。巡检路径不用复活守卫——不能杀用户正在用的 WorkBuddy
    await durableWriteTextAsync(authPath, JSON.stringify(doc, null, 2));
  } catch (err) {
    return { synced: false, reason: `write-failed: ${err?.message || err}` };
  }
  // 回读校验：写坏了立刻回滚，绝不留下半成品登录态（按 authPath 读，测试可注入临时文件）
  let verify = null;
  try {
    verify = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  } catch {
    verify = null;
  }
  if (!verify || verify?.auth?.accessToken !== access) {
    if (backup && fs.existsSync(backup)) fs.copyFileSync(backup, authPath);
    else {
      // 没有备份（理论上不会发生）时至少把内存里的旧值写回
      try {
        doc.auth.accessToken = before.accessToken;
        doc.auth.refreshToken = before.refreshToken;
        fs.writeFileSync(authPath, JSON.stringify(doc, null, 2), 'utf8');
      } catch {
        /* 只能放弃 */
      }
    }
    return { synced: false, reason: 'verify-failed' };
  }
  return { synced: true, authFilePath: authPath, backupPath: backup };
}

/**
 * 登录态写盘期间的「复活守卫」：WorkBuddy 被 taskkill 强杀后会被系统的崩溃自动恢复
 * 重新拉起（stopWorkbuddy 注释里的已知现象），新实例启动时会打开/锁住 auth 文件。
 * 切换流程里「杀进程 → 搬会话 → 写登录态」的会话搬家一步可能耗时几十秒，正好把
 * 写盘窗口撞进自动重启实例的启动期——2026-10-25 用户切换账号即此：38 秒重试全灭。
 * 每轮写盘失败后先探一次，发现 WorkBuddy 又活了就再杀一轮，把锁源掐掉再继续重试。
 */
async function rekillWorkbuddyGuard(waitedMs, round) {
  let proc = null;
  try {
    proc = await detectWorkbuddyProcess();
  } catch {
    return; // 探测不出就当没复活（探测失败不该中断写盘重试）
  }
  if (!proc?.running) return;
  console.log(
    `[switch] 写盘第 ${round} 轮仍失败（已等 ${Math.round(waitedMs / 1000)}s），` +
      `发现 WorkBuddy 又在运行（pid=${proc.pid}，疑被崩溃自动恢复拉起），再次结束以释放登录态文件`
  );
  try {
    await killWorkbuddy(proc.exePath || null);
    await waitForWorkbuddyGone(4000);
  } catch (e) {
    console.log(`[switch] 复活守卫结束进程失败（继续重试写盘）：${e?.message || e}`);
  }
}

/**
 * 切换账号：把目标账号写入登录态文件。
 *
 * 流程：校验 → 备份 → 原子写（约 3 分钟重试窗口 + 复活守卫）→ 回读校验 → 失败回滚。
 * 异步函数：重试退避期间不冻结事件循环（同步版会把整个服务冻住，在途请求全部超时）。
 * 返回 { ok, backupPath, variant, account }。
 */
export async function switchAccount(accountId) {
  const account = findAccount(accountId);
  if (!account) throw new Error('账号不存在');

  const variant = variantOf(account);
  // 没有可用 token 的账号无法建立登录态
  if (!hasPlainToken(account) && !isEnvelope(account?.access_token)) {
    throw new Error(
      `账号「${accountDisplayName(account)}」没有可用的 access_token，` +
        '无法切换。请先用 WorkBuddy 登录该账号，或重新授权导入'
    );
  }

  const authPath = authFilePath(variant);
  fs.mkdirSync(path.dirname(authPath), { recursive: true });

  const accountObj = buildAccountObject(account);
  const authObj = buildAuthObject(account);
  const doc = {
    account: accountObj,
    accounts: [accountObj],
    allAccounts: [accountObj],
    auth: authObj,
  };

  // 切换前备份（即使当前文件不存在也无妨，返回 null）
  const backup = backupAuthFile(authPath, `workbuddy-desktop-${variant.id}`);

  const writeStarted = Date.now();
  try {
    // 加长窗口（~3 分钟）+ 复活守卫：36 秒窗口盖不住「自动恢复实例启动锁」和
    // 外部进程的间歇锁窗（2026-10-25 实测 38 秒重试全灭、目录锁约 3 分钟）
    const ms = await durableWriteTextAsync(authPath, JSON.stringify(doc, null, 2), {
      delays: CRITICAL_WRITE_DELAYS,
      onRetry: rekillWorkbuddyGuard,
    });
    if (ms > 2000) console.log(`[switch] 登录态文件落盘耗时 ${ms}ms`);
  } catch (err) {
    const waited = Math.round((Date.now() - writeStarted) / 1000);
    console.log(`[switch] 登录态文件写入失败（累计重试 ${waited}s）：${err?.message || err}`);
    throw new Error(
      `写入登录态文件失败（已重试 ${waited} 秒）：${err?.message || err}。` +
        '常见原因：WorkBuddy 被结束后又被系统自动拉起、启动期间锁住登录态文件（重试期间已反复结束它）；' +
        '文件被杀毒软件/同步盘占用；WorkBuddy 尚未完全退出'
    );
  }

  // 回读校验：结构不对立刻回滚，绝不留下半成品登录态
  const verify = readAuthFile(variant);
  if (!verify || typeof verify !== 'object' || !verify.auth) {
    if (backup && fs.existsSync(backup)) fs.copyFileSync(backup, authPath);
    throw new Error('登录态文件回读校验失败，已回滚到切换前的备份');
  }
  // 校验 token 是否真的写进去了（信封原样写回，明文可直接比对）
  const written = verify.auth.accessToken;
  const expected = authObj.accessToken;
  if (typeof expected === 'string' && expected && written !== expected) {
    if (backup && fs.existsSync(backup)) fs.copyFileSync(backup, authPath);
    throw new Error('登录态文件回读校验失败（token 不一致），已回滚到切换前的备份');
  }

  return {
    ok: true,
    backupPath: backup,
    authFilePath: authPath,
    variant: variant.id,
    account: accountMeta(account),
    /** 切换后需要重启 WorkBuddy 才会生效 */
    needRestart: true,
  };
}

/**
 * 读取当前登录态对应的账号（用于在界面上标记"当前使用中"）。
 * 登录态文件里的 uid 与账号库比对；比对不上说明该账号尚未导入。
 */
export function detectCurrentAccount() {
  const result = { variant: 'cn', authFilePath: null, exists: false, account: null, uid: null };
  for (const vid of ['cn', 'ai']) {
    const authPath = authFilePath(vid);
    const doc = readAuthFile(vid);
    if (!doc) continue;
    if (!result.exists) {
      result.authFilePath = authPath;
      result.variant = vid;
      result.exists = true;
    }
    // 优先取有明文 token 的档位（国际版与国内版可能同时存在登录态）
    const uid = doc?.account?.uid || doc?.auth?.sessionState || null;
    if (uid && result.uid == null) result.uid = uid;
  }
  if (!result.uid) return result;
  result.account = loadAccounts().find((a) => a?.uid === result.uid) || null;
  if (result.account) {
    result.account = accountMeta(result.account);
    // 同时存在两份登录态时，提示当前读到的是哪个
    const bothVariants = ['cn', 'ai'].filter((v) => readAuthFile(v));
    if (bothVariants.length > 1) {
      const active = variantOf(result.account).id;
      result.variant = active;
      result.authFilePath = authFilePath(active);
      result.warning = `国内版与国际版都存在登录态文件，当前账号（${active === 'cn' ? '国内版' : '国际版'}）优先`;
    }
  }
  return result;
}

/**
 * 从登录态文件导入本机当前账号到账号库（去重：uid 已存在则覆盖 token）。
 */
export async function importLocalAccount(variantId = 'cn') {
  const variant = getVariant(variantId);
  const doc = readAuthFile(variant.id);
  if (!doc) throw new Error('未读取到本地 WorkBuddy 登录信息（登录态文件不存在或已损坏）');

  const uid = doc?.account?.uid;
  if (!uid) throw new Error('登录态文件中没有账号标识（uid），无法导入');

  const auth = doc.auth || {};
  const accessToken = auth.accessToken;
  const refreshToken = auth.refreshToken;
  // WorkBuddy 5.6+ 客户端把 token/昵称/手机号加密成信封（{$wbEncrypted, envelope}）存储。
  // 信封没有明文、不能当凭据调接口，但必须**原样保留**——
  // 之前直接降级为空串，导致「导入国内版」后卡片显示「无可用凭据」、展示名回退成 UID；
  // 保留信封至少能标记为「加密凭据」，且切换账号时可以把信封原样写回登录态文件。
  const plainAccess =
    typeof accessToken === 'string' ? accessToken : isEnvelope(accessToken) ? accessToken : '';
  const plainRefresh =
    typeof refreshToken === 'string' ? refreshToken : isEnvelope(refreshToken) ? refreshToken : '';

  const now = Date.now();
  const record = {
    id: uid,
    uid,
    nickname: doc?.account?.nickname && !isEnvelope(doc.account.nickname) ? doc.account.nickname : '',
    email: '',
    domain: auth.domain || variant.apiEndpoint,
    variant: variant.id,
    access_token: plainAccess,
    refresh_token: plainRefresh,
    token_type: auth.tokenType || 'Bearer',
    expiresAt: Number(auth.expiresAt) || (Number(auth.expiresIn) ? now + Number(auth.expiresIn) * 1000 : 0),
    refreshExpiresAt: Number(auth.refreshExpiresAt) || 0,
    refreshedAt: Number(auth.lastRefreshTime) || now,
    createdAt: now,
    profile_raw: doc?.account || {},
    auth_raw: { auth: auth },
  };

  const accounts = loadAccounts();
  const idx = accounts.findIndex((a) => a?.uid === uid);
  if (idx >= 0) {
    // 已存在：保留原有的备注等本地字段，只更新凭据
    record.note = accounts[idx].note;
    record.displayField = accounts[idx].displayField;
    record.createdAt = accounts[idx].createdAt || now;
    // 登录态文件里取不到明文（信封/缺失）而账号库已有可用凭据时，
    // 不让空值把已有凭据冲掉——否则扫过码的账号再点一次「导入」就变成「无可用凭据」
    if (!plainAccess && accounts[idx].access_token) {
      record.access_token = accounts[idx].access_token;
    }
    // 信封会覆盖明文凭据：登录态文件是信封时，账号库里的明文 token 必须保留，
    // 否则扫码得来的积分查询能力会被一次「导入」毁掉（2026-10-22 反馈）
    if (isEnvelope(plainAccess) && typeof secretValue(accounts[idx], 'access_token') === 'string') {
      record.access_token = accounts[idx].access_token;
      record.expiresAt = accounts[idx].expiresAt;
      record.refreshExpiresAt = accounts[idx].refreshExpiresAt;
    }
    if (!plainRefresh && accounts[idx].refresh_token) {
      record.refresh_token = accounts[idx].refresh_token;
    }
    // refresh_token 同理：信封不覆盖明文
    if (isEnvelope(plainRefresh) && typeof secretValue(accounts[idx], 'refresh_token') === 'string') {
      record.refresh_token = accounts[idx].refresh_token;
    }
    // nickname 同理：登录态文件里加密了，但账号库里有明文昵称时保留
    if (!record.nickname && accounts[idx].nickname && !isEnvelope(accounts[idx].nickname)) {
      record.nickname = accounts[idx].nickname;
    }
    accounts[idx] = { ...accounts[idx], ...record };
  } else {
    accounts.push(record);
  }
  await saveAccountsAsync(accounts);
  return accountMeta(record);
}

/** 删除账号（按 id）。当前登录中的账号不允许删，避免把用户锁在门外。 */
export async function deleteAccount(accountId) {
  const accounts = loadAccounts();
  const target = accounts.find((a) => a?.id === accountId);
  if (!target) throw new Error('账号不存在');
  const current = detectCurrentAccount();
  if (current.account?.id === target.id) {
    throw new Error('这是当前正在使用的账号，删除后 WorkBuddy 会失去登录态。请先切换到其他账号再删除');
  }
  await saveAccountsAsync(accounts.filter((a) => a?.id !== accountId));
  return { ok: true };
}

/** 修改账号本地备注（不触碰任何凭据） */
export async function updateAccountDisplay(accountId, patch = {}) {
  const accounts = loadAccounts();
  const idx = accounts.findIndex((a) => a?.id === accountId);
  if (idx < 0) throw new Error('账号不存在');
  if (typeof patch.note === 'string') accounts[idx].note = patch.note.trim();
  if (typeof patch.displayField === 'string') {
    // 只接受三种取值，避免写入脏数据导致展示名解析异常
    accounts[idx].displayField = ['auto', 'note', 'phone'].includes(patch.displayField)
      ? patch.displayField
      : 'auto';
  }
  await saveAccountsAsync(accounts);
  return accountMeta(accounts[idx]);
}