import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { loadConfig, durableWriteText } from '../store/config.mjs';
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

/** 本文件内部写盘：统一走带退避重试的持久写（模型列表 / exe 路径缓存都是关键文件） */
function atomicWriteJson(file, obj) {
  durableWriteText(file, JSON.stringify(obj, null, 2));
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

function run(cmd, args, timeoutMs = 10000, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, ...opts }, (err, stdout, stderr) => {
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
export const WORKBUDDY_PROCESS_NAMES = ['WorkBuddy'];

/** 解析 PowerShell 序列化的启动时间：PS 5.1 为 "/Date(ms)/"，PS 7 为 ISO 字符串 */
function parseStartTime(v) {
  if (!v) return null;
  const m = String(v).match(/Date\((\d+)/);
  if (m) return Number(m[1]);
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

/** PowerShell 的候选启动方式：PATH 里的 powershell.exe + 系统绝对路径兜底 */
const POWERSHELL_CANDIDATES = [
  'powershell.exe',
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
];

/**
 * 按候选列表依次尝试启动 PowerShell。
 *
 * 打包安装后的 Electron 应用环境变量可能与开发时不同（个别机器 PATH 里
 * 找不到 powershell.exe，报 ENOENT → 界面显示"PowerShell 不可用"），
 * 但 System32 下的绝对路径在所有 Windows 上都存在，作为兜底足够稳。
 */
async function runPowerShell(args, timeoutMs = 15000) {
  let lastErr;
  for (const cmd of POWERSHELL_CANDIDATES) {
    try {
      return await run(cmd, args, timeoutMs);
    } catch (err) {
      lastErr = err;
      // ENOENT（找不到可执行文件）才值得换下一个候选；其他错误（超时/权限）换路径也没用
      if (err?.code !== 'ENOENT') throw err;
    }
  }
  throw lastErr;
}

/**
 * Windows 主路径：枚举**全部**匹配进程，按启动时间升序。
 * 对默认进程名来说，第一个就是主进程（Electron 的渲染/GPU/工具进程都是它的子进程）。
 */
async function listViaPowerShell(names = WORKBUDDY_PROCESS_NAMES) {
  // 不用 Sort-Object StartTime：个别进程取不到 StartTime 时会让整条管道报错，
  // 改为取回全部进程后在 JS 里排序。
  // 旧写法（2026-10-22 弃用）：
  //   `Get-Process -Name ${names.join(',')} -ErrorAction SilentlyContinue | ...`
  // 弃用原因：`-Name` 对**无匹配的进程名**（机器只装了 WorkBuddy 没装 CodeBuddy 时必中）
  // 会产生一条非终止错误——SilentlyContinue 只抑制显示，错误记录仍进 $Error；
  // 而 PowerShell -Command 模式只要 $Error 非空，进程退出码就是 1（stdout 里 JSON 明明完整）。
  // execFile 见到非零退出码直接 reject，PowerShell 主路径被静默降级成 tasklist，
  // 启动时间丢失 →「配置待重启」判断永久失效。改为枚举后按名过滤：无匹配 = 空结果，不产生错误。
  const ps =
    `Get-Process -ErrorAction SilentlyContinue | ` +
    `Where-Object { $_.ProcessName -in @('${names.join("','")}') } | ` +
    `Select-Object Id,ProcessName,Path,StartTime | ConvertTo-Json -Compress`;
  const stdout = await runPowerShell(['-NoProfile', '-NonInteractive', '-Command', ps], 15000);
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
  // 进程还活着时是**唯一能百分百读到真实安装路径**的时刻（进程一死 Path 就没了，
  // 而任务管理器/安全软件又常把 PowerShell 挡掉）。这里顺手把路径落盘，
  // 供「先杀进程、再重新打开」的流程在杀完之后仍然找得到 exe。
  rememberExePath(main.exePath);
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

/* ---------------------------------------------------------------------- *
 * macOS / Linux：ps 全量进程表（替代 pgrep，见 listViaPs 注释）
 * ---------------------------------------------------------------------- */

const PS_MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** 解析 `ps -axo pid=,ppid=,lstart=,command=` 输出；供 listViaPs 与单元测试使用 */
export function parsePsProcessTable(stdout) {
  const rows = [];
  const re = /^\s*(\d+)\s+(\d+)\s+[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s+(.*)$/;
  for (const line of String(stdout).split('\n')) {
    const m = line.match(re);
    if (!m) continue;
    const mo = PS_MONTHS[m[3]];
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const command = m[9] || '';
    let startTime = null;
    if (mo !== undefined) {
      startTime = new Date(Number(m[8]), mo, Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7])).getTime();
    }
    rows.push({ pid, ppid, command, startTime });
  }
  return rows;
}

/**
 * macOS / Linux 主路径的**核心筛选**（纯函数，供单测）：
 * 1) 剔除本工具自己的进程子树（自己 + 全部后代）——⚠️ 这是 macOS「意外退出」的根因修复：
 *    pgrep 时代按完整命令行做子串匹配，而打包后的控制台进程名就叫 "WorkBuddy Console"
 *    （web 版脚本路径也常含 workbuddy 字样），模式 WorkBuddy|CodeBuddy 必然连自己一起命中，
 *    切号时把自己杀掉 → macOS 弹「意外退出」（macOS 用户实测 2026-10-17）。
 *    Windows 分支无此问题：那里的匹配按映像名**精确**匹配。
 * 2) 按名称模式匹配命令行（大小写不敏感）；
 * 3) 按启动时间升序：最早 = 主进程，先杀主进程，Electron 子进程随之退出；
 *    反过来先强杀 helper 会触发主进程 Chromium CHECK 失败（SIGTRAP）→ 真正的 WorkBuddy「意外退出」。
 */
export function selectWorkbuddyRows(rows, names = WORKBUDDY_PROCESS_NAMES) {
  const own = new Set([process.pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of rows) {
      if (own.has(r.pid) || !own.has(r.ppid)) continue;
      own.add(r.pid);
      grew = true;
    }
  }
  const pattern = new RegExp(`(${names.map((n) => n.replace(/\.exe$/i, '')).join('|')})`, 'i');
  return rows
    .filter((r) => !own.has(r.pid) && pattern.test(r.command))
    .map((r) => {
      const exePath = r.command.split(/\s+/)[0] || null; // 首个空格前 = 可执行文件路径（无参启动的 Electron 主进程成立）
      return {
        pid: r.pid,
        name: exePath ? exePath.split('/').pop() : null,
        exePath,
        startTime: r.startTime,
        command: r.command,
      };
    })
    .sort((a, b) => (a.startTime ?? Number.MAX_SAFE_INTEGER) - (b.startTime ?? Number.MAX_SAFE_INTEGER));
}

async function listViaPs(names = WORKBUDDY_PROCESS_NAMES) {
  // 全量进程表可能很大（每行含完整命令行），放宽 execFile 的 1MB 默认上限
  const stdout = await run('ps', ['-axo', 'pid=,ppid=,lstart=,command='], 8000, { maxBuffer: 16 * 1024 * 1024 });
  return selectWorkbuddyRows(parsePsProcessTable(stdout), names);
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
      // 记录失败原因仅用于全失败时的 error 汇总；tasklist 兜底成功后不再对外透出
      // ——探测已完成、结果可信，把内部降级细节摆给用户只会造成误导（实测反馈 2026-10）
      failures.push(`PowerShell 探测失败（${shortExecError(err)}）`);
    }
    try {
      const r = await detectViaTasklist(names);
      probed = true;
      if (r) return r;
    } catch (err) {
      failures.push(`tasklist 探测失败（${shortExecError(err)}）`);
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
     * 曾在此处给"有降级"的确定答案附带 warning，用户反馈同样误导（2026-10），已去掉。
     */
    if (probed) {
      return { running: false, platform, error: null, warning: null };
    }
    return { running: false, platform, error: failures.join('; ') };
  }

  // macOS / Linux：走 ps 全量进程表（pgrep 的自杀陷阱见 listViaPs 注释）
  const { processes, method, error } = await listWorkbuddyProcesses({ names });
  if (error) return { running: false, error, platform };
  if (!processes.length) return { running: false, platform, method };
  // 列表已按启动时间升序（ps 路径），第一个 = 主进程 = 应用真正启动的时刻
  const main = processes[0];
  return {
    running: true,
    pid: main.pid,
    name: main.name,
    exePath: main.exePath,
    startTime: main.startTime,
    processCount: processes.length,
    platform,
    method,
  };
}

/**
 * WorkBuddy 可执行文件的文件名（不同发行版命名不一致，实测见过 WorkBuddy.app 与 WorkBuddy AI）
 * 与安装目录特征（目录名以这些开头）。
 */
const WORKBUDDY_EXE_NAMES = ['WorkBuddy.exe', 'WorkBuddy AI.exe', 'WorkBuddyAI.exe', 'CodeBuddy.exe', 'CodeBuddy AI.exe'];
/**
 * 安装目录名特征。
 *
 * 为什么不是简单的 `/^(workbuddy|codebuddy)/i`：加上盘符根目录扫描后，同前缀的非安装目录
 * 也会被命中——`E:\workbuddy_space`（工作区）、`WorkBuddy-Console`（本工具自己）。
 * 一旦下钻到 `WorkBuddy-Console.exe`，切号后的「重新打开」就会把我们自己拉起来。
 * 现在只认「workbuddy/codebuddy + 可选的 ai/cn/desktop/app 后缀 + 可选版本号」。
 */
const WORKBUDDY_DIR_RE = /^(workbuddy|codebuddy)(?:[ _-]?(?:ai|cn|desktop|app))?(?:[ _-]?v?\d[\w.-]*)?$/i;
/** 同理：exe 名里带 console/space 的一律不是客户端本体 */
const EXE_NAME_RE = /^(workbuddy|codebuddy)(?![ _-]?(?:console|space))[^/\\]*\.exe$/i;

function existsQuiet(p) {
  try {
    return !!p && fs.existsSync(p);
  } catch {
    return false;
  }
}

function listDirQuiet(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** 在**一个安装目录**里找 exe：先按已知文件名，再按前缀通配，最后看一层版本子目录（app-1.2.3/） */
export function findExeInDir(dir, io = { exists: existsQuiet, listDir: listDirQuiet }) {
  if (!dir) return null;
  for (const name of WORKBUDDY_EXE_NAMES) {
    const p = path.join(dir, name);
    if (io.exists(p)) return p;
  }
  const entries = io.listDir(dir);
  const hit = entries.find((e) => !e.isDirectory() && EXE_NAME_RE.test(e.name));
  if (hit) return path.join(dir, hit.name);
  // 再下一层：Electron 的版本目录（app-1.2.3/、bin/）不一定带 workbuddy 前缀，
  // 所以这里不按名字过滤，只限制「只下钻一层」以免无限扫描
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const deeper = path.join(dir, e.name);
    for (const name of WORKBUDDY_EXE_NAMES) {
      const p = path.join(deeper, name);
      if (io.exists(p)) return p;
    }
    const inner = io.listDir(deeper).find((x) => !x.isDirectory() && EXE_NAME_RE.test(x.name));
    if (inner) return path.join(deeper, inner.name);
  }
  return null;
}

/**
 * 在若干「安装根目录」（Program Files / Program Files (x86) / LocalAppData\Programs 等）下
 * 找 WorkBuddy 的安装目录并取 exe。
 *
 * 为什么必须扫根目录而不是只列几个写死的完整路径：用户把 WorkBuddy 装在自定义位置很常见
 * （本机就有 `E:\Program Files\WorkBuddyAI`），而 `exePath` 依赖 PowerShell 读进程 Path——
 * PowerShell 被安全软件/组策略拦掉时拿不到，切号后"重新打开"就会报「未能定位可执行文件」，
 * 但用户手动双击又能打开（2026-10-20 用户反馈）。
 */
export function findExeUnderRoots(roots, io = { exists: existsQuiet, listDir: listDirQuiet }) {
  const matches = [];
  for (const root of roots) {
    if (!root || !io.exists(root)) continue;
    for (const e of io.listDir(root)) {
      if (!e.isDirectory() || !WORKBUDDY_DIR_RE.test(e.name)) continue;
      const found = findExeInDir(path.join(root, e.name), io);
      if (found) matches.push(found);
    }
  }
  if (matches.length <= 1) return matches[0] || null;
  // 装了多份时（常见于"新版装到别的盘、旧版没卸"）：取 exe 修改时间最新的那份，
  // 它才是用户真正在用的安装；路径顺序只作为同等条件下的兜底
  let best = matches[0];
  let bestTime = -1;
  for (const p of matches) {
    let t = 0;
    try {
      t = fs.statSync(p).mtimeMs || 0;
    } catch {
      t = 0;
    }
    if (t > bestTime) {
      bestTime = t;
      best = p;
    }
  }
  return best;
}

/**
 * Windows 上值得一查的安装根目录：环境变量给的 + 所有盘符的 Program Files + **盘符根目录**。
 *
 * 盘符根目录是 2026-10-25 补的：本机客户端装在 `E:\workbuddy`（盘符根 + 目录名），
 * 四个 Program Files 一个都盖不到，于是「切换账号后自动重新打开」稳定报
 * 「未能定位 WorkBuddy 可执行文件」。列一层目录的开销很小——findExeUnderRoots 只
 * 下钻名字匹配 WORKBUDDY_DIR_RE 的目录，不会真去遍历整块盘。
 */
export function installRoots(env = process.env) {
  const roots = [];
  const push = (p) => {
    if (p && !roots.includes(p)) roots.push(p);
  };
  push(env.ProgramFiles);
  push(env['ProgramFiles(x86)']);
  push(env.ProgramW6432);
  for (const drive of ['C', 'D', 'E', 'F', 'G', 'H']) {
    push(`${drive}:\\Program Files`);
    push(`${drive}:\\Program Files (x86)`);
  }
  if (env.LOCALAPPDATA) {
    push(path.join(env.LOCALAPPDATA, 'Programs'));
    push(env.LOCALAPPDATA);
  }
  if (env.APPDATA) push(path.join(env.APPDATA, 'Programs'));
  for (const drive of ['C', 'D', 'E', 'F', 'G', 'H']) push(`${drive}:\\`);
  return roots;
}

/**
 * exe 路径持久化缓存：`~/.wb-switch/workbuddy_exe.json`（与 workbuddy-switch 共用同一文件）。
 *
 * 为什么必须缓存：WorkBuddy 常被装在自定义位置（本机 `E:\workbuddy\WorkBuddy.exe`，
 * 不在任何 Program Files / LocalAppData\Programs 下）。
 * 而切换流程是「先杀进程 → 再重新打开」，杀完就再也读不到进程的真实路径了——
 * 一旦杀之前那一次 PowerShell 探测没拿到 Path，relaunch 就报「未能定位可执行文件」，
 * 用户只能手动打开（2026-10-21 用户反馈：切换后 WorkBuddy 没有自动重新打开）。
 * 缓存写入发生在杀进程之前，读取发生在 relaunch 定位时，正好补上这条链。
 *
 * 2026-10-25 修：`rememberExePath` 此前**从未被调用**（死代码），缓存永远是空的；
 * 唯一一条内容来自集成测试写的临时假 exe（`%TEMP%\wb-stop-test-*\WorkBuddyFake.exe`）。
 */
const SWITCH_HOME = String(process.env.WB_SWITCH_HOME || '').trim() || path.join(os.homedir(), '.wb-switch');
const EXE_CACHE_FILE = path.join(SWITCH_HOME, 'workbuddy_exe.json');

/**
 * 只有「看起来就是真客户端」的路径才能被信任：排除控制台自身与测试假文件。
 *
 * `allowTemp`：进程**当场读到的**路径无条件相信（那是它真正在跑的位置，
 * 便携版/测试桩都可能落在临时目录）；而缓存与目录扫描的结果不允许来自临时目录——
 * 本机缓存里那条 `%TEMP%\wb-stop-test-*\WorkBuddyFake.exe` 就是这么混进去的。
 */
function looksLikeRealWorkbuddyExe(p, { allowTemp = false } = {}) {
  const file = String(p || '');
  if (!file) return false;
  const base = path.basename(file);
  if (!EXE_NAME_RE.test(base)) return false;
  if (!allowTemp && /[\\/](?:tmp|temp)[\\/]/i.test(file)) return false;
  return true;
}

function readExeCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(EXE_CACHE_FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function writeExeCache(data) {
  try {
    fs.mkdirSync(path.dirname(EXE_CACHE_FILE), { recursive: true });
    fs.writeFileSync(EXE_CACHE_FILE, JSON.stringify(data, null, 2));
  } catch {
    /* 缓存写失败无关紧要，不干扰主流程 */
  }
}

/** 缓存里第一条真实存在的 exe 路径；顺手清掉失效/不可信的条目（测试假路径就这么被淘汰） */
function exeFromCache() {
  const data = readExeCache();
  let dirty = false;
  let hit = null;
  for (const [k, v] of Object.entries(data)) {
    const p = String(v || '');
    const usable = p && existsQuiet(p) && looksLikeRealWorkbuddyExe(p);
    if (!usable) {
      delete data[k];
      dirty = true;
      continue;
    }
    if (!hit) hit = p;
  }
  if (dirty) writeExeCache(data);
  return hit;
}

/** 把运行中读到的 exe 路径记下来（覆盖旧值：进程活着的路径永远比历史记录可信） */
function rememberExePath(exePath) {
  const p = String(exePath || '').trim();
  // 进程当场读到的路径允许来自临时目录（便携版就装在那里）
  if (!p || !existsQuiet(p) || !looksLikeRealWorkbuddyExe(p, { allowTemp: true })) return;
  try {
    const data = readExeCache();
    if (String(data.cn || '').toLowerCase() === p.toLowerCase()) return;
    data.cn = p; // key 无所谓，读取端只按「值是否存在」匹配
    writeExeCache(data);
  } catch {
    /* 缓存写失败无关紧要，不干扰主流程 */
  }
}

/**
 * 设置页里用户显式指定的安装位置（优先级最高：用户指过就别再猜）。
 *
 * 三个来源都认，是因为历史版本把「WorkBuddy 目录」这个设置说成了可指安装目录：
 * - workbuddyExePath：直接指到 exe
 * - workbuddyInstallDir：指到安装目录（`E:\workbuddy`）
 * - workbuddyDir：**语义是数据目录**，但若该目录下真有客户端 exe，也当成安装目录用
 *   （不该因为用户按旧提示填了一个"错的"设置就继续报错）
 */
function configuredExeCandidates() {
  let settings = {};
  try {
    settings = loadConfig()?.settings || {};
  } catch {
    return [];
  }
  const out = [];
  const exe = String(settings.workbuddyExePath || '').trim();
  if (exe) out.push(exe);
  for (const dir of [settings.workbuddyInstallDir, settings.workbuddyDir]) {
    const d = String(dir || '').trim();
    if (!d) continue;
    const found = findExeInDir(path.resolve(d));
    if (found) out.push(found);
  }
  return out;
}

/** 注册表兜底：装到非标准目录、又没被扫到时的最后一招（reg.exe 不依赖 PowerShell 策略） */
function findExeFromRegistry() {
  if (process.platform !== 'win32') return null;
  const uninstall = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
  const probes = [
    [`HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\WorkBuddy.exe`, '/ve'],
    [`HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\WorkBuddy.exe`, '/ve'],
    [`HKLM\\${uninstall}`, '/s', '/f', 'WorkBuddy', '/d'],
    [`HKCU\\${uninstall}`, '/s', '/f', 'WorkBuddy', '/d'],
  ];
  for (const args of probes) {
    let text = '';
    try {
      text = String(
        execFileSync('reg', ['query', ...args], {
          timeout: 5000,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
      );
    } catch {
      continue; // 查不到时 reg 的退出码是 1，属于正常情况
    }
    // 任何一行里出现的 `X:\...\WorkBuddy*.exe` 都拿来试一下（App Paths 的默认值、
    // 卸载项的 DisplayIcon 都是这种形状）
    const re = /([A-Za-z]:\\[^\r\n"]*?\.exe)/g;
    for (const m of text.match(re) || []) {
      const p = m.trim().replace(/,\d+$/, ''); // DisplayIcon 常带 ",0" 图标序号
      if (looksLikeRealWorkbuddyExe(p) && existsQuiet(p)) return p;
    }
  }
  return null;
}

/**
 * 定位 WorkBuddy 可执行文件。优先级（越靠前越可信）：
 * 1. 进程里读到的真实路径（调用方传入，通常来自 detectWorkbuddyProcess）
 * 2. 设置页里用户指定的安装位置
 * 3. 上次运行记下的路径缓存
 * 4. 几个写死的常见路径
 * 5. 安装根目录扫描（Program Files / 盘符根目录）
 * 6. 注册表 / 卸载项
 */
export function findWorkbuddyExe(detectedPath, { registry = true } = {}) {
  // 进程里读到的路径最权威（便携版可能就在临时目录里，故 allowTemp）
  if (looksLikeRealWorkbuddyExe(detectedPath, { allowTemp: true }) && existsQuiet(detectedPath)) return detectedPath;
  for (const p of configuredExeCandidates()) {
    if (existsQuiet(p)) return p;
  }
  const cached = exeFromCache();
  if (cached) return cached;
  const home = os.homedir();
  const quick = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
    'C:\\Program Files\\WorkBuddy\\WorkBuddy.exe',
    'C:\\Program Files (x86)\\WorkBuddy\\WorkBuddy.exe',
    path.join(home, 'AppData', 'Local', 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
  ];
  const direct = quick.find((p) => existsQuiet(p));
  if (direct) return direct;
  const scanned = findExeUnderRoots(installRoots());
  if (scanned) return scanned;
  // registry=false 供「设置页只读展示」用：reg 查询是阻塞的，不能挂在普通接口上
  return registry ? findExeFromRegistry() : null;
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
              warning: `已改用 tasklist 完成检测（PowerShell 暂不可用：${psError}），拿不到启动时间，会靠进程树兜底`,
            }
          : { processes: [], method: 'tasklist', warning: `已改用 tasklist 完成检测（PowerShell 暂不可用：${psError}）` };
      } catch (err2) {
        return { processes: [], error: `PowerShell（${psError}）与 tasklist（${shortExecError(err2)}）都不可用` };
      }
    }
  }
  // macOS / Linux 主路径：ps 全量进程表（自动剔除本工具自己的进程子树，按启动时间升序）
  try {
    return { processes: await listViaPs(names), method: 'ps', complete: true };
  } catch (err) {
    // 兜底用 pgrep：只拿得到 PID（无启动时间、无法剔除全部后代），
    // 仅剔除自己一个 PID——ps 都不可用的机器已经非常罕见， degraded 路径可接受
    const pattern = names.map((n) => n.replace(/\.exe$/i, '')).join('|');
    try {
      const stdout = await run('pgrep', ['-if', pattern], 8000);
      const processes = String(stdout)
        .split('\n')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0 && n !== process.pid)
        .map((pid) => ({ pid, name: null, exePath: null, startTime: null }));
      return { processes, method: 'pgrep', complete: true };
    } catch (err2) {
      // pgrep 无匹配时退出码为 1 —— 那是"没有进程"，不是探测失败
      if (err2?.code === 1) return { processes: [], method: 'pgrep', complete: true };
      return { processes: [], error: `ps（${err?.message || String(err)}）与 pgrep（${err2?.message || String(err2)}）都不可用` };
    }
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
  if (process.platform !== 'win32') {
    return run('kill', [force ? '-KILL' : '-TERM', String(pid)]).catch(() => {});
  }
  const args = ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])];
  // taskkill 偶发失败（PATH/权限/竞态）且原实现把错误静默吞掉，用户只看到
  // 「仍在运行」却不知道为什么。这里先 taskkill，失败立刻用 PowerShell
  // Stop-Process 兜底（实测可杀），两边都失败才放弃该 PID。
  return run('taskkill', args, 10000, { windowsHide: true }).catch((err1) => {
    return run(
      'powershell.exe',
      ['-NoProfile', '-Command', `Stop-Process -Id ${Number(pid)} -Force -ErrorAction Stop`],
      10000,
      { windowsHide: true }
    ).catch((err2) => {
      console.log(
        `[stop] PID ${pid} 两种方式都杀不掉: taskkill=${err1?.code || err1?.message} Stop-Process=${err2?.message || err2}`
      );
      return; // 单个杀不掉不影响其余进程（沿用原语义）
    });
  });
}

const SUSPEND_SCRIPT = path.join(import.meta.dirname ?? '.', 'suspend-workbuddy.ps1');

/**
 * asar 是虚拟文件系统：`powershell -File <.../app.asar/server/.../x.ps1>` 直接读不到内容，
 * 打包后冻结会静默失败。这里在打包场景先把脚本落到系统临时目录再交给 PowerShell；
 * 开发模式（node 直接跑）路径不含 app.asar，原样返回，不产生额外 IO。
 */
function suspendScriptPath() {
  if (!SUSPEND_SCRIPT.includes('app.asar')) return SUSPEND_SCRIPT;
  const tmp = path.join(os.tmpdir(), 'wb-console-suspend-workbuddy.ps1');
  try {
    // Electron 的 fs 补丁支持直接读取 asar 内文件，这里只是把它落到真实磁盘
    fs.writeFileSync(tmp, fs.readFileSync(SUSPEND_SCRIPT, 'utf8'), 'utf8');
    return tmp;
  } catch (e) {
    throw new Error(`冻结脚本无法解压到临时目录：${e?.message || e}`);
  }
}

/**
 * 冻结 WorkBuddy（NtSuspendProcess 挂起全部进程，不杀死）。
 *
 * 为什么不用强杀：WorkBuddy 被强杀后会被 Windows 的「崩溃自动重启」机制立刻
 * 拉活（实测杀光后 5 秒内 11 个新进程），force 轮永远判定失败，切换被拦。
 * 冻结则完全不触发该机制：进程活着但线程全部挂起——不会写库、不会改登录态、
 * 不会复活，是「停住它但不杀它」的最安全形态。
 *
 * 何时解冻/杀死由调用方决定：切换流程会在写完登录态后 kill 掉冻结进程，
 * 此时崩溃自动重启拉起的「新实例」读取的是磁盘上**已切换**的登录态——
 * 相当于自动打开了切换后账号的 WorkBuddy（2026-10-21 用户要求的最终形态）。
 */
export async function suspendWorkbuddy() {
  if (process.platform !== 'win32') {
    throw new Error('当前平台不支持冻结 WorkBuddy');
  }
  const proc = await detectWorkbuddyProcess();
  if (!proc.running) {
    return { suspended: true, wasRunning: false, count: 0 };
  }
  const stdout = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', suspendScriptPath()], 15000, {
    windowsHide: true,
  });
  const count = Number(String(stdout).trim().match(/suspended (\d+)/)?.[1] || 0);
  return { suspended: true, wasRunning: count > 0, count };
}

