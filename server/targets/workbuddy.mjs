import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { loadConfig } from '../store/config.mjs';
import { matchPlatformUrl } from '../providers/registry.mjs';

/** 检查目录是否具备 WorkBuddy 数据目录的特征文件 */
function inspectDir(dir) {
  const has = (p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  };
  const markers = {
    modelsJson: has(path.join(dir, 'models.json')),
    projects: has(path.join(dir, 'projects')),
    sessions: has(path.join(dir, 'sessions')),
    db: has(path.join(dir, 'workbuddy.db')),
  };
  const score = Object.values(markers).filter(Boolean).length;
  return { ...markers, score, exists: score > 0 };
}

/**
 * 自动检测 WorkBuddy 数据目录：
 * 1. 用户手动指定的目录（settings.workbuddyDir，优先但需通过特征校验才标记 valid）
 * 2. 默认位置 ~/.workbuddy（WorkBuddy 桌面端约定位置）
 * 3. 常见安装位置的候选目录，按特征文件（models.json/projects/sessions/workbuddy.db）命中判定
 */
export function detectWorkbuddyDir() {
  const cfg = loadConfig();
  const override = String(cfg.settings?.workbuddyDir || '').trim();
  const home = os.homedir();

  const candidates = [];
  if (override) candidates.push({ dir: path.resolve(override), source: 'override', sourceLabel: '手动指定' });
  candidates.push({ dir: path.join(home, '.workbuddy'), source: 'default', sourceLabel: '默认位置' });
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) candidates.push({ dir: path.join(process.env.LOCALAPPDATA, 'WorkBuddy'), source: 'scan', sourceLabel: '自动检测' });
    if (process.env.APPDATA) candidates.push({ dir: path.join(process.env.APPDATA, 'WorkBuddy'), source: 'scan', sourceLabel: '自动检测' });
  } else {
    candidates.push({ dir: path.join(home, 'Library', 'Application Support', 'WorkBuddy'), source: 'scan', sourceLabel: '自动检测' });
    candidates.push({ dir: path.join(home, '.config', 'WorkBuddy'), source: 'scan', sourceLabel: '自动检测' });
  }

  for (const c of candidates) {
    const markers = inspectDir(c.dir);
    if (markers.score > 0) return { ...c, markers, valid: true };
  }
  // 全部未命中：返回最高优先级候选并标记未检测到（手动指定优先，其次默认位置）
  const fallback = candidates[0] || { dir: path.join(home, '.workbuddy'), source: 'default', sourceLabel: '默认位置' };
  return { ...fallback, markers: inspectDir(fallback.dir), valid: false };
}

export function workbuddyDir() {
  return detectWorkbuddyDir().dir;
}

export function modelsJsonPath() {
  return path.join(workbuddyDir(), 'models.json');
}

export function readModelsJson() {
  const p = modelsJsonPath();
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Array.isArray(raw)) return { entries: raw, exists: true };
    return { entries: [], exists: true, invalid: true };
  } catch (err) {
    if (err?.code === 'ENOENT') return { entries: [], exists: false };
    // 语法级损坏同样标记 invalid，让调用方优雅降级（载入拒绝 / 移除拒绝 / 列表提示），而非抛异常
    return { entries: [], exists: true, invalid: true, parseError: err?.message };
  }
}

/** 仅认定指向已注册平台端点的自定义条目属于本工具的管理范围（用户手动加的其他条目永不触碰） */
export function isManagedEntry(e) {
  return !!matchPlatformUrl(e?.url);
}

const BACKUP_KEEP = 10;

function backupModelsJson() {
  const p = modelsJsonPath();
  if (!fs.existsSync(p)) return null;
  // 文件名保留毫秒且查重递增：同一秒内连续两次写入也不得互相覆盖（真实踩过的坑）
  const base = new Date().toISOString().replace(/[:.]/g, '-');
  let bak = `${p}.bak-${base}`;
  for (let i = 1; fs.existsSync(bak); i++) bak = `${p}.bak-${base}-${i}`;
  fs.copyFileSync(p, bak);
  // 备份保留策略：只留最近 N 份，避免无限累积
  try {
    const dir = path.dirname(p);
    const olds = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(`${path.basename(p)}.bak-`))
      .sort()
      .slice(0, -BACKUP_KEEP);
    for (const f of olds) fs.unlinkSync(path.join(dir, f));
  } catch {
    /* 清理失败不影响主流程 */
  }
  return bak;
}

