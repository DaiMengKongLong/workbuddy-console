/**
 * 版本自检：本机版本 vs GitHub Release 最新 tag（**飞牛 fnOS 版专用**）。
 *
 * 与上游桌面版的差别有三处，都是被现实教过的：
 *
 * 1. **Release 仓库换成自己的 fork**（`DaiMengKongLong/workbuddy-console`）。上游发布的是
 *    exe/dmg，飞牛上装不了；热更新包与 .fpk 只发在自己的仓库里。
 * 2. **只认 `fnos-v` 前缀的 tag**。同一个仓库里还镜像了上游 v0.2.x 的桌面版 release（tag 是
 *    `v0.2.16`），用 `/releases/latest` 会取到桌面版 → 版本号对不上、附件也全是 exe/dmg。
 *    所以改成拉列表再按前缀过滤。
 * 3. **附件分两类**：`-hotupdate.tar.gz`（一键热更新用）与 `-x86.fpk`（全新安装 / 手工安装用）。
 *    只挑 .fpk，绝不把桌面版的 exe/dmg 当成安装包推给用户。
 *
 * 另外两个沿用上游的设计要点：
 * - **只有远端严格更新才算"有新版"**：本机开发版常领先于已发布 tag，按"不相等即更新"会把用户指向降级。
 * - **结果带 6 小时磁盘缓存**，且**只在请求成功时写**，失败绝不覆盖上次成功结果。
 *
 * 隐私说明：这是本工具唯一一处访问非官方服务的出站请求（GitHub API，只读 Release 元数据）。
 * 设置里关掉「检查更新」后整体停用。出站走 `proxyFetch`，自动尊重「设置 → 网络代理」。
 */
import fs from 'node:fs';
import { proxyFetch } from './proxy.mjs';
import { readJsonFile } from './workbuddy/accounts.mjs';
import { atomicWriteJson, cachePath } from './store/config.mjs';

/** 本机版本：唯一事实来源是 package.json，界面不再硬编码版本号 */
const PKG = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const LOCAL_VERSION = String(PKG.version || '0.0.0');

/** Release 所在仓库（自己的 fork：桌面版 release 与飞牛版 release 共存于此） */
export const RELEASE_REPO = 'DaiMengKongLong/workbuddy-console';

/** 飞牛 fnOS 版 release 的 tag 前缀，用于与上游桌面版 tag 区分 */
export const FNOS_TAG_PREFIX = 'fnos-v';

const CACHE_FILE_NAME = 'update-check.json';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 小时
const REQUEST_TIMEOUT_MS = 15_000;
const NOTES_LIMIT = 600;

const cacheFile = () => cachePath(CACHE_FILE_NAME);

/**
 * 版本号规范化 → 数字数组。`v0.2.1` / `0.2.1` / `0.2.1-beta.3` → [0,2,1]。
 */
export function parseVersion(v) {
  const m = String(v || '')
    .trim()
    .replace(/^v/i, '')
    .match(/^(\d+(?:\.\d+)*)/);
  if (!m) return null;
  return m[1].split('.').map((n) => Number(n) || 0);
}

/** 语义化比较：a > b 返回 1，a < b 返回 -1，相等返回 0；无法解析视为相等 */
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

/**
 * 从 release 附件里挑出飞牛需要的两个包。
 * - `hotupdate`：名字以 `-hotupdate.tar.gz` 结尾 → 一键热更新直接吃它
 * - `fpk`：名字以 `.fpk` 结尾 → 全新安装 / 手工安装用
 * 其它后缀（exe / dmg / AppImage / zip）一律不认，避免把桌面版产物推给飞牛用户。
 */
export function pickFnOSAssets(assets) {
  const list = (Array.isArray(assets) ? assets : []).filter((a) => a?.browser_download_url);
  const pick = (suffix) => list.find((a) => String(a.name || '').toLowerCase().endsWith(suffix)) || null;
  const hot = pick('-hotupdate.tar.gz');
  const fpk = pick('.fpk');
  // 一定要把 asset id 一起带出去：下载要走 api.github.com 的资产端点，见 hotupdate.mjs 的说明
  const one = (a) =>
    a ? { id: a.id, name: a.name, url: a.browser_download_url, size: a.size || 0, digest: a.digest || '' } : null;
  return { hotupdate: one(hot), fpk: one(fpk) };
}

function readCache() {
  const raw = readJsonFile(cacheFile(), null);
  if (!raw || typeof raw !== 'object' || !raw.ok) return null;
  return raw;
}

function baseResult(over = {}) {
  return {
    ok: false,
    current: LOCAL_VERSION,
    latest: null,
    tagName: null,
    hasUpdate: false,
    releaseUrl: null,
    downloadUrl: null,
    assetName: null,
    hotupdateUrl: null,
    hotupdateName: null,
    hotupdateSize: null,
    hotupdateDigest: null,
    /** 能否在界面上直接点「一键更新」（= 远端提供了热更新包且本机是飞牛安装环境） */
    canHotUpdate: false,
    publishedAt: null,
    notes: '',
    checkedAt: Date.now(),
    cached: false,
    error: null,
    ...over,
  };
}