/**
 * 一次 tasklist 快速探活（不枚举 PowerShell，几十毫秒级）。
 * 只给「taskkill 失败」这条冷路径用来分辨「进程本来就不在」与「权限不够杀不掉」：
 * true=还在 / false=不在了 / null=探不出来。
 */
async function tasklistAlive(exe) {
  try {
    const out = await run('tasklist', ['/FI', `IMAGENAME eq ${exe}`, '/FO', 'CSV', '/NH'], 5000, { windowsHide: true });
    return new RegExp(`${exe.replace(/\./g, '\\.')}"`, 'i').test(String(out));
  } catch {
    return null;
  }
}

/**
 * 关进程前解析 exe 路径的完整顺序（冷路径，只多一次探测）：
 * 调用方传入的真实路径 → 缓存 → **趁进程还活着问一次** → 扫描/注册表。
 *
 * 最后一步的「问一次」是关键：缓存为空（首次使用、或缓存被清）时，
 * 一旦先杀了进程，就再也没人知道它装在哪了。
 */
async function resolveExePathBeforeKill(detectedPath) {
  if (looksLikeRealWorkbuddyExe(detectedPath, { allowTemp: true }) && existsQuiet(detectedPath)) {
    rememberExePath(detectedPath);
    return detectedPath;
  }
  const viaCache = exeFromCache();
  if (viaCache) return viaCache;
  try {
    const proc = await detectWorkbuddyProcess();
    const p = proc?.exePath || null;
    if (p) rememberExePath(p);
    if (looksLikeRealWorkbuddyExe(p, { allowTemp: true }) && existsQuiet(p)) return p;
  } catch {
    /* 探测失败不阻断关闭流程，退回扫描 */
  }
  return findWorkbuddyExe(detectedPath) || null;
}

