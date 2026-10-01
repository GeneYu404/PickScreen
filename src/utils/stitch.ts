/**
 * 长截图拼接算法（内容识别）
 * 思路：把每一帧压缩成「每行 32 个灰度桶」的签名，
 * 在上一帧与新帧之间搜索使重叠区域差异最小的垂直偏移量 s，
 * 然后把新帧底部新出现的 s 行追加到长图末尾。
 */
const BUCKETS = 32;

export type StitchStatus = 'init' | 'appended' | 'nochange' | 'seam' | 'full';

function signature(frame: HTMLCanvasElement): Float32Array {
  const w = frame.width;
  const h = frame.height;
  const data = frame.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
  const sig = new Float32Array(h * BUCKETS);
  const bw = w / BUCKETS;
  const step = Math.max(1, Math.floor(bw / 6));
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let b = 0; b < BUCKETS; b++) {
      const x0 = Math.floor(b * bw);
      const x1 = Math.max(x0 + 1, Math.floor((b + 1) * bw));
      let sum = 0;
      let n = 0;
      for (let x = x0; x < x1 && x < w; x += step) {
        const i = row + x * 4;
        sum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        n++;
      }
      sig[y * BUCKETS + b] = n ? sum / n : 0;
    }
  }
  return sig;
}

/** 比较 prev 的第 (y+s) 行与 next 的第 y 行 */
function rowCost(prev: Float32Array, next: Float32Array, s: number, y: number): number {
  let d = 0;
  const pi = (y + s) * BUCKETS;
  const ni = y * BUCKETS;
  for (let b = 0; b < BUCKETS; b++) d += Math.abs(prev[pi + b] - next[ni + b]);
  return d / BUCKETS;
}

function meanCost(prev: Float32Array, next: Float32Array, s: number, h: number, rowStep: number): number {
  const overlap = h - s;
  let sum = 0;
  let n = 0;
  for (let y = 0; y < overlap; y += rowStep) {
    sum += rowCost(prev, next, s, y);
    n++;
  }
  return n ? sum / n : Infinity;
}

/** 截尾均值：忽略差异最大的 30% 行（吸顶元素、闪烁光标等） */
function trimmedCost(prev: Float32Array, next: Float32Array, s: number, h: number): number {
  const overlap = h - s;
  if (overlap <= 0) return Infinity;
  const arr = new Float32Array(overlap);
  for (let y = 0; y < overlap; y++) arr[y] = rowCost(prev, next, s, y);
  arr.sort();
  const keep = Math.max(1, Math.floor(overlap * 0.7));
  let sum = 0;
  for (let i = 0; i < keep; i++) sum += arr[i];
  return sum / keep;
}

/**
 * 返回值：0 = 画面没有变化；-1 = 找不到可靠的重叠；>0 = 内容向上移动的像素行数
 * hint：调用方已知的大致滚动量（设备像素），仅用于在多个等价候选中取舍
 */
export function findShift(prev: Float32Array, next: Float32Array, h: number, hint = 0): number {
  if (meanCost(prev, next, 0, h, 2) < 1.2) return 0;

  const minOverlap = Math.max(24, Math.floor(h * 0.08));
  const maxShift = h - minOverlap;
  if (maxShift < 1) return -1;

  const coarseStep = h > 900 ? 2 : 1;
  const costs: { s: number; c: number }[] = [];
  let bestCost = Infinity;
  for (let s = 1; s <= maxShift; s += coarseStep) {
    const overlap = h - s;
    const rowStep = Math.max(1, Math.floor(overlap / 240));
    const c = meanCost(prev, next, s, h, rowStep);
    costs.push({ s, c });
    if (c < bestCost) bestCost = c;
  }

  // 近似并列的候选（例如大片空白区域）：优先取最接近 hint 的，否则取重叠最大的
  const ties = costs.filter((k) => k.c <= bestCost + 0.8);
  let best = ties[0].s;
  if (ties.length > 1) {
    if (hint > 0) {
      best = ties.reduce((a, k) => (Math.abs(k.s - hint) < Math.abs(a - hint) ? k.s : a), ties[0].s);
    }
  }

  // 精细化：在 ±2 行范围内用截尾均值重新评估
  let fine = best;
  let fineCost = Infinity;
  for (let s = Math.max(1, best - 2); s <= Math.min(maxShift, best + 2); s++) {
    const c = trimmedCost(prev, next, s, h);
    if (c < fineCost) {
      fineCost = c;
      fine = s;
    }
  }
  return fineCost < 10 ? fine : -1;
}

export class LongShotStitcher {
  private canvas: HTMLCanvasElement | null = null;
  private used = 0;
  private fw = 0;
  private fh = 0;
  private prev: Float32Array | null = null;
  frames = 0;
  static readonly MAX_HEIGHT = 32000;

  get width() {
    return this.fw;
  }
  get height() {
    return this.used;
  }
  get source() {
    return this.canvas;
  }

  push(frame: HTMLCanvasElement, hint = 0): StitchStatus {
    const w = frame.width;
    const h = frame.height;
    const sig = signature(frame);

    if (!this.canvas || w !== this.fw || h !== this.fh) {
      this.fw = w;
      this.fh = h;
      this.used = 0;
      this.canvas = document.createElement('canvas');
      this.canvas.width = w;
      this.canvas.height = h * 4;
      this.blit(frame, 0, h);
      this.prev = sig;
      this.frames = 1;
      return 'init';
    }

    if (this.used >= LongShotStitcher.MAX_HEIGHT) return 'full';

    const s = findShift(this.prev!, sig, h, hint);
    if (s === 0) return 'nochange';

    this.prev = sig;
    this.frames++;
    if (s < 0) {
      this.blit(frame, 0, h);
      return 'seam';
    }
    this.blit(frame, h - s, s);
    return 'appended';
  }

  private blit(frame: HTMLCanvasElement, sy: number, sh: number) {
    let c = this.canvas!;
    if (this.used + sh > c.height) {
      const n = document.createElement('canvas');
      n.width = c.width;
      n.height = Math.max(c.height * 2, this.used + sh);
      n.getContext('2d')!.drawImage(c, 0, 0);
      this.canvas = n;
      c = n;
    }
    c.getContext('2d')!.drawImage(frame, 0, sy, this.fw, sh, 0, this.used, this.fw, sh);
    this.used += sh;
  }

  output(): HTMLCanvasElement {
    const out = document.createElement('canvas');
    out.width = Math.max(1, this.fw);
    out.height = Math.max(1, this.used);
    if (this.canvas) out.getContext('2d')!.drawImage(this.canvas, 0, 0);
    return out;
  }
}
