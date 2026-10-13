/**
 * 生成项目封面图（GitHub Social Preview / README 头图）。
 *
 * 设计要点：
 * - 复用 assets/logo.svg 的吉祥物本体（内联后缩放），保证与品牌完全一致，不做二次绘制；
 * - 全矢量绘制后由 sharp 光栅化，文字为真实字形而非 AI 生图，中英文都不会写错；
 * - 输出 1280x640（GitHub Social Preview 标准 2:1）与 2560x1280 二倍图。
 *
 * 用法：node scripts/make-cover.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 画布尺寸（GitHub Social Preview 官方推荐 1280x640） */
const W = 1280;
const H = 640;

/** 品牌色（取自 assets/logo.svg 与 README 徽标） */
const C = {
  bgTop: '#211d52',
  bgBottom: '#0a0918',
  indigo: '#6366f1',
  indigoLight: '#a5b4fc',
  indigoFaint: '#c7d2fe',
  amber: '#fbbf24',
  mint: '#6ee7b7',
  text: '#ffffff',
  muted: '#94a3b8',
};

/** 中英文混排字体栈：Windows 走雅黑，macOS 走苹方 */
const SANS = "'Microsoft YaHei UI','Microsoft YaHei','PingFang SC','Hiragino Sans GB','Noto Sans CJK SC',sans-serif";
const LATIN = "'Segoe UI','Helvetica Neue',Helvetica,Arial,sans-serif";

/** 吉祥物摆放：logo 画布 512，主体中心约在 (256, 285) */
const MASCOT = { cx: 292, cy: 300, scale: 0.79 };

/** 取出 logo.svg 的内部内容（去掉外层 svg 标签），保留其 defs 里的渐变 id */
function logoInner() {
  const raw = fs.readFileSync(path.join(root, 'assets', 'logo.svg'), 'utf8');
  return raw.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
}

/** 四角星光（复用 logo 中的星形路径） */
function star(x, y, s, fill, opacity = 1) {
  return `<path d="M0 -16 C2 -6 6 -2 16 0 C6 2 2 6 0 16 C-2 6 -6 2 -16 0 C-6 -2 -2 -6 0 -16 Z"
    transform="translate(${x} ${y}) scale(${s})" fill="${fill}" opacity="${opacity}"/>`;
}

/** 圆角胶囊 */
function pill(x, y, w, h, opts = {}) {
  const { fill = 'rgba(255,255,255,0.07)', stroke = 'rgba(165,180,252,0.28)', sw = 1.5 } = opts;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
}

/** 带序号圆点的步骤胶囊 */
function stepPill(x, y, w, h, n) {
  const cy = y + h / 2;
  return [
    pill(x, y, w, h),
    `<circle cx="${x + 26}" cy="${cy}" r="12" fill="${C.indigo}"/>`,
    `<text x="${x + 26}" y="${cy + 6}" font-family="${LATIN}" font-size="16" font-weight="700"
       fill="#ffffff" text-anchor="middle">${n}</text>`,
  ].join('');
}

/** 平台胶囊（无序号，小一号） */
function chip(x, y, w, h, label) {
  return [
    pill(x, y, w, h, { fill: 'rgba(255,255,255,0.05)', stroke: 'rgba(165,180,252,0.22)', sw: 1 }),
    `<text x="${x + w / 2}" y="${y + h / 2 + 6}" font-family="${SANS}" font-size="16" font-weight="500"
       fill="${C.indigoFaint}" text-anchor="middle">${label}</text>`,
  ].join('');
}