/**
 * 确认 WorkBuddy 真的没有进程了（最多等 timeoutMs）。
 *
 * 写库前为什么要等：taskkill 返回不等于句柄已释放，而 WorkBuddy 被结束后还可能被
 * 系统的「崩溃自动恢复」在几秒内重新拉起来——新实例会立刻重新打开 workbuddy.db。
 * 写入落在这个窗口里就会撞锁/被回滚，表现为「点了转移，界面说成功，会话却没动」。
 */
export async function waitForWorkbuddyGone(timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let running = false;
    try {
      running = !!(await detectWorkbuddyProcess())?.running;
    } catch {
      running = false; // 探测不出来就认为已退出（否则会把用户永久卡在门口）
    }
    if (!running) return true;
    if (Date.now() >= deadline) return false;
    await sleep(250);
  }
}

/**
 * 结束（强杀）全部 WorkBuddy 进程并确认消失；用于冻结后的收尾。
 *
 * `detectedPath`：调用方在**杀之前**从进程里读到的真实路径。必须传——
 * 杀完之后进程没了，PowerShell 再也读不到 Path，只能靠缓存/扫描去猜。
 */
export async function killWorkbuddy(detectedPath = null) {
  // 与 stopWorkbuddy 同策略：一条 taskkill 结束全部，不做枚举与轮询。
  // 目标机器每 spawn 一个外部命令可能要 3~7 秒，循环枚举会把关闭拖到几十秒。
  const t0 = Date.now();
  const exePath = await resolveExePathBeforeKill(detectedPath);
  const exe = String(WORKBUDDY_PROCESS_NAMES[0] || 'WorkBuddy').replace(/\.exe$/i, '') + '.exe';
  let wasRunning = true;
  try {
    await run('taskkill', ['/IM', exe, '/T', '/F'], 6000, { windowsHide: true });
  } catch (e) {
    if (Number(e?.code) === 128) wasRunning = false; // 128 = 本来就不在
    // 收尾强杀是尽力而为，失败只留痕（调用方本来就把异常降级成 stopped:false）
    else console.log(`[kill] taskkill 失败：${shortExecError(e)}`);
  }
  if (wasRunning) await sleep(400);
  console.log('[kill] 关闭命令完成 ' + (Date.now() - t0) + 'ms（wasRunning=' + wasRunning + '）');
  // forced 如实反映「是否真的动过手」：本来就没人运行时 false（测试与 UI 文案都依赖）
  return { stopped: true, wasRunning, killed: [], forced: wasRunning, exePath, ms: Date.now() - t0 };
}

