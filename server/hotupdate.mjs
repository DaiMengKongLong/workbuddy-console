/**
 * 一键热更新（飞牛 fnOS 版核心能力）。
 *
 * 目标：界面上点一下「更新」，服务端自己把新版本拉下来、就地换掉、重启完成——
 * 用户**不需要去 GitHub 下载 .fpk，也不需要到应用中心卸载重装**。
 *
 * 为什么可以这么做：飞牛版本质就是一个 Node 服务 + 一份静态前端，装在
 * `/var/apps/wbconsole/target`（`server/`、`dist/`、`package.json`、`node_modules/`）。
 * 除了 node_modules（依赖几乎不变），其余都是纯文件，替换掉再重启即可，无需走安装器。
 *
 * 安全边界（每一步都可回退）：
 * 1. 下载到 `$PKGVAR/tmp/`，不碰运行目录；
 * 2. sha256 校验（优先用 GitHub 资产自带的 `digest`）；
 * 3. 解包后**先验货**（必须有 `server/index.mjs` + `dist/index.html`），不合格直接放弃；
 * 4. 旧文件整体 mv 到 `$PKGVAR/backup/<时间戳>/`（同一文件系统，mv 是原子的）；
 * 5. 新文件 mv 进运行目录；任一步失败就把备份 mv 回来；
 * 6. 派生一个脱离本进程的 bash 脚本执行 `cmd/main stop` + `cmd/main start`。
 *
 * 第 6 步为什么要"派生 + 延迟"：我们自己就是那个要被杀掉的进程。直接自杀就没有人
 * 去拉起新进程了，所以必须让一个独立进程在 2 秒后回来做 stop/start。
 * 脚本里把 TRIM_* 环境变量**显式写死**（从本进程环境抓下来），因为脱离进程不会继承
 * 飞牛给 cmd/main 注入的那些变量。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { proxyFetch } from './proxy.mjs';
import { checkForUpdate, LOCAL_VERSION, compareVersions, RELEASE_REPO } from './update.mjs';

/** 运行目录 = 本文件所在目录的上一级（<target>/server/hotupdate.mjs → <target>） */
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));

function safeReal(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * 飞牛应用的几个关键路径。
 * 不依赖飞牛注入的环境变量也能算出来：`/var/apps/wbconsole/target` 的父目录就是应用目录，
 * 应用目录下的 `var` 软链指向真实数据卷（`/vol1/@appdata/wbconsole`）。
 */
export function runtimePaths() {
  const appDest = path.resolve(SELF_DIR, '..');
  const appDir = path.dirname(appDest);
  const pkgVar =
    process.env.TRIM_PKGVAR && fs.existsSync(process.env.TRIM_PKGVAR)
      ? process.env.TRIM_PKGVAR
      : safeReal(path.join(appDir, 'var'));
  return {
    appDir, // /var/apps/wbconsole
    appDest, // /var/apps/wbconsole/target
    pkgVar, // /vol1/@appdata/wbconsole
    cmd: path.join(appDir, 'cmd', 'main'),
    tmp: path.join(pkgVar, 'tmp'),
    backupRoot: path.join(pkgVar, 'backup'),
    logFile: path.join(pkgVar, 'logs', 'console.log'),
    portFile: path.join(pkgVar, 'run', 'port'),
    /** true = 确实是飞牛应用中心的安装布局（有 cmd/main），可以安全重启 */
    installed: fs.existsSync(path.join(appDir, 'cmd', 'main')),
  };
}

const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

async function downloadTo(url, dest, assetId) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // ⚠️ 不要用 release 页面那个 `github.com/.../releases/download/...` 地址下载。
  // 实测飞牛 NAS（以及很多境内网络）**根本连不上 github.com**（curl 直接超时 15s），
  // 但 api.github.com 是通的。所以只要拿得到 asset id，就走 API 的资产端点，
  // 它会 302 到 objects.githubusercontent.com（同样可达）。
  const apiUrl = assetId
    ? `https://api.github.com/repos/${RELEASE_REPO}/releases/assets/${assetId}`
    : null;
  const attempt = async (u) => {
    const res = await proxyFetch(u, {
      headers: {
        // 这个 Accept 是关键：不加的话 API 返回的是资产元信息 JSON，不是文件内容
        Accept: 'application/octet-stream',
        'User-Agent': `workbuddy-console-fnos/${LOCAL_VERSION}`,
      },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      netHint: '下载更新包需要访问 GitHub，可开启代理并在「设置 → 网络代理」填写地址后重试',
    });
    if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };
  let buf;
  try {
    buf = await attempt(apiUrl || url);
  } catch (e) {
    if (!apiUrl) throw e;
    // API 端点也不通时，再退回 release 页面地址碰碰运气
    buf = await attempt(url);
  }
  fs.writeFileSync(dest, buf);
  return buf.length;
}

