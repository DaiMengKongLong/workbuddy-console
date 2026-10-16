/**
 * electron-builder afterPack 钩子：删除 Chromium 的许可证文档。
 *
 * `LICENSES.chromium.html`（约 19.5MB）是 Chromium 的第三方许可证汇编，
 * 纯文档、不参与运行；Electron 官方允许在分发时省略。
 * 每个平台各删一份，多平台产物合计省下约 12-30MB 下载量。
 *
 * 实现用**递归查找**而不是硬编码路径：
 * - Windows/Linux：`<appOutDir>/LICENSES.chromium.html`
 * - macOS：`<appOutDir>/<productName>.app/Contents/Resources/LICENSES.chromium.html`
 * 两种结构（以及日后 electron 改版）都能覆盖，避免"漏删"。（实测踩过：只写
 * 相对路径的版本在 mac 上删不掉。）
 *
 * 导出写法：electron-builder 各版本对钩子模块的取值方式不完全一致
 * （有的取 `module.exports`，有的取 `module.exports.default`），
 * 这里两者同时指向同一个函数，避免"钩子不是函数"的打包失败。
 */
const fs = require('node:fs');
const path = require('node:path');

/** 需要清除的许可证文档名（大小写按 Electron 产物的实际命名） */
const TARGET_NAMES = new Set(['LICENSES.chromium.html', 'LICENSES.chromium.txt']);
/** 递归深度上限：appOutDir → .app/*.framework/... 最多几层，防意外深层遍历 */
const MAX_DEPTH = 6;

function collectTargets(dir, depth, out) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // 无权限/不存在的分支直接跳过，不影响打包
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTargets(full, depth + 1, out);
    } else if (entry.isFile() && TARGET_NAMES.has(entry.name)) {
      out.push(full);
    }
  }
}

async function afterPack(context) {
  const appOutDir = context?.appOutDir;
  if (!appOutDir || !fs.existsSync(appOutDir)) return;

  const targets = [];
  collectTargets(appOutDir, 1, targets);

  const removed = [];
  for (const file of targets) {
    try {
      const size = fs.statSync(file).size;
      fs.rmSync(file, { force: true });
      removed.push(`${path.relative(appOutDir, file)} (${(size / 1048576).toFixed(1)}MB)`);
    } catch (err) {
      // 删不掉不该让打包失败：这只是体积优化
      console.warn(`[afterPack] 跳过 ${file}：${err?.message || err}`);
    }
  }
  if (removed.length) console.log(`[afterPack] 已删除许可证文档：${removed.join(', ')}`);
}

module.exports = afterPack;
module.exports.default = afterPack;
