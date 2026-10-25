/**
 * 进程生命周期回归测试：验证「自动退出 WorkBuddy」这条链路真的能关掉进程。
 *
 * 为什么不用真的 WorkBuddy 来测：
 *   测试机上真实客户端多半正开着（本会话就跑在它里面），关掉它等于自杀。
 *   所以把 node.exe 复制成同名替身 `WorkBuddyFake.exe` 后台拉起，
 *   再用 `stopWorkbuddy({ names: ['WorkBuddyFake'] })` 走完整条
 *   「枚举 → 优雅退出 → 强杀 → 确认消失」流程。
 *
 * 替身是无窗口的控制台进程：`taskkill` 不带 `/F` 对它必然失败
 * （没有窗口可发 WM_CLOSE），所以这里恰好能覆盖**强杀分支**。
 *
 * 安全断言：被杀的 PID 里绝不能出现真实 WorkBuddy 的任何一个进程。
 *
 * 运行：node scripts/test-stop-process.mjs      （仅 Windows 有意义，其他平台自动跳过）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { listWorkbuddyProcesses, stopWorkbuddy, detectWorkbuddyProcess } from '../server/targets/workbuddy.mjs';

const FAKE_NAME = 'WorkBuddyFake';
const FAKE_NAMES = [FAKE_NAME];

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

const tmpDir = path.join(os.tmpdir(), `wb-stop-test-${process.pid}`);
fs.mkdirSync(tmpDir, { recursive: true });
const fakeExe = path.join(tmpDir, `${FAKE_NAME}.exe`);

/** 后台拉起替身进程（保持存活），返回 pid */
function spawnFake() {
  const child = spawn(fakeExe, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

/** 兜底清理：无论断言成败都要确保替身不留在系统里 */
async function killFakeHard(pid) {
  const { processes } = await listWorkbuddyProcesses({ names: FAKE_NAMES }).catch(() => ({ processes: [] }));
  for (const p of processes) {
    await new Promise((resolve) => {
      execFile('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    });
  }
  void pid;
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('非 Windows 平台，跳过进程生命周期测试');
    return;
  }

  console.log(`临时目录：${tmpDir}`);
  console.log(`替身可执行文件：${fakeExe}`);

  // 记录测试开始前真实 WorkBuddy 的 PID，用于最后的安全断言
  const realBefore = (await listWorkbuddyProcesses()).processes.map((p) => p.pid);
  console.log(`测试前真实 WorkBuddy 进程数：${realBefore.length}`);

  section('1. 没有同名进程时：快速返回 wasRunning:false，不报错');
  {
    const r = await stopWorkbuddy({ names: ['WorkBuddyNoSuchNameXyz'] });
    check('stopped = true', r.stopped === true, r);
    check('wasRunning = false（无需结束任何进程）', r.wasRunning === false, r);
    check('killed 为空数组', Array.isArray(r.killed) && r.killed.length === 0, r.killed);
    check('forced = false', r.forced === false, r.forced);

    const list = await listWorkbuddyProcesses({ names: ['WorkBuddyNoSuchNameXyz'] });
    check('listWorkbuddyProcesses 返回空列表且无 error', !list.error && list.processes.length === 0, list);
  }

  section('2. 替身进程可被枚举到（负号名字不会误伤真进程）');
  fs.copyFileSync(process.execPath, fakeExe);
  const fakePid = spawnFake();
  // 等它出现在进程表里
  let visible = [];
  for (let i = 0; i < 15; i++) {
    const { processes } = await listWorkbuddyProcesses({ names: FAKE_NAMES });
    visible = processes;
    if (visible.length) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  try {
    check('替身进程已被枚举到', visible.length >= 1, visible);
    check('枚举到的 PID 就是刚拉起的那个', visible.some((p) => p.pid === fakePid), { visible, fakePid });
    check('能取到可执行文件路径', visible.every((p) => typeof p.exePath === 'string' && p.exePath.length > 0), visible);

    const detected = await detectWorkbuddyProcess({ names: FAKE_NAMES });
    check('detectWorkbuddyProcess 报告 running:true', detected.running === true, detected);
    check('detectWorkbuddyProcess 的 pid 命中替身', detected.pid === fakePid, detected);

    section('3. stopWorkbuddy：优雅退出失败 → 自动升级强杀 → 确认消失');
    const stopped = await stopWorkbuddy({ names: FAKE_NAMES, gracefulMs: 1500, forceMs: 8000 });
    check('stopped = true', stopped.stopped === true, stopped);
    check('wasRunning = true（确实关掉了东西）', stopped.wasRunning === true, stopped);
    // 提速版 stopWorkbuddy 用一条 taskkill /IM /T /F 结束整棵树，不再枚举 PID
    // （枚举一轮要十几秒），killed 恒为 []；真正要保证的是下面「替身彻底消失」。
    check('killed 为数组（提速版不枚举 PID，恒为空）', Array.isArray(stopped.killed), stopped.killed);
    check(
      '无窗口进程走的是强杀分支（forced = true）',
      stopped.forced === true,
      stopped
    );

    const after = await listWorkbuddyProcesses({ names: FAKE_NAMES });
    check('替身进程已彻底消失', after.processes.length === 0, after);

    const detectedAfter = await detectWorkbuddyProcess({ names: FAKE_NAMES });
    check('detectWorkbuddyProcess 之后报告 running:false', detectedAfter.running === false, detectedAfter);
    check(
      '探测结果里 error 为空（否则切号会在最后一道门上被自己拦住）',
      detectedAfter.error === null || detectedAfter.error === undefined,
      detectedAfter
    );
  } finally {
    await killFakeHard(fakePid);
  }

  section('4. 安全断言：全过程没有碰真实 WorkBuddy');
  {
    const realAfter = (await listWorkbuddyProcesses()).processes.map((p) => p.pid);
    // 只管「测试前存在的真进程有没有被我们杀」——App 自己会增减渲染/GPU 子进程，不能要求数量相等
    const vanished = realBefore.filter((pid) => !realAfter.includes(pid));
    check(
      `测试前存在且属于真实 WorkBuddy 的进程没有被误杀（共 ${realBefore.length} 个）`,
      vanished.length === 0,
      { vanished }
    );
  }

  section('5. 「确实没有进程」不得被误报成「无法判定」');
  {
    /**
     * 这条守的是真实踩过的坑：探测函数曾把"另一种探测方式不可用"也算成"无法判定"。
     * 而本机 PowerShell 被安全策略拦掉，于是**杀掉 WorkBuddy 之后的那次复检**必然报"无法确认"，
     * 切号被自己拦住、登录态永远写不进去，界面还回一句误导文案（「请手动退出后重试」）。
     */
    const ABSENT = ['WorkBuddyDefinitelyAbsentXyz'];
    const d = await detectWorkbuddyProcess({ names: ABSENT });
    check('确定没有该进程时 running = false', d.running === false, d);
    check('确定没有该进程时 error 为空（关键断言）', d.error === null || d.error === undefined, d);

    const l = await listWorkbuddyProcesses({ names: ABSENT });
    check('listWorkbuddyProcesses 同样不报 error', !l.error, l);
    check('listWorkbuddyProcesses 列表为空', l.processes.length === 0, l);

    // 反向断言：真的在跑时必须能探测到（别为了修 above 把探测改瞎了）
    const real = await detectWorkbuddyProcess();
    check(
      '真实 WorkBuddy 若在运行则仍能被探测到（未把探测改瞎）',
      real.running === true || real.error != null || realBefore.length === 0,
      { real, realBeforeCount: realBefore.length }
    );
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail) {
    console.log('\n失败项：');
    for (const f of failures) console.log(`  - ${f}`);
  }
  return fail === 0;
}

let ok = false;
try {
  ok = await main();
} catch (err) {
  console.error('测试自身异常：', err);
  ok = false;
} finally {
  try {
    await killFakeHard(null);
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* 替身进程可能还占着文件句柄，交给系统临时目录清理 */
  }
}
process.exit(ok ? 0 : 1);