/** GitHub 资产自带的 digest 形如 `sha256:<hex>` */
function digestToHex(digest) {
  const m = String(digest || '').match(/^sha256:([0-9a-f]{64})$/i);
  return m ? m[1].toLowerCase() : '';
}

function sha256File(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* 清不掉不影响主流程 */
  }
}

/** 保留最近 3 份备份 + 最近 3 个临时包，避免把飞牛的数据盘塞满 */
function pruneOld(dir, keep = 3) {
  try {
    if (!fs.existsSync(dir)) return;
    const mtimeOf = (n) => {
      try {
        return fs.statSync(path.join(dir, n)).mtimeMs;
      } catch {
        return 0;
      }
    };
    const items = fs
      .readdirSync(dir)
      .map((n) => ({ n, t: mtimeOf(n) }))
      .sort((a, b) => b.t - a.t)
      .slice(keep);
    for (const it of items) rmrf(path.join(dir, it.n));
  } catch {
    /* 清理失败无所谓 */
  }
}

const UPDATE_STATE_FILE = 'hotupdate-state.json';

function statePath(pkgVar) {
  return path.join(pkgVar, 'tmp', UPDATE_STATE_FILE);
}

/** 记录最近一次更新结果，供界面在重启后回来询问 */
function writeState(pkgVar, state) {
  try {
    fs.mkdirSync(path.dirname(statePath(pkgVar)), { recursive: true });
    fs.writeFileSync(statePath(pkgVar), JSON.stringify({ ...state, at: Date.now() }, null, 2));
  } catch {
    /* 状态写失败不影响更新本身 */
  }
}

