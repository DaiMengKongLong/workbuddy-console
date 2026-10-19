/**
 * 版本自检：本机版本 vs GitHub Release 最新 tag。
 *
 * 三个设计要点（都踩过或想过坑）：
 *
 * 1. **只有远端严格更新才算"有新版"**。本机开发版常常领先于已发布的 tag（本地 0.2.0 而最新
 *    Release 还是 0.1.2），若按"版本号不相等即有更新"，左下角的升级按钮会把用户指向一次**降级**。
 * 2. **结果带磁盘缓存（6 小时）**。GitHub 未认证请求限每小时 60 次；界面每次挂载都查既浪费额度，
 *    也让离线用户反复等一次超时。缓存**只在请求成功时写**，失败绝不覆盖上一次的成功结果。
 * 3. **失败不抛错**。网络不通 / 仓库不可达 / 命中限流时返回 `ok:false` + 可读原因，界面据此
 *    **不显示**按钮（而不是弹一个红色报错——没有新版本来就是常态）。
 *
 * 隐私说明：这是本工具唯一一处访问非官方服务的出站请求（GitHub API，只读 Release 元数据，
 * 不上报任何本地信息）。设置里的「检查更新」开关关掉后，自动检查整体停用。
 *
 * 出站走 `proxyFetch`，因此自动尊重「设置 → 网络代理」与环境变量 / Windows 系统代理。
 */
import fs from 'node:fs';
import { proxyFetch } from './proxy.mjs';
import { readJsonFile } from './workbuddy/accounts.mjs';
import { atomicWriteJson, cachePath } from './store/config.mjs';

/** 本机版本：唯一事实来源就是 package.json，界面不再硬编码版本号 */
const PKG = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const LOCAL_VERSION = String(PKG.version || '0.0.0');

/** Release 所在仓库（GitHub 仓库已改名，发布与 Actions 都在 workbuddy-console） */
export const RELEASE_REPO = 'walter-io/workbuddy-console';

const CACHE_FILE_NAME = 'update-check.json';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 小时
const REQUEST_TIMEOUT_MS = 15_000;
const NOTES_LIMIT = 600;

const cacheFile = () => cachePath(CACHE_FILE_NAME);

/**
 * 版本号规范化 → 数字数组。
 * `v0.2.1` / `0.2.1` / `0.2.1-beta.3` → [0,2,1]（预发布后缀只用于相等判断时的"更旧"处理，
 * 这里不参与比较：正式版与预发布同号时按正式版更新，属于可接受的宽松处理）。
 */
export function parseVersion(v) {
  const m = String(v || '')
    .trim()
    .replace(/^v/i, '')
    .match(/^(\d+(?:\.\d+)*)/);
  if (!m) return null;
  return m[1].split('.').map((n) => Number(n) || 0);
}

/** 语义化比较：a > b 返回 1，a < b 返回 -1，相等（或缺位数视为 0）返回 0；无法解析视为相等 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** 当前平台期望的安装包后缀（NSIS 安装器 / macOS 磁盘映像） */
function preferredExts(platform) {
  if (platform === 'win32') return ['.exe'];
  if (platform === 'darwin') return ['.dmg', '.zip'];
  return ['.AppImage', '.deb', '.zip'];
}

/** 架构名在不同产物里的写法不一样，都认 */
function archTokens(arch) {
  if (arch === 'arm64') return ['arm64', 'aarch64'];
  if (arch === 'x64') return ['x64', 'amd64', 'x86_64'];
  return [String(arch || '')].filter(Boolean);
}

/**
 * 从 Release 附件里挑出与当前平台/架构匹配的那个。
 *
 * 产物命名随版本变过（早期叫 `Free-Token-0.1.2-win-x64.exe`，现为
 * `WorkBuddy-Console-0.2.1-win-x64.exe`），所以只按"后缀 + 架构关键词"匹配，不锚定前缀。
 * 两段式：先要求后缀与架构都对；架构对不上时退一步只按后缀取第一个（macOS 双架构产物齐全，
 * 这里主要兜住"Release 只传了一个架构"的情况）。都匹配不到返回 null，由调用方回落到 Release 页面。
 */
