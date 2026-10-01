/**
 * 屏幕帧桥 —— 薄壳，与 lumina 的 `src/desktop.ts` 同一思路：
 * webview 只负责渲染 UI，**不模拟操作系统**。
 *
 * 抓屏 / 窗口枚举 / 滚轮代理 / 长截图拼接全部由 Rust 完成（见 `bridge/tauri.ts`），
 * 本模块只做两件纯前端的事：
 *   1. 把 Rust 抓回的整屏帧画到画布上，供用户框选
 *   2. 对这一帧做纯 canvas 运算（裁剪取色 / 读像素），供标注与长截图使用
 *
 * 浏览器预览下不会有人调 `setScreenImage`，画布恒为透明，
 * `detectRegions()` 退化成「全屏」——不需要 `isTauriEnv()` 分支。
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DetectRegion extends Rect {
  name: string;
}

export class ScreenFrame {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  dpr = 1;
  width = 1;
  height = 1;
  /** Rust 抓取的整屏帧；null = 空闲态（画布透明，让真实桌面透出来） */
  private frame: ImageBitmap | null = null;
  /** Rust `list_windows` 返回的真实窗口矩形，已换算为 CSS px、按 Z 序 */
  private windows: DetectRegion[] = [];
  /** 长截图期间要擦成透明的选区，露出下方正在滚动的真实内容 */
  private eraseRect: Rect | null = null;
  private raf = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    this.resize();
  }

  /* ---------------- 尺寸 ---------------- */

  resize() {
    this.dpr = window.devicePixelRatio || 1;
    this.width = Math.max(320, window.innerWidth);
    this.height = Math.max(240, window.innerHeight);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.render();
  }

  /* ---------------- 输入 ---------------- */

  /** 送入 Rust 抓取的整屏帧；传 null 回到空闲态 */
  setScreenImage(frame: ImageBitmap | null) {
    this.frame = frame;
    this.render();
  }

  /** 送入 Rust 枚举到的真实窗口矩形（用于自动识别窗口） */
  setWindows(windows: DetectRegion[]) {
    this.windows = windows;
  }

  /** 长截图期间把选区擦成透明 */
  setEraseRect(r: Rect | null) {
    this.eraseRect = r;
    this.render();
  }

  requestRender() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  /* ---------------- 窗口识别 ---------------- */

  /** 可被识别的区域，按 Z 序从小到大；末尾永远是「全屏」兜底 */
  detectRegions(): DetectRegion[] {
    const full: DetectRegion = { x: 0, y: 0, w: this.width, h: this.height, name: '全屏' };
    return this.windows.length ? [...this.windows, full] : [full];
  }

  hitTest(x: number, y: number): DetectRegion {
    const regions = this.detectRegions();
    return regions.find((r) => x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h) ?? regions[regions.length - 1];
  }

  /* ---------------- 取帧 / 取色 ---------------- */

  /** 截取屏幕区域（CSS px），返回设备像素尺寸的画布 */
  captureRegion(r: Rect): HTMLCanvasElement {
    const out = document.createElement('canvas');
    const sx = Math.round(r.x * this.dpr);
    const sy = Math.round(r.y * this.dpr);
    out.width = Math.max(1, Math.round(r.w * this.dpr));
    out.height = Math.max(1, Math.round(r.h * this.dpr));
    out.getContext('2d')!.drawImage(this.canvas, sx, sy, out.width, out.height, 0, 0, out.width, out.height);
    return out;
  }

  getPixel(x: number, y: number): [number, number, number] {
    const px = Math.max(0, Math.min(this.canvas.width - 1, Math.round(x * this.dpr)));
    const py = Math.max(0, Math.min(this.canvas.height - 1, Math.round(y * this.dpr)));
    const d = this.ctx.getImageData(px, py, 1, 1).data;
    return [d[0], d[1], d[2]];
  }

  /* ---------------- 绘制 ---------------- */

  render() {
    const { ctx, width: W, height: H, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (!this.frame) {
      // 空闲态：整块画布保持透明，真实桌面从窗口后面透出来（鼠标穿透的前提）
      ctx.clearRect(0, 0, W, H);
      return;
    }

    const img = this.frame;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const s = Math.min(W / img.width, H / img.height);
    const dw = img.width * s;
    const dh = img.height * s;
    ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);

    // 长截图：选区透出实时画面（这是「抓帧不把自己拍进去」的关键）
    if (this.eraseRect) {
      const e = this.eraseRect;
      ctx.clearRect(e.x, e.y, e.w, e.h);
    }
  }
}