export function readUpdateState() {
  try {
    const p = statePath(runtimePaths().pkgVar);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 执行一键更新。返回结构化结果，**不抛异常**（界面要能直接展示失败原因）。
 */
export async function applyHotUpdate({ force = false } = {}) {
  const P = runtimePaths();
  if (!P.installed) {
    return { ok: false, step: 'env', message: '当前不是飞牛应用中心的安装布局（找不到 cmd/main），请手动安装新版 .fpk' };
  }

  // 1) 先看有没有新版（force 时忽略 6 小时缓存）
  let info = await checkForUpdate({ force });
  if (!info.ok) {
    return { ok: false, step: 'check', message: info.error || '检查更新失败' };
  }
  if (!force && compareVersions(info.latest, LOCAL_VERSION) <= 0) {
    return { ok: true, upToDate: true, current: LOCAL_VERSION, latest: info.latest, message: `已是最新版本 v${LOCAL_VERSION}` };
  }
  if (!info.hotupdateUrl) {
    return {
      ok: false,
      step: 'asset',
      message: `v${info.latest} 没有提供热更新包，请到 ${info.releaseUrl} 下载 .fpk 手动安装`,
      releaseUrl: info.releaseUrl,
    };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tarball = path.join(P.tmp, `hotupdate-${info.latest}-${stamp}.tar.gz`);
  const stage = path.join(P.tmp, `stage-${info.latest}-${stamp}`);
  const backup = path.join(P.backupRoot, `before-${info.latest}-${stamp}`);

  try {
    // 2) 下载
    fs.mkdirSync(P.tmp, { recursive: true });
    const bytes = await downloadTo(info.hotupdateUrl, tarball, info.hotupdateId);
    if (bytes <= 0) throw new Error('下载到的更新包是空的');

    // 3) 校验（有 digest 才校验，没有就跳过——不能因为缺 digest 就拒绝更新）
    const expect = digestToHex(info.hotupdateDigest);
    if (expect) {
      const actual = sha256File(tarball);
      if (actual !== expect) {
        throw new Error(`校验不匹配（期望 ${expect.slice(0, 12)}… 实际 ${actual.slice(0, 12)}…），已放弃本次更新`);
      }
    }

    // 4) 解包 + 验货
    rmrf(stage);
    fs.mkdirSync(stage, { recursive: true });
    execFileSync('tar', ['-xzf', tarball, '-C', stage], { stdio: 'ignore' });
    // 包可能带一层顶层目录（如 wbconsole-fnos-0.2.31/），自动剥掉
    let root = stage;
    const entries = fs.readdirSync(stage);
    if (entries.length === 1 && fs.statSync(path.join(stage, entries[0])).isDirectory()) {
      root = path.join(stage, entries[0]);
    }
    for (const must of ['server/index.mjs', 'dist/index.html', 'package.json']) {
      if (!fs.existsSync(path.join(root, must))) {
        throw new Error(`更新包内容不完整（缺少 ${must}），已放弃本次更新`);
      }
    }

    // 5) 备份旧版本（mv，同文件系统、原子）
    fs.mkdirSync(P.backupRoot, { recursive: true });
    fs.mkdirSync(backup, { recursive: true });
    const movable = ['server', 'dist', 'package.json'].filter((n) => fs.existsSync(path.join(P.appDest, n)));
    for (const n of movable) {
      fs.renameSync(path.join(P.appDest, n), path.join(backup, n));
    }

    // 6) 换上新版本；任何一步失败都回滚
    try {
      for (const n of ['server', 'dist', 'package.json']) {
        fs.renameSync(path.join(root, n), path.join(P.appDest, n));
      }
    } catch (e) {
      for (const n of movable) {
        try {
          rmrf(path.join(P.appDest, n));
          fs.renameSync(path.join(backup, n), path.join(P.appDest, n));
        } catch {
          /* 回滚尽力而为 */
        }
      }
      throw new Error(`替换文件失败，已回滚：${e?.message || e}`);
    }

    // 7) 派生重启脚本
    const restartSh = path.join(P.tmp, `restart-${stamp}.sh`);
    const port = (() => {
      try {
        return fs.readFileSync(P.portFile, 'utf8').trim();
      } catch {
        return process.env.WBCONSOLE_PORT || '57891';
      }
    })();
    const script = `#!/bin/bash
# 由 wbconsole 热更新生成：先停再启。本脚本必须脱离原进程运行。
export TRIM_PKGVAR="${P.pkgVar}"
export TRIM_APPDEST="${P.appDest}"
export TRIM_SERVICE_PORT="${port}"
export HOME="${P.pkgVar}/home"
export FREE_TOKEN_CONFIG_DIR="${P.pkgVar}/data/config"
export PATH="/var/apps/nodejs_v22/target/bin:$PATH"
sleep 2
"${P.cmd}" stop  >> "${P.logFile}" 2>&1
"${P.cmd}" start >> "${P.logFile}" 2>&1
echo "$(date '+%Y-%m-%d %H:%M:%S') - hotupdate restart done (v${info.latest})" >> "${P.logFile}"
rm -f "$0"
`;
    fs.writeFileSync(restartSh, script, { mode: 0o755 });
    fs.chmodSync(restartSh, 0o755);

    const child = spawn('/bin/bash', [restartSh], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, TRIM_PKGVAR: P.pkgVar, TRIM_APPDEST: P.appDest },
    });
    child.unref();

    const result = {
      ok: true,
      updated: true,
      from: LOCAL_VERSION,
      to: info.latest,
      tagName: info.tagName,
      bytes,
      backup: path.relative(P.pkgVar, backup),
      restarting: true,
      message: `已更新到 v${info.latest}，正在重启服务`,
    };
    writeState(P.pkgVar, result);
    pruneOld(P.backupRoot, 3);
    pruneOld(P.tmp, 4);
    return result;
  } catch (e) {
    const result = { ok: false, step: 'apply', message: e?.message || String(e) };
    try {
      writeState(P.pkgVar, result);
    } catch {
      /* ignore */
    }
    rmrf(stage);
    return result;
  } finally {
    // 下载包用完即删（更新包本身不大，但别在数据盘里堆积）
    try {
      fs.rmSync(tarball, { force: true });
    } catch {
      /* ignore */
    }
  }
}