function atomicWriteJson(file, obj) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function verifyEntries(ids, apiKey) {
  const check = JSON.parse(fs.readFileSync(modelsJsonPath(), 'utf8'));
  if (!Array.isArray(check)) throw new Error('回读校验失败：models.json 不是数组');
  for (const id of ids) {
    const e = check.find((x) => x && x.id === id);
    if (!e) throw new Error(`回读校验失败：缺少 ${id}`);
    if (apiKey && e.apiKey !== apiKey) throw new Error(`回读校验失败：${id} 的 apiKey 不一致`);
  }
}

/**
 * 批量载入模型到 WorkBuddy：备份 -> 按 id 合并（已存在则更新）-> 原子写 -> 回读校验 -> 失败回滚
 */
export function loadModels(entries) {
  if (!entries?.length) throw new Error('没有可载入的模型');
  if (!fs.existsSync(workbuddyDir())) {
    throw new Error(`WorkBuddy 数据目录不存在：${workbuddyDir()}（请先安装并运行一次 WorkBuddy）`);
  }
  const { entries: current, invalid } = readModelsJson();
  if (invalid) throw new Error('models.json 格式异常（不是数组），请先在 WorkBuddy 中检查自定义模型配置');

  const backup = backupModelsJson();
  const byId = new Map(current.map((e) => [e.id, e]));
  let added = 0;
  let updated = 0;
  for (const m of entries) {
    const existing = byId.get(m.id);
    if (existing) {
      Object.assign(existing, m);
      updated++;
    } else {
      current.push(m);
      byId.set(m.id, m);
      added++;
    }
  }
  try {
    atomicWriteJson(modelsJsonPath(), current);
    verifyEntries(entries.map((e) => e.id), entries[0]?.apiKey);
    return { added, updated, backup, total: current.length };
  } catch (err) {
    if (backup && fs.existsSync(backup)) fs.copyFileSync(backup, modelsJsonPath());
    throw err;
  }
}

/** 从 models.json 移除本工具载入的条目（任何平台的；用户手动加的其他条目永不触碰） */
export function removeModels(ids) {
  const { entries, invalid } = readModelsJson();
  if (invalid) return { invalid: true, removed: 0 };
  const idSet = new Set(ids);
  const kept = entries.filter((e) => !(idSet.has(e?.id) && isManagedEntry(e)));
  const removed = entries.length - kept.length;
  const backup = backupModelsJson();
  try {
    atomicWriteJson(modelsJsonPath(), kept);
    return { removed, backup, total: kept.length };
  } catch (err) {
    if (backup && fs.existsSync(backup)) fs.copyFileSync(backup, modelsJsonPath());
    throw err;
  }
}

/** models.json 最后修改时间（null = 文件不存在） */
export function modelsJsonMtime() {
  try {
    return fs.statSync(modelsJsonPath()).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * 检测"模型配置已变更但 WorkBuddy 尚未读取"：
 * WorkBuddy 只在启动时读取 models.json，若文件修改时间晚于其进程启动时间（留 3 秒容差），
 * 则运行中的 WorkBuddy 需要重启才能让新增/移除的模型生效。
 */
export function isPendingRestart(proc) {
  const mtime = modelsJsonMtime();
  if (!proc?.running || !proc?.startTime || mtime == null) return false;
  return mtime > proc.startTime + 3000;
}

/** 已载入的本工具条目（key 脱敏，标注来源平台） */
export function listLoaded() {
  const { entries, exists, invalid } = readModelsJson();
  const loaded = entries.filter(isManagedEntry).map((e) => ({
    id: e.id,
    name: e.name || e.id,
    platform: matchPlatformUrl(e.url) || 'unknown',
    keyTail: typeof e.apiKey === 'string' ? e.apiKey.slice(-4) : '',
    supportsToolCall: !!e.supportsToolCall,
    supportsImages: !!e.supportsImages,
    supportsReasoning: !!e.supportsReasoning,
  }));
  return { exists, invalid, dir: workbuddyDir(), modelsJsonPath: modelsJsonPath(), loaded };
}

function run(cmd, args, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr }));
      resolve(stdout);
    });
  });
}

