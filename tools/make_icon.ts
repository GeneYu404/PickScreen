/**
 * 生成 512x512 应用图标 icon.png（拾屏 Logo：青蓝渐变圆角方块 + 取景角标 + 中心画面）
 * 纯 bun 实现：手写 PNG 编码（IHDR + IDAT + IEND + CRC32），无需任何图像库。
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const W = 512;
const H = 512;

/* ---------- 工具 ---------- */
function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const len = data.length;
  const out = new Uint8Array(12 + len);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, len);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + len, crc32(out.subarray(4, 8 + len)));
  return out;
}

/* ---------- 绘制 ---------- */
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** 圆角矩形有符号距离（内部为负） */
function sdRoundRect(px: number, py: number, cx: number, cy: number, hw: number, hh: number, r: number): number {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}
/** 线段距离（圆头） */
function sdSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const t = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * t, pay - bay * t);
}
const stroke = (d: number, half: number) => Math.max(0, Math.min(1, half - d + 0.5));

const pixels = new Uint8Array(W * H * 4);
const RADIUS = 132; // 圆角半径（对应 Logo s*0.26）

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const d = sdRoundRect(x + 0.5, y + 0.5, W / 2, H / 2, W / 2 - 1, H / 2 - 1, RADIUS);
    const cover = Math.max(0, Math.min(1, 1 - d)); // 抗锯齿覆盖

    if (cover <= 0) {
      pixels[i + 3] = 0;
      continue;
    }
    // 对角渐变 #14b8a6 -> #2563eb
    const t = Math.max(0, Math.min(1, (x + y) / (W + H)));
    let r = Math.round(lerp(0x14, 0x25, t));
    let g = Math.round(lerp(0xb8, 0x63, t));
    let b = Math.round(lerp(0xa6, 0xeb, t));

    // 白色取景角标（4 个 L 形角）+ 中心画面
    const TH = 26;
    const IN = 118; // 内缩
    const L = 74; // 角标臂长
    let white = 0;
    const corners: [number, number, number, number][] = [
      [IN, IN, IN + L, IN],
      [IN, IN, IN, IN + L],
      [W - IN, IN, W - IN - L, IN],
      [W - IN, IN, W - IN, IN + L],
      [IN, H - IN, IN + L, H - IN],
      [IN, H - IN, IN, H - IN - L],
      [W - IN, H - IN, W - IN - L, H - IN],
      [W - IN, H - IN, W - IN, H - IN - L],
    ];
    for (const [ax, ay, bx, by] of corners) white = Math.max(white, stroke(sdSeg(x, y, ax, ay, bx, by), TH / 2));
    // 中心画面（白色圆角矩形）
    const inner = sdRoundRect(x + 0.5, y + 0.5, W / 2, H / 2 + 14, 78, 97, 24);
    white = Math.max(white, Math.max(0, Math.min(1, 0.5 - inner)));

    if (white > 0) {
      r = Math.round(lerp(r, 255, white));
      g = Math.round(lerp(g, 255, white));
      b = Math.round(lerp(b, 255, white));
    }
    pixels[i] = r;
    pixels[i + 1] = g;
    pixels[i + 2] = b;
    pixels[i + 3] = Math.round(255 * cover);
  }
}

/* ---------- PNG 打包 ---------- */
const stride = W * 4;
const raw = new Uint8Array((stride + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (stride + 1)] = 0; // filter: none
  raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
}
const ihdr = new Uint8Array(13);
const dv = new DataView(ihdr.buffer);
dv.setUint32(0, W);
dv.setUint32(4, H);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ...chunk("IHDR", ihdr),
  ...chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))),
  ...chunk("IEND", new Uint8Array(0)),
]);

const out = process.argv[2] ?? "icon.png";
writeFileSync(out, png);
console.log(`written ${out} (${png.length} bytes, ${W}x${H})`);
