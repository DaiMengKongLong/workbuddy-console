/**
 * WorkBuddy 可执行文件定位测试（离线，只用临时目录造文件）。
 *
 * 守的是 2026-10-20 的用户反馈：「已切换到 xxx，Workbuddy 已退出但重新打开失败」。
 * 根因是切号后重开要靠 `exePath`（PowerShell 读进程 Path），PowerShell 被安全软件/
 * 组策略拦掉时拿不到，而兜底候选只写了 3 个**写死**的默认路径——装在自定义位置
 * （本机就有 `E:\Program Files\WorkBuddyAI`）的用户必然找不到，手动双击却能打开。
 *
 * 现在的判据：
 *   - 进程给的路径优先（存在就用它）
 *   - 否则扫 Program Files / Program Files (x86) / LocalAppData\Programs 下
 *     目录名以 WorkBuddy / CodeBuddy 开头的安装目录
 *   - 认多种 exe 名（WorkBuddy.exe / WorkBuddyAI.exe / WorkBuddy AI.exe / CodeBuddy.exe）
 *     与一层版本子目录（app-1.2.3/）
 *   - 绝不误扫到无关程序
 *
 * 运行：node scripts/test-exe-discovery.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-exe-'));
const mk = (...segs) => {
  const p = path.join(tmp, ...segs);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '');
  return p;
};

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

const { findExeUnderRoots, findExeInDir, installRoots, findWorkbuddyExe } = await import('../server/targets/workbuddy.mjs');

console.log('\n[1] 自定义安装目录（本机真实形态：E:\\Program Files\\WorkBuddyAI）');
{
  const root = path.join(tmp, 'pf-e');
  const exe = mk('pf-e', 'WorkBuddyAI', 'WorkBuddyAI.exe');
  check('能认出 WorkBuddyAI.exe', findExeUnderRoots([root]) === exe, findExeUnderRoots([root]));
}

console.log('\n[2] 标准目录 + 版本子目录');
{
  const root = path.join(tmp, 'pf-c');
  const exe = mk('pf-c', 'WorkBuddy', 'app-1.2.3', 'WorkBuddy.exe');
  check('能穿透一层版本目录找到 exe', findExeUnderRoots([root]) === exe, findExeUnderRoots([root]));
}

console.log('\n[3] 多种发行名');
{
  const cases = [
    ['WorkBuddy', 'WorkBuddy.exe'],
    ['WorkBuddyAI', 'WorkBuddy AI.exe'],
    ['CodeBuddy', 'CodeBuddy.exe'],
  ];
  for (const [dir, file] of cases) {
    const root = path.join(tmp, `multi-${dir}`);
    const exe = mk(path.basename(root), dir, file);
    check(`${dir}/${file} 能被找到`, findExeUnderRoots([root]) === exe);
  }
}

console.log('\n[4] 不误伤：无关程序、名字相近但不是 workbuddy');
{
  const root = path.join(tmp, 'pf-x');
  mk('pf-x', 'NotWorkBuddy', 'NotWorkBuddy.exe');
  mk('pf-x', 'Chrome', 'chrome.exe');
  check('无匹配时返回 null', findExeUnderRoots([root]) === null, findExeUnderRoots([root]));
  check('目录不存在也不报错', findExeUnderRoots([path.join(tmp, 'no-such-root')]) === null);
}

console.log('\n[5] 多根目录：装了多份时取最新那份');
{
  const a = path.join(tmp, 'r1');
  const b = path.join(tmp, 'r2');
  const exeB = mk('r2', 'WorkBuddy', 'WorkBuddy.exe');
  check('只有一个匹配时用它', findExeUnderRoots([a, b]) === exeB);

  const oldExe = mk('r3', 'WorkBuddy', 'WorkBuddy.exe');
  const newExe = mk('r4', 'WorkBuddyAI', 'WorkBuddyAI.exe');
  const t0 = new Date(Date.now() - 86400000);
  fs.utimesSync(oldExe, t0, t0);
  check('两份安装时选 mtime 更新的那份（旧版没卸载也不误开）', findExeUnderRoots([path.join(tmp, 'r3'), path.join(tmp, 'r4')]) === newExe);
}

console.log('\n[6] 单目录内的优先级：已知文件名优先于通配');
{
  const dir = path.join(tmp, 'direct');
  const canonical = mk('direct', 'WorkBuddy.exe');
  mk('direct', 'WorkBuddyHelper.exe');
  check('优先返回 WorkBuddy.exe', findExeInDir(dir) === canonical, findExeInDir(dir));
}

console.log('\n[7] installRoots：要覆盖其它盘符与 LocalAppData\\Programs');
{
  const roots = installRoots({ ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local' });
  check('包含 C 盘 Program Files', roots.includes('C:\\Program Files'));
  check('包含 D 盘 Program Files', roots.includes('D:\\Program Files'));
  check('包含 LocalAppData\\Programs', roots.includes(path.join('C:\\Users\\demo\\AppData\\Local', 'Programs')));
  check('没有重复项', new Set(roots).size === roots.length);
}

console.log('\n[8] 进程给的路径优先');
{
  const direct = mk('detected', 'WorkBuddy.exe');
  check('detectedPath 存在时直接用它', findWorkbuddyExe(direct) === direct, findWorkbuddyExe(direct));
  check('detectedPath 为空时不会抛错', typeof findWorkbuddyExe(null) === 'string' || findWorkbuddyExe(null) === null);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('失败项：\n' + failures.map((f) => '  - ' + f).join('\n'));
  process.exit(1);
}