/** 把 execFile 的报错压成一句可读原因（原始 message 会带上整条命令行，不适合展示） */
function shortExecError(err) {
  const code = err?.code;
  if (code && typeof code === 'string') return code; // EPERM / EACCES / ENOENT ...
  const first = String(err?.stderr || '')
    .split('\n')
    .map((s) => s.trim())
    .find(Boolean);
  return first ? first.slice(0, 120) : '命令执行失败或不被允许';
}

/**
 * WorkBuddy 桌面端的进程名（PowerShell 的 `-Name` 与 tasklist 的 `IMAGENAME` 都用它）。
 *
 * 探测与结束进程的函数都接受 `names` 覆盖它——**只为自动化测试**：
 * 测试机上真实 WorkBuddy 多半正在运行，用同名替身进程才能真实验证
 * 「优雅退出 → 强杀 → 确认消失」这条升级逻辑，而不必关掉真的客户端。
 *
 * ⚠️ 千万别改成通配符（`WorkBuddy*`）：两者的匹配都是**按映像名精确**的，而控制台自己打包后的
 * 进程叫 `WorkBuddy Console`（electron-builder 的 productName）。一旦放宽成前缀匹配，
 * 切号时就会**把控制台自己杀掉**，切换动作当场中断。
 */
export const WORKBUDDY_PROCESS_NAMES = ['WorkBuddy', 'CodeBuddy'];