/**
 * 退出 WorkBuddy：一条 taskkill /IM ... /T /F 结束整棵树，随后只等 400ms 让句柄释放。
 *
 * 为什么不枚举再逐个杀：本机实测每次 spawn 子进程（枚举、杀进程都要新起进程）要 3.7 秒，
 * 一轮「枚举→杀→再枚举」就是十几秒；11 个进程循环下来 50 秒都收不住。
 * 应用被结束后会自动重启（新 PID），这属于正常现象——新实例读的是已切换好的登录态。
 *
 * ⚠️ 必须把「杀不掉」如实报错：原版枚举式实现会在确认不了退出时抛错，正是为了
 * 防止在客户端还活着的情况下继续切号 / 写库——那会让 WorkBuddy 把登录态改写回去，
 * 用户看到的是「切完账号登录状态莫名失效」。提速版用一条 taskkill 换速度没问题，
 * 但非 128 的失败（典型是控制台不是管理员 → 拒绝访问）不能当成成功静默吞掉。
 * 冷路径才多一次 tasklist 探活，正常成功路径零额外开销。
 *
 * @returns { stopped, wasRunning, killed, forced, exePath }
 */
export async function stopWorkbuddy({ names = WORKBUDDY_PROCESS_NAMES, detectedPath = null } = {}) {
  const t0 = Date.now();
  // 杀之前先把真实路径记下来：这一行是「自动重新打开」能找到 exe 的前提
  const exePath = await resolveExePathBeforeKill(detectedPath);
  const exe = String(names[0] || 'WorkBuddy').replace(/\.exe$/i, '') + '.exe';
  let wasRunning = true;
  try {
    await run('taskkill', ['/IM', exe, '/T', '/F'], 6000, { windowsHide: true });
  } catch (e) {
    if (Number(e?.code) === 128) {
      wasRunning = false; // 128 = 本来就不在
    } else {
      const alive = await tasklistAlive(exe);
      if (alive === true) {
        throw new Error(
          `无法结束 WorkBuddy（${shortExecError(e)}）：进程仍在运行，已中止以免登录态被改写。` +
            `请以管理员身份运行控制台后重试，或手动退出 WorkBuddy`
        );
      }
      if (alive === null) {
        throw new Error(`无法确认 WorkBuddy 是否已退出（${shortExecError(e)}），为安全起见已中止`);
      }
      wasRunning = false; // 进程确实不在了，taskkill 只是没找到目标
    }
  }
  if (wasRunning) await sleep(400);
  console.log('[stop] 关闭命令完成 ' + (Date.now() - t0) + 'ms（wasRunning=' + wasRunning + '）');
  return { stopped: true, wasRunning, killed: [], forced: wasRunning, exePath };
}

