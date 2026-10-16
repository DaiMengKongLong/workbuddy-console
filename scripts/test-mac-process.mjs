/**
 * macOS 进程筛选逻辑回归：守护 2026-10-17 macOS 用户反馈的「切号时 workbuddy 意外退出」修复。
 *
 * 根因：macOS 分支曾用 `pgrep -if WorkBuddy|CodeBuddy` 按完整命令行做子串匹配，
 * 打包后的控制台进程名恰好是 "WorkBuddy Console"（web 版脚本路径也含 workbuddy），
 * 切号时把自己连同 Helper 一起杀掉 → macOS 弹「意外退出」。
 *
 * 修复后核心逻辑在 selectWorkbuddyRows（纯函数），任何平台都可测：
 *   1) 本工具自己的进程子树（自己 + 全部后代，含 Electron Helper）必须被剔除；
 *   2) 真实 WorkBuddy / CodeBuddy 的进程必须保留；
 *   3) 按启动时间升序（主进程排最前，先杀主进程避免 helper 先死把主进程搞崩）；
 *   4) parsePsProcessTable 能解析真实 ps 输出（含单位数日期、带参数的 Helper 命令行）。
 *
 * 运行：node scripts/test-mac-process.mjs
 */
import { parsePsProcessTable, selectWorkbuddyRows } from '../server/targets/workbuddy.mjs';

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

/** 模拟一段真实的 macOS `ps -axo pid=,ppid=,lstart=,command=` 输出 */
const FAKE_PS = [
  '  510     1 Thu Oct 16 09:00:00 2026 /Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy',
  '  511   510 Thu Oct 16 09:00:01 2026 /Applications/WorkBuddy.app/Contents/Frameworks/WorkBuddy Helper (Renderer).app/Contents/MacOS/WorkBuddy Helper (Renderer) --type=renderer',
  '  512   510 Thu Oct 16 09:00:01 2026 /Applications/WorkBuddy.app/Contents/Frameworks/WorkBuddy Helper (GPU).app/Contents/MacOS/WorkBuddy Helper (GPU) --type=gpu-process',
  // 控制台自己（打包后的进程名就是 WorkBuddy Console；web 版路径也含 workbuddy）：
  // 主进程 = 本测试进程自身，Helper 是它的子进程 —— 绝不能出现在结果里
  `  ${process.pid}     1 Wed Oct 15 22:10:00 2026 ${process.execPath}`,
  `  701  ${process.pid} Wed Oct 15 22:10:00 2026 ${process.execPath} --type=utility --utility-sub-type=network.mojom.NetworkService`,
  `  702  ${process.pid} Wed Oct 15 22:10:01 2026 ${process.execPath} --type=renderer`,
  // 无关进程（不匹配模式）
  '  800     1 Thu Oct 16 08:00:00 2026 /usr/sbin/cfprefsd agent',
  // macOS 真实 ps 对单位数日期会补双空格
  '  900     1 Fri Oct  3 12:30:00 2026 /Applications/CodeBuddy.app/Contents/MacOS/CodeBuddy',
].join('\n');

section('1. parsePsProcessTable：解析真实 ps 输出');
const rows = parsePsProcessTable(FAKE_PS);
check('解析出全部 8 行', rows.length === 8, rows.length);
check('pid/ppid 数值正确', rows[0].pid === 510 && rows[0].ppid === 1, rows[0]);
check('主进程 startTime 正确（2026-10-16 09:00:00 本地时区）', rows[0].startTime === new Date(2026, 9, 16, 9, 0, 0).getTime(), rows[0]);
check('单位数日期行（Oct 3）可解析', rows.some((r) => r.pid === 900 && r.startTime === new Date(2026, 9, 3, 12, 30, 0).getTime()), rows.find((r) => r.pid === 900));
check('Helper 带参数的完整命令行保留', rows.find((r) => r.pid === 511)?.command.includes('--type=renderer'), rows.find((r) => r.pid === 511));

section('2. selectWorkbuddyRows：剔除自己 + 保留真实 WorkBuddy');
const sel = selectWorkbuddyRows(rows);
const pids = sel.map((p) => p.pid);
check('自己的主进程（process.pid）被剔除', !pids.includes(process.pid), pids);
check('自己的 Helper（ppid 指向自己）被剔除', !pids.includes(701) && !pids.includes(702), pids);
check('真实 WorkBuddy 主进程保留', pids.includes(510), pids);
check('真实 WorkBuddy 的 Helper 保留（它们不是我们的子进程）', pids.includes(511) && pids.includes(512), pids);
check('CodeBuddy 保留', pids.includes(900), pids);
check('无关进程不入选', !pids.includes(800), pids);

section('3. selectWorkbuddyRows：主进程排序在前（先杀主进程，避免 helper 先死搞崩主进程）');
check('启动最早者排第一（CodeBuddy Oct 3 早于 WorkBuddy Oct 16）', sel[0]?.pid === 900, sel.map((p) => p.pid));
check('WorkBuddy 主进程（510）排在其 Helper（511/512）之前', pids.indexOf(510) < pids.indexOf(511) && pids.indexOf(510) < pids.indexOf(512), pids);
const starts = sel.map((p) => p.startTime ?? Number.MAX_SAFE_INTEGER);
check('整体按启动时间升序', starts.every((t, i) => i === 0 || starts[i - 1] <= t), starts);

section('4. exePath / name 提取');
check('主进程 exePath 取命令行首段', sel.find((p) => p.pid === 510)?.exePath === '/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy', sel.find((p) => p.pid === 510));
check('name 取自 exePath 末段', sel.find((p) => p.pid === 510)?.name === 'WorkBuddy', sel.find((p) => p.pid === 510));

section('5. 自定义 names 传参仍生效（测试替身机制不回退）');
const selFake = selectWorkbuddyRows(rows, ['WorkBuddyFake']);
check('替身名单下真实 WorkBuddy 不入选', !selFake.some((p) => p.pid === 510), selFake.map((p) => p.pid));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