/** 解析 PowerShell 序列化的启动时间：PS 5.1 为 "/Date(ms)/"，PS 7 为 ISO 字符串 */
function parseStartTime(v) {
  if (!v) return null;
  const m = String(v).match(/Date\((\d+)/);
  if (m) return Number(m[1]);
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

/**
 * Windows 主路径：枚举**全部**匹配进程，按启动时间升序。
 * 对默认进程名来说，第一个就是主进程（Electron 的渲染/GPU/工具进程都是它的子进程）。
 */
async function listViaPowerShell(names = WORKBUDDY_PROCESS_NAMES) {
  // 不用 Sort-Object StartTime：个别进程取不到 StartTime 时会让整条管道报错，
  // 改为取回全部进程后在 JS 里排序。
  const ps =
    `Get-Process -Name ${names.join(',')} -ErrorAction SilentlyContinue | ` +
    `Select-Object Id,ProcessName,Path,StartTime | ConvertTo-Json -Compress`;
  const stdout = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 15000);
  const t = stdout.trim();
  if (!t) return [];
  const parsed = JSON.parse(t);
  return (Array.isArray(parsed) ? parsed : [parsed])
    .filter(Boolean)
    .map((o) => ({
      pid: Number(o.Id),
      name: o.ProcessName,
      exePath: o.Path || null,
      startTime: parseStartTime(o.StartTime),
    }))
    .filter((p) => Number.isFinite(p.pid) && p.pid > 0)
    .sort((a, b) => (a.startTime || Number.MAX_SAFE_INTEGER) - (b.startTime || Number.MAX_SAFE_INTEGER));
}

/** Windows 主路径的探测版：取启动最早的那个 = 应用真正启动的时刻 */
async function detectViaPowerShell(names = WORKBUDDY_PROCESS_NAMES) {
  const rows = await listViaPowerShell(names);
  if (!rows.length) return null;
  // WorkBuddy 基于 Electron，会有多个进程（主进程 + 渲染/GPU/工具子进程）。
  const main = rows[0];
  return {
    running: true,
    pid: main.pid,
    name: main.name,
    exePath: main.exePath,
    startTime: main.startTime,
    processCount: rows.length,
    platform: 'win32',
    method: 'powershell',
  };
}

/**
 * Windows 兜底：tasklist 不依赖 PowerShell，被安全策略限制的环境下通常仍可用。
 *
 * 返回**全部**匹配行（每个 PID 一行）。tasklist 给不了启动时间，
 * 所以这里连主进程是谁都分不出来——靠 `taskkill /T` 顺着进程树倒推。
 */
async function listViaTasklist(names = WORKBUDDY_PROCESS_NAMES) {
  const out = [];
  for (const name of names) {
    const exe = /\.exe$/i.test(name) ? name : `${name}.exe`;
    let stdout = '';
    try {
      stdout = await run('tasklist', ['/FI', `IMAGENAME eq ${exe}`, '/FO', 'CSV', '/NH'], 10000);
    } catch {
      continue;
    }
    for (const line of stdout
      .split('\n')
      .map((s) => s.trim())) {
      // 无匹配时 tasklist 会打印 "INFO: No tasks are running..." 之类的说明，不含 exe 名
      if (!line.toLowerCase().includes(exe.toLowerCase())) continue;
      const cols = line.split('","').map((s) => s.replace(/^"|"$/g, ''));
      const pid = Number(cols[1]);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      out.push({
        pid,
        name: exe.replace(/\.exe$/i, ''),
        exePath: null,
        startTime: null, // tasklist 不提供启动时间，因此无法判断配置是否"待重启"
        startTimeUnknown: true,
      });
    }
  }
  return out;
}

/** Windows 兜底探测版：只关心"有没有在跑"，随便取一个 PID 即可 */
async function detectViaTasklist(names = WORKBUDDY_PROCESS_NAMES) {
  const rows = await listViaTasklist(names);
  const first = rows[0];
  if (!first) return null;
  return {
    running: true,
    pid: first.pid,
    name: first.name,
    exePath: null,
    startTime: null,
    processCount: rows.length,
    platform: 'win32',
    method: 'tasklist',
    startTimeUnknown: true,
  };
}

export async function detectWorkbuddyProcess({ names = WORKBUDDY_PROCESS_NAMES } = {}) {
  const platform = process.platform;

  if (platform === 'win32') {
    const failures = []; // 探测方式**本身**没能执行（不代表"没进程"）
    let probed = false; // 是否至少有一种方式成功执行完

    try {
      const r = await detectViaPowerShell(names);
      probed = true;
      if (r) return r;
    } catch (err) {
      failures.push(`PowerShell 不可用（${shortExecError(err)}）`);
    }
    try {
      const r = await detectViaTasklist(names);
      probed = true;
      if (r) return { ...r, warning: failures.length ? failures.join('；') : null };
    } catch (err) {
      failures.push(`tasklist 不可用（${shortExecError(err)}）`);
    }

    /**
     * 只要有一种方式**成功跑完**并且没找到进程，这就是"确实没在运行"的确定答案。
     *
     * 早先这里写反了：把"另一种方式不可用"也当成"无法判定"（只要 failures 非空就报 error）。
     * 后果是——在 PowerShell 被安全策略拦掉的机器上（本机就是），**杀掉 WorkBuddy 之后的那次复检
     * 必然报"无法确认"**，于是切号在最后一道门上被自己拦住、登录态永远写不进去，
     * 界面还显示一句把人往"手动退出"引的误导文案。实测踩过。
     *
     * 安全性没有降低：全都被拦（probed === false）时仍然返回 error，调用方照旧保守拒绝。
     */
    if (probed) {
      return { running: false, platform, error: null, warning: failures.length ? failures.join('；') : null };
    }
    return { running: false, platform, error: failures.join('; ') };
  }

  // macOS / Linux 粗略探测（同 workbuddy-switch 的进程命名习惯）
  try {
    const stdout = await run('pgrep', ['-if', names.map((n) => n.replace(/\.exe$/i, '')).join('|')], 8000);
    const pid = parseInt(String(stdout).split('\n')[0], 10);
    if (Number.isFinite(pid) && pid > 0) return { running: true, pid, exePath: null, platform, method: 'pgrep' };
    return { running: false, platform, method: 'pgrep' };
  } catch (err) {
    // pgrep 无匹配时退出码为 1 —— 那是"没有进程"，不是探测失败（与 listWorkbuddyProcesses 同口径）
    if (err?.code === 1) return { running: false, platform, method: 'pgrep' };
    return { running: false, error: err?.message || String(err), platform };
  }
}

/** 定位 WorkBuddy 可执行文件：优先检测到的真实路径，再按常见安装位置兜底 */
function findWorkbuddyExe(detectedPath) {
  const candidates = [
    detectedPath,
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
    'C:\\Program Files\\WorkBuddy\\WorkBuddy.exe',
    'C:\\Program Files (x86)\\WorkBuddy\\WorkBuddy.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
  ].filter(Boolean);
  return candidates.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

/**
 * 枚举 WorkBuddy / CodeBuddy 的全部进程（判定「是否已退出」与「逐个关掉」都用它）。
 *
 * 返回 `{ processes, method, complete?, warning?, error? }`。
 * `complete: false` 表示只用 tasklist 拿到了单个 PID（没有启动时间），
 * 此时靠 `taskkill /T` 杀进程树来兜底。
 * `error` 非空表示**无法判定**当前状态，调用方必须保守处理，不能当成"没在运行"。
 */
export async function listWorkbuddyProcesses({ names = WORKBUDDY_PROCESS_NAMES } = {}) {
  if (process.platform === 'win32') {
    try {
      return { processes: await listViaPowerShell(names), method: 'powershell', complete: true };
    } catch (err) {
      const psError = shortExecError(err);
      try {
        const rows = await listViaTasklist(names);
        return rows.length
          ? {
              processes: rows,
              method: 'tasklist',
              complete: false,
              warning: `PowerShell 不可用（${psError}），改用 tasklist（拿不到启动时间，会靠进程树兜底）`,
            }
          : { processes: [], method: 'tasklist', warning: `PowerShell 不可用（${psError}）` };
      } catch (err2) {
        return { processes: [], error: `PowerShell（${psError}）与 tasklist（${shortExecError(err2)}）都不可用` };
      }
    }
  }
  const pattern = names.map((n) => n.replace(/\.exe$/i, '')).join('|');
  try {
    const stdout = await run('pgrep', ['-if', pattern], 8000);
    const processes = String(stdout)
      .split('\n')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
      .map((pid) => ({ pid, name: null, exePath: null, startTime: null }));
    return { processes, method: 'pgrep', complete: true };
  } catch (err) {
    // pgrep 无匹配时退出码为 1 —— 那是"没有进程"，不是探测失败
    if (err?.code === 1) return { processes: [], method: 'pgrep', complete: true };
    return { processes: [], error: err?.message || String(err) };
  }
}

/** 轮询等待进程消失 */
async function waitUntilGone(timeoutMs, names) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { processes, error } = await listWorkbuddyProcesses({ names });
    if (!processes.length) return { gone: true, unconfirmed: !!error };
    if (Date.now() >= deadline) return { gone: false, remaining: processes };
    await new Promise((r) => setTimeout(r, 400));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 优雅退出的等待窗口：够 WM_CLOSE 走完，又不至于让界面等太久 */
const STOP_GRACEFUL_MS = 2500;
/** 强杀后的等待上限 */
const STOP_FORCE_MS = 12000;

/** 给单个 PID 发终止信号（win32 走 taskkill，其他平台走 kill） */
function terminatePid(pid, force) {
  const args =
    process.platform === 'win32'
      ? ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])]
      : [force ? '-KILL' : '-TERM', String(pid)];
  // 单个进程杀不掉不影响其余：主进程一死，它的子进程通常已经一起没了
  return run(process.platform === 'win32' ? 'taskkill' : 'kill', args).catch(() => {});
}

