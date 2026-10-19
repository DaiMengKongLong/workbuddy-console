/**
 * 自检：设置变更广播（src/lib/appSettings.ts）。
 *
 * 背景（2026-10-19）：页面是常驻挂载 + hidden 切换，免费模型页只在自己的子页签变化时取数，
 * 于是「设置里打开『显示全部平台』→ 切回免费模型」看不到平台被放开，必须 F5。
 * 修复靠这条广播把变更推给常驻页面。这里不启浏览器，用 EventTarget 当 window 替身跑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src', 'lib', 'appSettings.ts');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
  }
};

globalThis.window = new EventTarget();

const src = fs.readFileSync(SRC, 'utf8');
const { code } = await transform(src, { loader: 'ts', format: 'esm', target: 'es2022' });
const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

console.log('1. emit / on 配对');
{
  const got = [];
  const off = mod.onSettingsChanged((p) => got.push(p));
  mod.emitSettingsChanged({ unlockAllPlatforms: true });
  check('订阅者收到补丁', got.length === 1, `收到 ${got.length}`);
  check('补丁内容原样透传', got[0]?.unlockAllPlatforms === true, JSON.stringify(got[0]));
  off();
}

console.log('2. 退订后不再收到');
{
  const got = [];
  const off = mod.onSettingsChanged((p) => got.push(p));
  mod.emitSettingsChanged({ autoCheckUpdate: false });
  off();
  mod.emitSettingsChanged({ autoCheckUpdate: true });
  check('退订前 1 次、退订后不再增长', got.length === 1, `实际 ${got.length}`);
}

console.log('3. 多订阅者各自收到（设置页 + 免费模型页并存）');
{
  const a = [];
  const b = [];
  const offA = mod.onSettingsChanged((p) => a.push(p));
  const offB = mod.onSettingsChanged((p) => b.push(p));
  mod.emitSettingsChanged({ unlockAllPlatforms: false });
  check('两个订阅者都收到', a.length === 1 && b.length === 1, `a=${a.length} b=${b.length}`);
  offA();
  offB();
}

console.log('4. 空载荷不触发（避免把页面刷成 undefined）');
{
  const got = [];
  const off = mod.onSettingsChanged((p) => got.push(p));
  window.dispatchEvent(new CustomEvent('wb:settings-changed'));
  check('detail 缺失时不回调', got.length === 0, `实际 ${got.length}`);
  off();
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
