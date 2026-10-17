/**
 * 自检：设置页「检查更新」→ 左下角版本区 的广播链路（src/lib/appUpdate.ts）。
 *
 * 背景（2026-10-18）：装 v0.2.8 的用户在设置页点「检查更新」，页面已经显示「发现新版本」，
 * 左下角却没有升级按钮——那份代码只在组件挂载时查一次。修复是「两处共用同一份结果」：
 * 检查完广播一次，常驻组件收到就更新。这个脚本不需要浏览器，用 EventTarget 当 window 替身，
 * 把 TS 现场转译后直接跑，保证 emit/on 的配对、退订、多订阅者行为不被后续改动改坏。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src', 'lib', 'appUpdate.ts');

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

// --- 把 window 换成 EventTarget 替身（Node 自带 CustomEvent） ---
globalThis.window = new EventTarget();

const src = fs.readFileSync(SRC, 'utf8');
const { code } = await transform(src, { loader: 'ts', format: 'esm', target: 'es2022' });
const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

console.log('1. emit / on 基本配对');
{
  const got = [];
  const off = mod.onUpdateChecked((info) => got.push(info));
  mod.emitUpdateChecked({ current: '0.2.8', latest: '0.2.9', hasUpdate: true });
  check('订阅者收到广播', got.length === 1, `收到 ${got.length} 次`);
  check('载荷原样透传', got[0]?.latest === '0.2.9' && got[0]?.hasUpdate === true);
  off();
}

console.log('2. 退订后不再收到');
{
  const got = [];
  const off = mod.onUpdateChecked((info) => got.push(info));
  mod.emitUpdateChecked({ hasUpdate: true, latest: '0.2.9' });
  off();
  mod.emitUpdateChecked({ hasUpdate: false, latest: '0.2.9' });
  check('退订前收到 1 次', got.length === 1, `实际 ${got.length}`);
}

console.log('3. 多订阅者各自收到');
{
  const a = [];
  const b = [];
  const offA = mod.onUpdateChecked((i) => a.push(i));
  const offB = mod.onUpdateChecked((i) => b.push(i));
  mod.emitUpdateChecked({ hasUpdate: true, latest: '0.3.0' });
  check('两个订阅者都收到', a.length === 1 && b.length === 1, `a=${a.length} b=${b.length}`);
  offA();
  offB();
}

console.log('4. 空载荷不触发回调（避免把常驻组件刷成 null）');
{
  const got = [];
  const off = mod.onUpdateChecked((i) => got.push(i));
  window.dispatchEvent(new CustomEvent('wb:update-checked'));
  check('detail 缺失时不回调', got.length === 0, `实际 ${got.length}`);
  off();
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