/**
 * 退出 WorkBuddy（全部相关进程），并**确认真的消失了**才返回。
 *
 * 两步走：先 `taskkill`（不带 `/F`，向窗口发 WM_CLOSE，能保住正在落盘的数据），
 * 等不到就逐个 `/T /F` 强杀。第二步不是多余的——WorkBuddy 关窗会缩到系统托盘，
 * 优雅退出经常"看起来关掉了其实还活着"，那样切号会被它把登录态改写回去。
 *
 * **每轮都重新枚举再杀**，而不是开局枚举一次就照着那份 PID 名单猛敲：
 * 一来 tasklist 兜底时一次只能看到部分 PID、连主进程是谁都分不出；
 * 二来先杀 helper 会被主进程立刻重新拉起来。反复枚举能让名单自然收敛
 * （先冒出来的子进程被清掉 → 主进程暴露出来 → 再清掉它），直到进程表真的空了。
 *
 * @returns `{ stopped, wasRunning, killed, forced, exePath }`；关不掉时抛错（绝不静默返回成功）
 */
export async function stopWorkbuddy({
  names = WORKBUDDY_PROCESS_NAMES,
  gracefulMs = STOP_GRACEFUL_MS,
  forceMs = STOP_FORCE_MS,
} = {}) {
  const first = await listWorkbuddyProcesses({ names });
  if (first.error) {
    throw new Error(`无法确认 WorkBuddy 的运行状态（${first.error}），为安全起见没有结束任何进程`);
  }
  if (!first.processes.length) {
    return { stopped: true, wasRunning: false, killed: [], forced: false, exePath: null };
  }

  const exePath = first.processes.find((p) => p.exePath)?.exePath || null;
  const killed = new Set();

  /**
   * 一轮"枚举 → 全杀 → 轮询到消失或超时"。
   * 探测失败时抛错而不是当作"已经关掉了"——那会让切号在客户端还活着的情况下继续。
   */
  const round = async (force, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { processes, error } = await listWorkbuddyProcesses({ names });
      if (error) throw new Error(`无法确认 WorkBuddy 是否已退出（${error}），已中止`);
      if (!processes.length) return true;
      for (const p of processes) killed.add(p.pid);
      for (const p of processes) await terminatePid(p.pid, force);
      if (Date.now() >= deadline) return false;
      await sleep(400);
    }
  };

  if (await round(false, gracefulMs)) {
    return { stopped: true, wasRunning: true, killed: [...killed], forced: false, exePath };
  }

  if (!(await round(true, forceMs))) {
    throw new Error(`无法退出 WorkBuddy（仍在运行：PID ${[...killed].join(', ')}），请手动退出后重试`);
  }
  // 进程刚没，让 SQLite 把 -wal/-shm 的句柄彻底放开，再动数据库
  await sleep(700);
  const confirm = await waitUntilGone(1000, names);
  if (!confirm.gone) throw new Error('WorkBuddy 退出后又重新启动，请手动退出后重试');
  return { stopped: true, wasRunning: true, killed: [...killed], forced: true, exePath };
}