const mtx = {
  x: MASCOT.cx - 256 * MASCOT.scale,
  y: MASCOT.cy - 285 * MASCOT.scale,
};

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${C.bgTop}"/>
      <stop offset="1" stop-color="${C.bgBottom}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${C.indigo}" stop-opacity="0.55"/>
      <stop offset="0.55" stop-color="${C.indigo}" stop-opacity="0.16"/>
      <stop offset="1" stop-color="${C.indigo}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glowR" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#8b5cf6" stop-opacity="0.32"/>
      <stop offset="1" stop-color="#8b5cf6" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="title" x1="0" y1="0" x2="1" y2="0.4">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="0.62" stop-color="#e9e6ff"/>
      <stop offset="1" stop-color="${C.indigoLight}"/>
    </linearGradient>
    <linearGradient id="rule" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.22"/>
      <stop offset="0.55" stop-color="#ffffff" stop-opacity="0.08"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <pattern id="dots" width="34" height="34" patternUnits="userSpaceOnUse">
      <circle cx="2" cy="2" r="1.4" fill="#ffffff"/>
    </pattern>
  </defs>

  <!-- 背景 -->
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#dots)" opacity="0.055"/>
  <circle cx="300" cy="300" r="460" fill="url(#glow)"/>
  <circle cx="1130" cy="70" r="330" fill="url(#glowR)"/>

  <!-- 吉祥物周围的同心圆环 -->
  <circle cx="300" cy="300" r="252" fill="none" stroke="${C.indigo}" stroke-opacity="0.20" stroke-width="1.5"/>
  <circle cx="300" cy="300" r="308" fill="none" stroke="${C.indigo}" stroke-opacity="0.10" stroke-width="1.5"/>

  <!-- 背景星光 -->
  ${star(96, 92, 1.15, C.amber, 0.9)}
  ${star(608, 592, 0.55, C.indigoLight, 0.45)}
  ${star(520, 104, 0.7, C.mint, 0.55)}
  ${star(560, 560, 0.85, C.amber, 0.5)}
  ${star(1232, 300, 0.9, C.indigoLight, 0.45)}
  ${star(660, 46, 0.5, C.indigoLight, 0.4)}
  ${star(1050, 486, 0.55, C.mint, 0.35)}

  <!-- 吉祥物（内联自 logo.svg） -->
  <g transform="translate(${mtx.x.toFixed(2)} ${mtx.y.toFixed(2)}) scale(${MASCOT.scale})">
    ${logoInner()}
  </g>

  <!-- 文案区 -->
  <text x="562" y="188" font-family="${SANS}" font-size="19" font-weight="600"
        letter-spacing="4.5" fill="${C.indigoLight}">账号 · 模型 · 用量</text>

  <text x="560" y="288" font-family="${LATIN},${SANS}" font-size="72" font-weight="700"
        letter-spacing="-1" fill="url(#title)">WorkBuddy 管理台</text>

  <text x="562" y="338" font-family="${SANS}" font-size="25" font-weight="400"
        fill="${C.indigoFaint}">把账号、模型、用量收进同一个本地工具</text>

  <!-- 三步流程 -->
  ${stepPill(560, 384, 176, 50, 1)}
  <text x="608" y="415" font-family="${SANS}" font-size="18" font-weight="500" fill="#e2e8ff">扫码加账号</text>
  ${stepPill(752, 384, 176, 50, 2)}
  <text x="800" y="415" font-family="${SANS}" font-size="18" font-weight="500" fill="#e2e8ff">载入模型</text>
  ${stepPill(944, 384, 176, 50, 3)}
  <text x="992" y="415" font-family="${SANS}" font-size="18" font-weight="500" fill="#e2e8ff">统计用量</text>

  <!-- 分隔线 -->
  <rect x="80" y="512" width="1120" height="1.5" fill="url(#rule)"/>

  <!-- 底栏左：许可与隐私 -->
  <text x="80" y="562" font-family="${SANS}" font-size="17" font-weight="400"
        fill="${C.muted}">MIT 开源 · 完全免费 · 数据只存本机</text>

  <!-- 底栏右：可用平台 -->
  ${chip(740, 536, 128, 38, 'OpenRouter')}
  ${chip(880, 536, 112, 38, '硅基流动')}
  ${chip(1004, 536, 88, 38, '魔搭')}
  ${chip(1104, 536, 96, 38, 'Agnes AI')}
</svg>`;

const outDir = path.join(root, 'assets');
fs.mkdirSync(outDir, { recursive: true });

const buf = Buffer.from(svg);
// density 96 = 1x，192 = 2x：按目标倍数原生光栅化，避免放大导致文字发虚
const targets = [
  { file: 'cover.png', width: W, height: H, density: 96 },
  { file: 'cover@2x.png', width: W * 2, height: H * 2, density: 192 },
];

for (const t of targets) {
  const out = path.join(outDir, t.file);
  const info = await sharp(buf, { density: t.density })
    .resize(t.width, t.height, { fit: 'fill' })
    .png({ compressionLevel: 9 })
    .toFile(out);
  console.log(`${t.file}  ${info.width}x${info.height}  ${(info.size / 1024).toFixed(1)} KB`);
}

// 同时保留矢量源文件，便于后续微调
fs.writeFileSync(path.join(outDir, 'cover.svg'), svg, 'utf8');
console.log('cover.svg  已写入（矢量源，可继续编辑）');