export async function launchWorkbuddy(exePath) {
  if (process.platform === 'darwin') {
    const bundle = findWorkbuddyAppBundle(exePath);
    if (!bundle) {
      throw new Error('未能定位 WorkBuddy 的 .app 包（/Applications 下未找到），请手动重新打开 WorkBuddy');
    }
    const child = spawn('open', [bundle], { detached: true, stdio: 'ignore' });
    child.on('error', () => {}); // 不让异步 error 把控制台进程带崩
    child.unref();
    return { launched: true, exePath: bundle };
  }
  if (process.platform !== 'win32') {
    throw new Error(`当前平台（${process.platform}）不支持自动重新打开 WorkBuddy，请手动打开`);
  }
  // 防重复开：已经在跑就不再 spawn（旧实例没死时越堆越多，关闭会越来越慢）
  const alive = await detectWorkbuddyProcess().catch(() => null);
  if (alive?.running) {
    return { launched: true, alreadyRunning: true, exePath: alive.exePath || exePath || null, verified: true };
  }
  const exe = findWorkbuddyExe(exePath);
  if (!exe) {
    // 把「查过哪些地方」写进服务日志：用户看不到控制台，出问题只能靠 /api/diag/tail
    const roots = installRoots();
    console.log(
      `[launch] 未能定位 exe。进程路径=${exePath || '(空)'} 缓存=${EXE_CACHE_FILE} 扫描根目录=${roots.join(' | ')}`
    );
    throw new Error(
      '未能定位 WorkBuddy 可执行文件：已查过程序路径缓存、设置里的安装目录、各盘 Program Files、' +
        '盘符根目录与注册表卸载项，都没有找到客户端 exe。' +
        (exePath ? `（读到的进程路径已失效：${exePath}）` : '（进程已退出，读不到安装路径）') +
        ' 请手动打开 WorkBuddy 后重试；也可以在「设置 → WorkBuddy 安装目录」里选到 WorkBuddy.exe 所在目录，' +
        '保存后会立即按该目录定位，不必再猜'
    );
  }
  return spawnAndVerify(exe);
}
/**
 * 拉起进程并确认它**真的起来了**。
 *
 * 为什么不能 spawn 完就报成功：`spawn` 的 ENOENT/EACCES 是**异步**事件（还会把没监听的
 * 进程直接带崩），而"起来了但立刻被安全软件拦掉"更是完全静默。用户看到"已自动重新打开"
 * 却发现客户端没开，比直接说失败更糟。这里等 spawn 事件 + 最多 4 秒的进程复检，
 * 把"发起成功但没活下来"如实降级成 warning。
 */