/**
 * 重新打开 WorkBuddy（切换账号后调用，让用户拿到一个已登录新账号的客户端）。
 * 只在 Windows 上可用——macOS 未做验证，宁可让用户手动打开也不猜。
 */
export function launchWorkbuddy(exePath) {
  if (process.platform !== 'win32') {
    throw new Error(`当前平台（${process.platform}）不支持自动重新打开 WorkBuddy，请手动打开`);
  }
  const exe = findWorkbuddyExe(exePath);
  if (!exe) {
    throw new Error(
      '未能定位 WorkBuddy 可执行文件，请手动重新打开 WorkBuddy。' + (exePath ? `（检测到的路径：${exePath}）` : '')
    );
  }
  const child = spawn(exe, [], { detached: true, stdio: 'ignore' });
  child.unref();
  return { launched: true, exePath: exe };
}

export async function restartWorkbuddy() {
  const proc = await detectWorkbuddyProcess();
  if (!proc.running) throw new Error('未检测到运行中的 WorkBuddy 进程，无需重启（下次启动自动生效）');
  if (process.platform === 'win32') {
    if (!proc.pid) throw new Error('未获取到进程 ID，无法重启');
    await run('taskkill', ['/PID', String(proc.pid), '/T', '/F'], 10000);
    await new Promise((r) => setTimeout(r, 1500));
    const exe = findWorkbuddyExe(proc.exePath);
    if (!exe) {
      throw new Error(
        '未能定位 WorkBuddy 可执行文件，请手动重新打开 WorkBuddy。' +
          (proc.exePath ? `（检测到的路径：${proc.exePath}）` : '')
      );
    }
    const child = spawn(exe, [], { detached: true, stdio: 'ignore' });
    child.unref();
    return { restarted: true, exePath: exe };
  }
  throw new Error(`当前平台（${process.platform}）暂不支持自动重启，请手动重启 WorkBuddy`);
}
