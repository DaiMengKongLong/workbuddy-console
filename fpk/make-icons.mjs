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

/* ---------- PNG 解码（只支持 8bit RGB/RGBA 非隔行，够读 sips 的产物） ---------- */
function decodePng(buf) {
  let off = 8;
  let ihdr = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') ihdr = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!ihdr) throw new Error('不是合法 PNG');
  const w = ihdr.readUInt32BE(0);
  const h = ihdr.readUInt32BE(4);
  const depth = ihdr[8];
  const color = ihdr[9];
  const interlace = ihdr[12];
  if (depth !== 8 || interlace !== 0 || (color !== 6 && color !== 2)) {
    throw new Error(`暂不支持的 PNG：depth=${depth} color=${color} interlace=${interlace}`);
  }
  const ch = color === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(w * h * 4, 0);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[p++];
    const row = raw.subarray(p, p + stride);
    p += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? out[y * w * 4 + i - ch] : 0; // 左
      const b = y > 0 ? out[(y - 1) * w * 4 + i] : 0; // 上
      const c = i >= ch && y > 0 ? out[(y - 1) * w * 4 + i - ch] : 0; // 左上
      let v = row[i];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      // 逐通道还原：索引 i 对应通道 i%ch，写入 RGBA
      const px = Math.floor(i / ch);
      out[y * w * 4 + px * 4 + (i % ch)] = v & 0xff;
    }
    if (ch === 3) for (let x = 0; x < w; x++) out[y * w * 4 + x * 4 + 3] = 255;
  }
  return { w, h, rgba: out };
}

/**
 * 编码成 **16bit RGBA** PNG。
 * 为什么要 16bit：对照飞牛上图标正常显示的 com.dustinky.tunnel，它的 ICON.PNG / ICON_256.PNG
 * 以及 ui/images 里的图标全是 `16-bit/color RGBA`；我们此前一直出 8bit，应用中心就是不显示。
 * 尺寸改了、缓存也刷了都无效，位深是最后一个可观测差异，所以对齐到 16bit。
 */
function encodePng16(w, h, rgba8) {
  const bpp = 8; // 4 通道 × 2 字节
  const stride = w * bpp;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    const o = y * (stride + 1);
    raw[o] = 0; // filter: None
    for (let i = 0; i < w * 4; i++) {
      const v = rgba8[y * w * 4 + i];
      const hi = (v << 8) | v; // 8bit → 16bit 等比例展开
      raw.writeUInt16BE(hi & 0xffff, o + 1 + i * 2);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 16; // bit depth 16
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

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
  // 返回原始 RGBA，由调用方决定编码成 8bit 还是 16bit
  return { rgba: buf, size };
}

fs.mkdirSync(OUT_UI, { recursive: true });

/**
 * 图标缓存强制刷新（飞牛的坑，论坛同款解法）：
 * 应用中心与桌面都会**缓存图标**，重装/升级同名应用并不会自动刷新——
 * 我们前几个版本换了图标但列表里还是灰色占位图，就是这个原因。
 * 社区验证过的做法：图标文件名带上版本后缀（icon_64_<v>.png / icon_256_<v>.png），
 * 同时把 ui/config 里 `icon: images/icon_{0}.png` 的路径改成带同样后缀，
 * 缓存键变了 → 客户端被迫重新拉取。{0} 会被替换成 64/256，所以文件名必须长这样。
 */
function versionTag() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    return String(pkg.version || '0.0.0').replace(/\./g, '');
  } catch {
    return '000';
  }
}

function refreshDesktopIconCache() {
  const tag = versionTag();
  const configPath = path.join(__dirname, 'app', 'ui', 'config');
  for (const size of [64, 256]) {
    const src = path.join(OUT_UI, `icon_${size}.png`);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(OUT_UI, `icon_${size}_${tag}.png`));
  }
  try {
    const cfg = fs.readFileSync(configPath, 'utf8');
    const next = cfg.replace(
      /("icon"\s*:\s*")images\/icon_\{0\}[^"]*(")/,
      `$1images/icon_{0}_${tag}.png$2`,
    );
    if (next !== cfg) {
      fs.writeFileSync(configPath, next);
      console.log(`      ui/config 图标路径已切到带版本后缀的副本（icon_{0}_${tag}.png），强制刷新客户端图标缓存`);
    } else if (!/icon_\{0\}_/.test(cfg)) {
      console.log('      ⚠ ui/config 里没找到 icon 路径，未做缓存刷新');
    }
  } catch (e) {
    console.log('      ⚠ ui/config 更新失败：' + e.message);
  }
}

// 优先使用官方图标（fpk/assets/icon-source.png，来自上游 build/icon.png 1024x1024），
// macOS 用 sips 缩放；没有源图/没有 sips 时才回落到内置绘制的 WB 图标。
const SRC = path.join(__dirname, 'assets', 'icon-source.png');
if (fs.existsSync(SRC)) {
  try {
    // ⚠️ ICON.PNG 必须是 1024×1024：飞牛应用中心安装向导/列表只认大图。
    // 实测对照已装且图标正常的 com.dustinky.tunnel：ICON.PNG = 1024×1024、ICON_256.PNG = 256×256；
    // 之前这里生成的是 64×64，结果安装过程与列表里完全没有图标。
    const gen = (size, out) => execFileSync('sips', ['-Z', String(size), SRC, '--out', out], { stdio: 'ignore' });
    // sips 只能出 8bit，先用它缩尺寸，再解码重编成 16bit（与正常显示图标的应用对齐）
    const gen16 = (size, out) => {
      const tmp = `${out}.tmp8.png`;
      gen(size, tmp);
      const { w, h, rgba } = decodePng(fs.readFileSync(tmp));
      fs.writeFileSync(out, encodePng16(w, h, rgba));
      fs.rmSync(tmp, { force: true });
    };
    // ⚠️ ICON.PNG / ICON_256.PNG 统一 **256×256**。
    // 试错记录：64×64 不显示 → 改 1024×1024（对齐图标正常显示的 com.dustinky.tunnel）仍不显示
    // → 再加 16bit RGBA 仍不显示 → 客户端图标缓存刷了也没用。
    // 飞牛打包文档写的是「ICON.PNG、ICON_256.PNG（256×256，应用中心读这两个）」，
    // 尺寸是唯一还没验证过的变量，按文档来。
    gen16(256, path.join(__dirname, 'ICON.PNG'));
    gen16(256, path.join(__dirname, 'ICON_256.PNG'));
    gen16(256, path.join(OUT_UI, 'icon_256.png'));
    gen16(64, path.join(OUT_UI, 'icon_64.png'));
    refreshDesktopIconCache();
    console.log('图标已生成（官方源图缩放，16bit RGBA）：ICON.PNG(1024) / ICON_256.PNG(256) / app/ui/images/icon_{64,256}.png');
    process.exit(0);
  } catch (e) {
    console.log('sips 缩放失败，回落内置绘制：' + e.message);
  }
}
for (const [size, out] of [
  [256, path.join(__dirname, 'ICON.PNG')],
  [256, path.join(__dirname, 'ICON_256.PNG')],
  [256, path.join(OUT_UI, 'icon_256.png')],
  [64, path.join(OUT_UI, 'icon_64.png')],
]) {
  const { rgba } = draw(size);
  fs.writeFileSync(out, encodePng16(size, size, rgba));
}
refreshDesktopIconCache();
console.log('图标已生成（内置绘制，16bit RGBA）：ICON.PNG(1024) / ICON_256.PNG(256) / app/ui/images/icon_{64,256}.png');
