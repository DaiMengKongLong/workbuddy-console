/**
 * 生成飞牛 fnOS 的**热更新包**（`-hotupdate.tar.gz`）。
 *
 * 与完整 .fpk 的区别：只包含会变的那部分——`server/`（后端）、`dist/`（前端）、`package.json`。
 * `node_modules/` 与内置 Node 运行时不变，留在已装好的目录里不动，所以包只有几百 KB，
 * 界面上点「一键更新」几秒就换完，用户既不用下载 .fpk 也不用到应用中心卸载重装。
 *
 * 用法：
 *   node tools/make-hotupdate.mjs            # 只打 server/ + dist/ + package.json
 *   INCLUDE_DEPS=1 node tools/make-hotupdate.mjs   # 依赖也一起打进去（依赖变更时才需要）
 *
 * 产物：dist-fpk/wbconsole-fnos-<version>-hotupdate.tar.gz
 *       同目录下还会生成 <同名>.sha256，便于手工核对。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist-fpk');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = String(pkg.version || '0.0.0');
const name = `wbconsole-fnos-${version}`;
const tarball = path.join(OUT_DIR, `${name}-hotupdate.tar.gz`);

// 每次都从干净的暂存目录开始，避免上一轮的残留文件被打包进去
const work = path.join(OUT_DIR, '.hotupdate-work');
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
const stage = path.join(work, name);
fs.mkdirSync(stage, { recursive: true });

fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(stage, 'package.json'));
fs.cpSync(path.join(ROOT, 'server'), path.join(stage, 'server'), { recursive: true, dereference: true });
fs.cpSync(path.join(ROOT, 'dist'), path.join(stage, 'dist'), { recursive: true, dereference: true });
if (process.env.INCLUDE_DEPS === '1') {
  fs.cpSync(path.join(ROOT, 'fpk', 'app', 'node_modules'), path.join(stage, 'node_modules'), {
    recursive: true,
    dereference: true,
  });
  console.log('      已包含 node_modules（INCLUDE_DEPS=1）');
}

// 打包前清掉 macOS 垃圾与符号链接（飞牛解压器拒绝符号链接，与 fpk 构建同一套约束）
try {
  execFileSync('find', [stage, '-name', '.DS_Store', '-delete'], { stdio: 'ignore' });
} catch {}
let dropped = 0;
(function walk(dir) {
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    if (fs.lstatSync(p).isSymbolicLink()) {
      fs.unlinkSync(p);
      dropped++;
      continue;
    }
    if (fs.statSync(p).isDirectory()) walk(p);
  }
})(stage);
if (dropped) console.log(`      删除符号链接 ${dropped} 个`);

// 验货：热更新包替换到运行目录后，缺任何一个都会让服务起不来
for (const must of ['server/index.mjs', 'dist/index.html', 'package.json']) {
  if (!fs.existsSync(path.join(stage, must))) {
    console.error(`打包中止：缺少 ${must}`);
    process.exit(1);
  }
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.rmSync(tarball, { force: true });
execFileSync('tar', ['-czf', tarball, '-C', work, name], { stdio: 'ignore' });

const buf = fs.readFileSync(tarball);
const sha = crypto.createHash('sha256').update(buf).digest('hex');
fs.writeFileSync(`${tarball}.sha256`, `${sha}  ${path.basename(tarball)}\n`);

fs.rmSync(work, { recursive: true, force: true });

console.log(`\n完成：${tarball}（${(buf.length / 1024 / 1024).toFixed(2)} MB）`);
console.log(`sha256：${sha}`);