export function pickAsset(assets, { platform = process.platform, arch = process.arch } = {}) {
  const list = (Array.isArray(assets) ? assets : []).filter((a) => a?.browser_download_url);
  const exts = preferredExts(platform);
  const tokens = archTokens(arch).map((t) => t.toLowerCase());
  for (const ext of exts) {
    const sameExt = list.filter((a) => String(a.name || '').toLowerCase().endsWith(ext.toLowerCase()));
    const exact = sameExt.find((a) => tokens.some((t) => String(a.name || '').toLowerCase().includes(t)));
    const hit = exact || sameExt[0];
    if (hit) return { name: hit.name, url: hit.browser_download_url };
  }
  return null;
}

function readCache() {
  const raw = readJsonFile(cacheFile(), null);
  if (!raw || typeof raw !== 'object' || !raw.ok) return null;
  return raw;
}

/** 拉取最新 Release 并合成结果；任何失败都返回 ok:false 而不是抛错 */
async function fetchLatest() {
  const checkedAt = Date.now();
  const base = {
    ok: false,
    current: LOCAL_VERSION,
    latest: null,
    tagName: null,
    hasUpdate: false,
    releaseUrl: null,
    downloadUrl: null,
    assetName: null,
    publishedAt: null,
    notes: '',
    checkedAt,
    cached: false,
    error: null,
  };

  let res;
  try {
    res = await proxyFetch(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': `workbuddy-console/${LOCAL_VERSION}`,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // 检查更新走的是 GitHub，连不上只影响"能不能发现新版本"，别让用户以为工具坏了
      netHint:
        '检查更新需要访问 GitHub（api.github.com），境内网络经常连不上：' +
        '可开启代理并在「设置 → 网络代理」填写地址后重试；这项失败不影响其它功能',
    });
  } catch (e) {
    return { ...base, error: `无法访问版本服务：${e?.message || e}` };
  }

  if (!res.ok) {
    if (res.status === 404) {
      return { ...base, error: '版本仓库还没有发布过 Release' };
    }
    if (res.status === 403 || res.status === 429) {
      return { ...base, error: `版本服务限流（HTTP ${res.status}），稍后会自动重试` };
    }
    return { ...base, error: `版本服务返回 HTTP ${res.status}` };
  }

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    return { ...base, error: '版本服务返回的不是合法 JSON' };
  }

  const tag = String(payload?.tag_name || '').trim();
  if (!tag) return { ...base, error: '版本服务没有返回 tag_name' };

  const asset = pickAsset(payload?.assets);

  const latest = tag.replace(/^v/i, '');
  return {
    ...base,
    ok: true,
    latest,
    tagName: tag,
    hasUpdate: compareVersions(latest, LOCAL_VERSION) > 0,
    releaseUrl: payload?.html_url || `https://github.com/${RELEASE_REPO}/releases`,
    downloadUrl: asset?.url || payload?.html_url || `https://github.com/${RELEASE_REPO}/releases`,
    assetName: asset?.name || null,
    publishedAt: Date.parse(payload?.published_at) || null,
    notes: String(payload?.body || '').slice(0, NOTES_LIMIT),
    error: null,
  };
}

/**
 * 检查更新。`force=true` 跳过缓存（用户手动点「立即检查」）。
 * 失败时若存在上一次的成功缓存，就沿用那份判断并附上错误——"有新版本"这个结论过几小时仍然成立。
 */
export async function checkForUpdate({ force = false } = {}) {
  const now = Date.now();
  const cached = readCache();
  if (!force && cached && now - Number(cached.checkedAt || 0) < CACHE_TTL_MS) {
    // ⚠️ 缓存里的 current 是「写入缓存那一刻」的本机版本。用户升级应用后（进程重启、
    // LOCAL_VERSION 已变），6 小时内若直接沿用缓存的 current，界面会一直显示旧版本号，
    // 且 hasUpdate 是按旧 current 算的（升级后按钮还会错误地继续挂着）。
    // latest 来自远端不受升级影响，可以沿用；current 与 hasUpdate 必须按本机现值重算。
    return {
      ...cached,
      current: LOCAL_VERSION,
      hasUpdate: compareVersions(cached.latest, LOCAL_VERSION) > 0,
      cached: true,
    };
  }

  const fresh = await fetchLatest();
  if (fresh.ok) {
    try {
      atomicWriteJson(cacheFile(), fresh);
    } catch {
      /* 缓存写失败不影响本次结果 */
    }
    return fresh;
  }

  if (cached) return { ...cached, cached: true, stale: true, error: fresh.error };
  return fresh;
}
