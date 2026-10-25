// 生成 FPK 图标（纯 Node 实现，不依赖任何图形库）
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_UI = path.join(__dirname, 'app', 'ui', 'images');

/* ---------- PNG 编码 ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(w, h, rgba) {
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- 5x7 位图字模 ---------- */
const GLYPH = {
  W: ['10001', '10001', '10001', '10101', '10101', '01010', '01010'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
};

function draw(size) {
  const buf = Buffer.alloc(size * size * 4);
  const put = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
  };

  // 圆角渐变背景
  const radius = Math.round(size * 0.22);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inCorner =
        ((x < radius && y < radius && (radius - x) ** 2 + (radius - y) ** 2 > radius ** 2) ||
          (x > size - 1 - radius && y < radius && (x - (size - 1 - radius)) ** 2 + (radius - y) ** 2 > radius ** 2) ||
          (x < radius && y > size - 1 - radius && (radius - x) ** 2 + (y - (size - 1 - radius)) ** 2 > radius ** 2) ||
          (x > size - 1 - radius && y > size - 1 - radius && (x - (size - 1 - radius)) ** 2 + (y - (size - 1 - radius)) ** 2 > radius ** 2));
      if (inCorner) continue;
      const t = y / (size - 1);
      const r = Math.round(74 + (111 - 74) * t);
      const g = Math.round(124 + (155 - 124) * t);
      const b = Math.round(247 + (255 - 247) * t);
      put(x, y, r, g, b, 255);
    }
  }

  // 白色 WB
  const s = Math.max(1, Math.floor(size / 14));
  const glyphW = 5 * s;
  const gap = Math.max(1, Math.floor(s * 0.6));
  const totalW = glyphW * 2 + gap;
  let ox = Math.round((size - totalW) / 2);
  const oy = Math.round((size - 7 * s) / 2);
  for (const ch of ['W', 'B']) {
    const rows = GLYPH[ch];
    for (let ry = 0; ry < rows.length; ry++) {
      for (let rx = 0; rx < rows[ry].length; rx++) {
        if (rows[ry][rx] !== '1') continue;
        for (let dy = 0; dy < s; dy++) {
          for (let dx = 0; dx < s; dx++) put(ox + rx * s + dx, oy + ry * s + dy, 255, 255, 255, 255);
        }
      }
    }
    ox += glyphW + gap;
  }
  return encodePng(size, size, buf);
}

fs.mkdirSync(OUT_UI, { recursive: true });

// 优先使用官方图标（fpk/assets/icon-source.png，来自上游 build/icon.png 1024x1024），
// macOS 用 sips 缩放；没有源图/没有 sips 时才回落到内置绘制的 WB 图标。
const SRC = path.join(__dirname, 'assets', 'icon-source.png');
if (fs.existsSync(SRC)) {
  try {
    // ⚠️ ICON.PNG 必须是 1024×1024：飞牛应用中心安装向导/列表只认大图。
    // 实测对照已装且图标正常的 com.dustinky.tunnel：ICON.PNG = 1024×1024、ICON_256.PNG = 256×256；
    // 之前这里生成的是 64×64，结果安装过程与列表里完全没有图标。
    const gen = (size, out) => execFileSync('sips', ['-Z', String(size), SRC, '--out', out], { stdio: 'ignore' });
    gen(1024, path.join(__dirname, 'ICON.PNG'));
    gen(256, path.join(__dirname, 'ICON_256.PNG'));
    gen(256, path.join(OUT_UI, 'icon_256.png'));
    gen(64, path.join(OUT_UI, 'icon_64.png'));
    console.log('图标已生成（官方源图缩放）：ICON.PNG(1024) / ICON_256.PNG(256) / app/ui/images/icon_{64,256}.png');
    process.exit(0);
  } catch (e) {
    console.log('sips 缩放失败，回落内置绘制：' + e.message);
  }
}
const p1024 = draw(1024);
const p256 = draw(256);
const p64 = draw(64);
fs.writeFileSync(path.join(__dirname, 'ICON.PNG'), p1024);
fs.writeFileSync(path.join(__dirname, 'ICON_256.PNG'), p256);
fs.writeFileSync(path.join(OUT_UI, 'icon_64.png'), p64);
fs.writeFileSync(path.join(OUT_UI, 'icon_256.png'), p256);
console.log('图标已生成：ICON.PNG(1024) / ICON_256.PNG(256) / app/ui/images/icon_{64,256}.png');