function namesForExe(exe) {
  return [path.basename(exe, '.exe')];
}

/** 读 tasklist /V 的窗口标题；空字符串表示窗口还没出来（进程起来 ≠ 用户能看到窗口） */
async function windowTitleOf(names) {
  for (const name of names) {
    const out = await run('tasklist', ['/FI', `IMAGENAME eq ${name}.exe`, '/V', '/FO', 'CSV', '/NH'], 4000, { windowsHide: true }).catch(() => '');
    for (const line of String(out).split(/\r?\n/)) {
      const cells = line.split('","');
      const title = (cells[8] || '').replace(/"$/, '').trim();
      if (title && title !== 'N/A') return title;
    }
  }
  return '';
}

async function spawnAndVerify(exe) {
  let spawnError = null;
  console.log(`[launch] 重新打开 WorkBuddy：${exe}`);
  // cwd 设成 exe 所在目录、windowsHide：和资源管理器双击的环境一致
  const child = spawn(exe, [], { detached: true, stdio: 'ignore', cwd: path.dirname(exe), windowsHide: true });
  child.on('error', (err) => {
    spawnError = err;
  });
  child.unref();

  await sleep(150);
  if (spawnError) {
    throw new Error(`启动 ${path.basename(exe)} 失败：${spawnError.message}（路径：${exe}），请手动打开`);
  }

  // 命令行拉起时应用常常只驻留托盘、不弹窗口；再启动一次等价于「双击图标」，
  // 单实例机制会把已有窗口激活出来（用户手动就是这么做的）。
  await sleep(2000);
  try {
    const again = spawn(exe, [], { detached: true, stdio: 'ignore', cwd: path.dirname(exe), windowsHide: true });
    again.on('error', () => {});
    again.unref();
  } catch {
    /* 第二次唤起失败不影响主体 */
  }

  const tSpawn = Date.now();
  for (let i = 0; i < 80; i++) {
    await sleep(500);
    const title = await windowTitleOf(namesForExe(exe)).catch(() => '');
    if (title) {
      console.log(`[launch] 窗口就绪 ${Date.now() - tSpawn}ms（标题：${title}）`);
      return { launched: true, exePath: exe, verified: true, readyMs: Date.now() - tSpawn };
    }
  }
  console.log('[launch] 40 秒内没等到窗口，按已发起处理');
  return { launched: true, exePath: exe, verified: false, warning: '已发起启动，但 40 秒内没看到窗口；若确实没出现，请手动打开' };
}
/** macOS：从检测到的可执行文件路径反推 .app 包路径（如 /Applications/WorkBuddy.app），失败按常见位置兜底 */
function findWorkbuddyAppBundle(exePath) {
  const m = String(exePath || '').match(/^(\/.+?\.app)\//i);
  const candidates = [
    m?.[1],
    '/Applications/WorkBuddy.app',
    '/Applications/CodeBuddy.app',
    path.join(os.homedir(), 'Applications', 'WorkBuddy.app'),
  ].filter(Boolean);
  return candidates.find((p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
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
    const child = await spawnAndVerify(exe);
    return { restarted: true, ...child };
  }
  if (process.platform === 'darwin') {
    if (!proc.pid) throw new Error('未获取到进程 ID，无法重启');
    await terminatePid(proc.pid, true);
    await new Promise((r) => setTimeout(r, 1500));
    const bundle = findWorkbuddyAppBundle(proc.exePath);
    if (!bundle) {
      throw new Error('未能定位 WorkBuddy 的 .app 包，请手动重新打开 WorkBuddy');
    }
    const child = spawn('open', [bundle], { detached: true, stdio: 'ignore' });
    child.unref();
    return { restarted: true, exePath: bundle };
  }
  throw new Error(`当前平台（${process.platform}）暂不支持自动重启，请手动重启 WorkBuddy`);
}
