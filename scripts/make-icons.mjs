/**
 * 生成桌面应用所需的多平台图标（输出到 build/，供 electron-builder 使用）。
 *
 *   node scripts/make-icons.mjs
 *
 * 产物：
 *   build/icon.png         1024×1024  —— Windows/Linux 通用、electron BuilderWindow 兜底
 *   build/icon.ico         多尺寸 PNG 打包的 ICO —— Windows 安装包 / exe / 任务栏
 *   build/icon.icns        多尺寸 PNG 打包的 ICNS —— macOS dmg / app
 *   build/tray.png         64×64 彩色 —— Windows 托盘
 *   build/trayTemplate.png 44×44 剪影（仅 alpha 着色为黑） —— macOS 菜单栏模板图
 *
 * 为什么自己拼 ICO/ICNS：二者都只是「小头 + 若干张 PNG」的容器，
 * 不必为了一个图标再引入 electron-icon-builder / 依赖 macOS 的 iconutil。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LOGO = path.join(ROOT, 'assets', 'logo.svg');
const OUT = path.join(ROOT, 'build');

/** macOS 圆角矩形底：图标本体是 1024，mac 惯例四周留 80px 安全边 */
const SIZE = 1024;
const PAD = 84;
const RADIUS = 232;

function background() {
  const inner = SIZE - PAD * 2;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#818cf8"/>
      <stop offset="0.55" stop-color="#6366f1"/>
      <stop offset="1" stop-color="#5b21b6"/>
    </linearGradient>
  </defs>
  <rect x="${PAD}" y="${PAD}" width="${inner}" height="${inner}" rx="${RADIUS}" fill="url(#g)"/>
  <rect x="${PAD}" y="${PAD}" width="${inner}" height="${inner}" rx="${RADIUS}" fill="none"
        stroke="#ffffff" stroke-opacity="0.22" stroke-width="6"/>
</svg>`);
}

async function renderMaster() {
  const glyph = await sharp(LOGO, { density: 480 })
    .resize(Math.round(SIZE * 0.74), Math.round(SIZE * 0.74), { fit: 'contain' })
    .toBuffer();
  return sharp(background())
    .composite([{ input: glyph, gravity: 'centre' }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** 任意尺寸重采样（PNG） */
const resize = (buf, size) => sharp(buf).resize(size, size, { fit: 'cover' }).png().toBuffer();

/* ---------------- ICO（Windows） ---------------- */

async function buildIco(master) {
  const sizes = [256, 128, 64, 48, 32, 16];
  const images = await Promise.all(sizes.map(async (s) => ({ s, data: await resize(master, s) })));

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const dirEntrySize = 16;
  const dir = Buffer.alloc(dirEntrySize * images.length);
  let offset = header.length + dir.length;
  images.forEach((img, i) => {
    const base = i * dirEntrySize;
    dir.writeUInt8(img.s === 256 ? 0 : img.s, base); // 256 用 0 表示
    dir.writeUInt8(img.s === 256 ? 0 : img.s, base + 1);
    dir.writeUInt8(0, base + 2); // 调色板色数
    dir.writeUInt8(0, base + 3); // reserved
    dir.writeUInt16LE(1, base + 4); // color planes
    dir.writeUInt16LE(32, base + 6); // bits per pixel
    dir.writeUInt32LE(img.data.length, base + 8);
    dir.writeUInt32LE(offset, base + 12);
    offset += img.data.length;
  });

  return Buffer.concat([header, dir, ...images.map((i) => i.data)]);
}

/* ---------------- ICNS（macOS） ---------------- */

/**
 * ICNS = 'icns' + 总长(含 8 字节头) + 若干条目。
 * 条目类型与像素尺寸（PNG 形态）：
 *   ic11 32 · ic12 64 · ic07 128 · ic08 256 · ic09 512 · ic10 1024
 *   ic13 512（256@2x） · ic14 1024（512@2x）
 */
const ICNS_TYPES = [
  ['ic11', 32],
  ['ic12', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic13', 512],
  ['ic14', 1024],
];

async function buildIcns(master) {
  const entries = [];
  for (const [type, size] of ICNS_TYPES) {
    const data = await resize(master, size);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(data.length + 8, 4);
    entries.push(Buffer.concat([head, data]));
  }
  const total = entries.reduce((n, b) => n + b.length, 0) + 8;
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(total, 4);
  return Buffer.concat([header, ...entries]);
}

/* ---------------- 托盘剪影（macOS 菜单栏模板图） ---------------- */

/**
 * macOS 菜单栏图标会按模板图处理：只取 alpha，颜色由系统决定。
 * 因此这里把 logo 的不透明区域统一刷成黑色，避免彩色底变成一坨黑方块。
 */
async function buildTrayTemplate() {
  const size = 44;
  const { data, info } = await sharp(LOGO, { density: 600 })
    .resize(size, size, { fit: 'contain' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out = Buffer.from(data);
  for (let i = 0; i < out.length; i += info.channels) {
    out[i] = 0;
    out[i + 1] = 0;
    out[i + 2] = 0;
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .png()
    .toBuffer();
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const master = await renderMaster();

  const write = (name, buf) => {
    fs.writeFileSync(path.join(OUT, name), buf);
    console.log(`  build/${name.padEnd(18)} ${(buf.length / 1024).toFixed(1)} KB`);
  };

  console.log('生成桌面应用图标：');
  write('icon.png', master);
  write('icon.ico', await buildIco(master));
  write('icon.icns', await buildIcns(master));
  write('tray.png', await resize(master, 64));
  write('trayTemplate.png', await buildTrayTemplate());
}

main().catch((err) => {
  console.error('图标生成失败:', err);
  process.exit(1);
});
