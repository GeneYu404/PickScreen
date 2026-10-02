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
  /** CSS px → canvas 像素 的**真实**换算比。有帧时 = 帧物理尺寸 ÷ 视口 CSS 尺寸。 */
  private pxScaleX = 1;
  private pxScaleY = 1;
  width = 1;
  height = 1;
  /** Rust 抓取的整屏帧；null = 空闲态（画布透明，让真实桌面透出来） */
  private frame: ImageBitmap | null = null;
  /** Rust `list_windows` 返回的真实窗口矩形，已换算为 CSS px、按 Z 序 */
  private windows: DetectRegion[] = [];
  /** 长截图期间要擦成透明的选区，露出下方正在滚动的真实内容 */
  private eraseRect: Rect | null = null;
  private raf = 0;

  /**
   * CSS px → 输出画布像素 的换算比。
   *
   * 名字沿用 `dpr` 以保持 API 兼容，但**语义变了**：不再是
   * `window.devicePixelRatio`（那只是**主屏**的缩放比），而是本画布真实的
   * 「物理像素 ÷ CSS 像素」。
   *
   * 为什么要换：覆盖层窗口铺满整块虚拟桌面，多屏混合缩放下它需要的有效比例是
   * 「虚拟桌面物理宽 ÷ 虚拟桌面 CSS 宽」，与主屏的 `devicePixelRatio` **并不相等**。
   * 用后者算画布尺寸，图像就被拉伸；窗口视口一变（show 后 WebView2 才定下视口）
   * `resize()` 重算 → 图像按新比例重新绘制 → 用户看到「画面突然缩放了一下」。
   * 外部 `captureRegion` / `getPixel` / 标注 `setTransform` 都用它，保持统一口径。
   */
  get dpr(): number {
    return this.pxScaleX;
  }
  /** 纵轴换算比；与 x 不同仅在混合缩放下发生 */
  get dprY(): number {
    return this.pxScaleY;
  }

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    this.resize();
  }

  /* ---------------- 尺寸 ---------------- */

  resize() {
    // CSS 尺寸始终跟随视口（窗口铺满虚拟桌面，视口就是整块桌面）。
    this.width = Math.max(320, window.innerWidth);
    this.height = Math.max(240, window.innerHeight);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    // backing store（像素尺寸）**在有帧时锁定为帧的真实物理尺寸**，不随视口重算。
    // 这是消除「缩放跳变」的关键：视口变化只改 CSS 尺寸，由浏览器负责平滑缩放，
    // 图像内容始终是 1:1 像素，不会被重新拉伸绘制。
    if (this.frame) {
      this.canvas.width = this.frame.width;
      this.canvas.height = this.frame.height;
    } else {
      const d = window.devicePixelRatio || 1;
      this.canvas.width = Math.round(this.width * d);
      this.canvas.height = Math.round(this.height * d);
    }
    this.syncScale();
    this.render();
  }

  private syncScale() {
    this.pxScaleX = this.canvas.width / this.width;
    this.pxScaleY = this.canvas.height / this.height;
  }

  /* ---------------- 输入 ---------------- */

  /** 送入 Rust 抓取的整屏帧；传 null 回到空闲态 */
  setScreenImage(frame: ImageBitmap | null) {
    this.frame = frame;
    if (frame) {
      // 帧的物理尺寸就是权威值：1:1 像素，不掺 devicePixelRatio 推算。
      this.canvas.width = frame.width;
      this.canvas.height = frame.height;
      this.syncScale();
    }
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
    // 源与目标必须用**同一个**换算比，否则裁出来的区域会偏移/缩放。
    const sx = Math.round(r.x * this.pxScaleX);
    const sy = Math.round(r.y * this.pxScaleY);
    out.width = Math.max(1, Math.round(r.w * this.pxScaleX));
    out.height = Math.max(1, Math.round(r.h * this.pxScaleY));
    out.getContext('2d')!.drawImage(this.canvas, sx, sy, out.width, out.height, 0, 0, out.width, out.height);
    return out;
  }

  getPixel(x: number, y: number): [number, number, number] {
    const px = Math.max(0, Math.min(this.canvas.width - 1, Math.round(x * this.pxScaleX)));
    const py = Math.max(0, Math.min(this.canvas.height - 1, Math.round(y * this.pxScaleY)));
    const d = this.ctx.getImageData(px, py, 1, 1).data;
    return [d[0], d[1], d[2]];
  }

  /* ---------------- 绘制 ---------------- */

  render() {
    const { ctx, canvas } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    if (!this.frame) {
      // 空闲态：整块画布保持透明，真实桌面从窗口后面透出来（鼠标穿透的前提）
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    // 帧按 1:1 物理像素画进 backing store —— 不做任何缩放。
    // 缩放交给浏览器的 CSS 尺寸去处理：视口变化时只是采样密度变化，
    // 图像内容比例恒定，也就不会出现「缩放跳一下」。
    ctx.drawImage(this.frame, 0, 0, canvas.width, canvas.height);

    // 切回 CSS 坐标系，供遮罩 / 选框 / 擦除矩形用（它们都以 CSS px 表述）
    ctx.setTransform(this.pxScaleX, 0, 0, this.pxScaleY, 0, 0);

    // 长截图：选区透出实时画面（这是「抓帧不把自己拍进去」的关键）
    if (this.eraseRect) {
      const e = this.eraseRect;
      ctx.clearRect(e.x, e.y, e.w, e.h);
    }
  }
}