/**
 * 拉 release 列表 → 过滤 fnos- 前缀 → 取版本号最大的那个。
 * 任何失败都返回 ok:false 而不是抛错。
 */
async function fetchLatestFnOS() {
  let res;
  try {
    res = await proxyFetch(`https://api.github.com/repos/${RELEASE_REPO}/releases?per_page=100`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': `workbuddy-console-fnos/${LOCAL_VERSION}`,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // 检查更新走的是 GitHub，连不上只影响"能不能发现新版本"，别让用户以为工具坏了
      netHint:
        '检查更新需要访问 GitHub（api.github.com），境内网络经常连不上：' +
        '可开启代理并在「设置 → 网络代理」填写地址后重试；这项失败不影响其它功能',
    });
  } catch (e) {
    return baseResult({ error: `无法访问版本服务：${e?.message || e}` });
  }

  if (!res.ok) {
    if (res.status === 404) return baseResult({ error: '版本仓库还没有发布过 Release' });
    if (res.status === 403 || res.status === 429) {
      return baseResult({ error: `版本服务限流（HTTP ${res.status}），稍后会自动重试` });
    }
    return baseResult({ error: `版本服务返回 HTTP ${res.status}` });
  }

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    return baseResult({ error: '版本服务返回的不是合法 JSON' });
  }

  const all = Array.isArray(payload) ? payload : [];
  const fnos = all
    .filter((r) => String(r?.tag_name || '').startsWith(FNOS_TAG_PREFIX))
    .filter((r) => !r?.draft);
  if (!fnos.length) {
    return baseResult({ error: `仓库里还没有 ${FNOS_TAG_PREFIX}* 的飞牛版 Release` });
  }

  // ⚠️ 必须先剥掉 `fnos-v` 前缀再比版本号：parseVersion 只认数字开头，
  // 直接拿 `fnos-v0.2.33` 去比会返回 null → 所有版本比较结果都是 0 → 排序等于没排，
  // 最后取到的是列表末尾那个（最旧的 release），界面会一直提示升到旧版本。
  const verOf = (tag) => String(tag || '').replace(/^fnos-/i, '');
  fnos.sort((a, b) => {
    const c = compareVersions(verOf(a.tag_name), verOf(b.tag_name));
    if (c !== 0) return c; // 升序，取最后一个即最大版本
    return (Date.parse(a.published_at) || 0) - (Date.parse(b.published_at) || 0);
  });
  const rel = fnos[fnos.length - 1];

  const tag = String(rel.tag_name || '').trim();
  const latest = tag.slice(FNOS_TAG_PREFIX.length).replace(/^v/i, '');
  const { hotupdate, fpk } = pickFnOSAssets(rel.assets);

  return baseResult({
    ok: true,
    latest,
    tagName: tag,
    hasUpdate: compareVersions(latest, LOCAL_VERSION) > 0,
    releaseUrl: rel.html_url || `https://github.com/${RELEASE_REPO}/releases`,
    downloadUrl: fpk?.url || rel.html_url || `https://github.com/${RELEASE_REPO}/releases`,
    assetName: fpk?.name || null,
    hotupdateUrl: hotupdate?.url || null,
    hotupdateName: hotupdate?.name || null,
    hotupdateSize: hotupdate?.size || null,
    hotupdateDigest: hotupdate?.digest || null,
    /** GitHub 资产 id：下载时用它走 api.github.com，绕开被墙/被 DNS 污染的 github.com */
    hotupdateId: hotupdate?.id || null,
    canHotUpdate: !!hotupdate,
    publishedAt: Date.parse(rel.published_at) || null,
    notes: String(rel.body || '').slice(0, NOTES_LIMIT),
    error: null,
  });
}

/**
 * 检查更新。`force=true` 跳过缓存（用户手动点「立即检查」）。
 * 失败时若存在上一次的成功缓存，就沿用那份判断并附上错误。
 */
export async function checkForUpdate({ force = false } = {}) {
  const now = Date.now();
  const cached = readCache();
  if (!force && cached && now - Number(cached.checkedAt || 0) < CACHE_TTL_MS) {
    // 缓存里的 current 是「写入那一刻」的本机版本。升级后进程重启、LOCAL_VERSION 已变，
    // 6 小时内沿用缓存的 current 会让界面一直显示旧版本号，hasUpdate 也会算错 → 必须重算。
    return {
      ...cached,
      current: LOCAL_VERSION,
      hasUpdate: compareVersions(cached.latest, LOCAL_VERSION) > 0,
      cached: true,
    };
  }

  const fresh = await fetchLatestFnOS();
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
