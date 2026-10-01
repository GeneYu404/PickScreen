import wallpaperUrl from '../assets/wallpaper.jpg';
import { APP_NAME, APP_DOMAIN } from '../brand';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface DetectRegion extends Rect {
  name: string;
}
export interface DesktopLayout {
  W: number;
  H: number;
  taskbar: Rect;
  browser: Rect;
  /** 浏览器网页内容视口（含滚动条） */
  content: Rect;
  notepad: Rect;
  trayIcon: Rect;
  iconApp: Rect;
  centerIcons: Rect[];
}

export const UI_FONT = '"Segoe UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif';
const MONO = 'Consolas, "Cascadia Mono", "Courier New", monospace';
const ARTICLE_W = 720;
const SCROLLBAR_W = 12;

/** 应用 Logo（与 MainWindow 中的 SVG 一致）：青蓝渐变圆角方块 + 取景角标 + 中心画面 */
export function drawAppLogo(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  const g = ctx.createLinearGradient(x, y, x + s, y + s);
  g.addColorStop(0, '#14b8a6');
  g.addColorStop(1, '#2563eb');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.roundRect(x, y, s, s, s * 0.26);
  ctx.fill();

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s / 32, s / 32);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(new Path2D('M9 13V10a1 1 0 0 1 1-1h3M19 9h3a1 1 0 0 1 1 1v3M23 19v3a1 1 0 0 1-1 1h-3M13 23h-3a1 1 0 0 1-1-1v-3'));
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.roundRect(13, 12.5, 6, 7, 1.5);
  ctx.fill();
  ctx.restore();
}

/**
 * 模拟的 Windows 11 桌面。
 * 全部绘制在一个 canvas 上，便于像真实屏幕一样被「截取」。
 */
export class Desktop {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  dpr = 1;
  width = 1;
  height = 1;
  private wallpaper: HTMLImageElement | null = null;
  private article: HTMLCanvasElement;
  private articleDpr = 1;
  private articleH = 1;
  /** 网页当前滚动位置（文章坐标，CSS px） */
  docScroll = 0;
  /** 真实屏幕模式下显示的截屏画面（原生 Tauri 下为 Rust 抓取的 ImageBitmap） */
  screenImage: HTMLImageElement | ImageBitmap | null = null;
  /**
   * 原生 Tauri 模式：
   * - 不绘制模拟桌面（空闲时画布保持完全透明，窗口才能真正「穿透」到真实桌面）
   * - nativeWindows 非空时用真实窗口矩形做识别
   * - eraseRect 非空时把该区域擦成透明（长截图期间露出正在滚动的真实内容）
   */
  native = false;
  nativeWindows: DetectRegion[] | null = null;
  eraseRect: Rect | null = null;
  private raf = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    this.dpr = window.devicePixelRatio || 1;
    this.articleDpr = this.dpr;
    this.article = buildArticle(this.dpr);
    this.articleH = this.article.height / this.dpr;
    const img = new Image();
    img.onload = () => {
      this.wallpaper = img;
      this.requestRender();
    };
    img.src = wallpaperUrl;
    this.resize();
  }

  /* ---------------- 尺寸与布局 ---------------- */

  resize() {
    this.dpr = window.devicePixelRatio || 1;
    if (this.dpr !== this.articleDpr) {
      this.articleDpr = this.dpr;
      this.article = buildArticle(this.dpr);
      this.articleH = this.article.height / this.dpr;
    }
    this.width = Math.max(320, window.innerWidth);
    this.height = Math.max(240, window.innerHeight);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.docScroll = Math.min(this.docScroll, this.maxScroll());
    this.render();
  }

  layout(): DesktopLayout {
    const W = this.width;
    const H = this.height;
    const taskbar = { x: 0, y: H - 48, w: W, h: 48 };
    const browser = {
      x: Math.round(Math.max(112, W * 0.06)),
      y: Math.round(H * 0.05),
      w: Math.round(Math.max(520, W * 0.58)),
      h: Math.round(H * 0.8),
    };
    const content = { x: browser.x, y: browser.y + 84, w: browser.w, h: browser.h - 84 };
    const notepad = {
      x: Math.round(W * 0.635),
      y: Math.round(H * 0.17),
      w: Math.round(W * 0.32),
      h: Math.round(H * 0.5),
    };
    const trayIcon = { x: W - 172, y: taskbar.y + 12, w: 24, h: 24 };
    const iconApp = { x: 20, y: 212, w: 80, h: 84 };
    const startX = W / 2 - (5 * 48) / 2;
    const centerIcons = Array.from({ length: 5 }, (_, i) => ({ x: startX + i * 48, y: taskbar.y + 4, w: 40, h: 40 }));
    return { W, H, taskbar, browser, content, notepad, trayIcon, iconApp, centerIcons };
  }

  /** 文章在视口中的缩放比例（窄窗口时缩小显示） */
  contentScale(L = this.layout()): number {
    return Math.min(1, (L.content.w - SCROLLBAR_W - 32) / ARTICLE_W);
  }

  private maxScroll(L = this.layout()): number {
    const visible = L.content.h / this.contentScale(L);
    return Math.max(0, this.articleH - visible);
  }

  /** 滚动网页内容。参数与返回值均为屏幕 CSS 像素；返回实际滚动量（到底返回 0） */
  scrollBy(dyScreen: number): number {
    if (this.screenImage) return 0;
    const L = this.layout();
    const scale = this.contentScale(L);
    const unit = 1 / (scale * this.dpr);
    const before = this.docScroll;
    const target = Math.max(0, Math.min(this.maxScroll(L), before + dyScreen / scale));
    this.docScroll = Math.round(target / unit) * unit;
    const moved = (this.docScroll - before) * scale;
    if (moved !== 0) this.render();
    return moved;
  }

  isScrollable(r: Rect): boolean {
    if (this.nativeWindows) return true; // 原生：由 Rust 代理滚动，能滚与否由滚动结果判定
    if (this.screenImage) return false;
    const c = this.layout().content;
    return r.x < c.x + c.w && r.x + r.w > c.x && r.y < c.y + c.h && r.y + r.h > c.y;
  }

  /** 可被自动识别的区域，按从小到大排列 */
  detectRegions(): DetectRegion[] {
    const L = this.layout();
    const full = { x: 0, y: 0, w: L.W, h: L.H, name: this.screenImage ? '全屏' : '桌面' };
    if (this.nativeWindows) {
      // 原生：Rust 返回的 Z 序窗口列表 + 兜底的「全屏」放在最后
      return [...this.nativeWindows, full];
    }
    if (this.screenImage) return [full];
    return [
      { ...L.content, w: L.content.w - SCROLLBAR_W, name: '网页内容' },
      { ...L.browser, name: 'Microsoft Edge' },
      { ...L.notepad, name: '记事本' },
      { ...L.taskbar, name: '任务栏' },
      full,
    ];
  }

  hitTest(x: number, y: number): DetectRegion {
    const regions = this.detectRegions();
    return regions.find((r) => x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h) ?? regions[regions.length - 1];
  }

  /* ---------------- 截取 ---------------- */

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

  setScreenImage(img: HTMLImageElement | ImageBitmap | null) {
    this.screenImage = img;
    this.render();
  }

  /** 长截图期间把选区擦成透明，让用户直接看到下方正在滚动的真实内容 */
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

  /* ---------------- 绘制 ---------------- */

  render() {
    const { ctx, width: W, height: H, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    if (this.native && !this.screenImage) {
      // 原生模式空闲态：整块画布保持透明，真实桌面从窗口后面透出来
      ctx.clearRect(0, 0, W, H);
      return;
    }

    if (this.screenImage) {
      const img = this.screenImage;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      const s = Math.min(W / img.width, H / img.height);
      const dw = img.width * s;
      const dh = img.height * s;
      ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
      // 长截图：选区透出实时画面（这一步是「抓帧不把自己拍进去」的关键）
      if (this.eraseRect) {
        const e = this.eraseRect;
        ctx.clearRect(e.x, e.y, e.w, e.h);
      }
      return;
    }

    const L = this.layout();
    this.drawWallpaper();
    this.drawDesktopIcons(L);
    this.drawNotepad(L.notepad);
    this.drawBrowser(L);
    this.drawTaskbar(L);
  }

  private text(s: string, x: number, y: number, font: string, color: string, align: CanvasTextAlign = 'left') {
    const { ctx } = this;
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillText(s, x, y);
    ctx.textAlign = 'left';
  }

  private drawWallpaper() {
    const { ctx, width: W, height: H } = this;
    const img = this.wallpaper;
    if (img) {
      const s = Math.max(W / img.width, H / img.height);
      const dw = img.width * s;
      const dh = img.height * s;
      ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
    } else {
      const g = ctx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, '#dbe9ff');
      g.addColorStop(0.5, '#9cc2ff');
      g.addColorStop(1, '#5b8def');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
  }

  private drawDesktopIcons(L: DesktopLayout) {
    const { ctx } = this;
    const items: { label: string; y: number; draw: (cx: number, cy: number) => void }[] = [
      {
        label: '此电脑',
        y: 20,
        draw: (cx, cy) => {
          ctx.fillStyle = '#dfe7f2';
          ctx.beginPath();
          ctx.roundRect(cx - 19, cy - 15, 38, 28, 3);
          ctx.fill();
          ctx.fillStyle = '#1e6fd9';
          ctx.fillRect(cx - 16, cy - 12, 32, 22);
          ctx.fillStyle = '#b9c4d3';
          ctx.fillRect(cx - 6, cy + 13, 12, 4);
          ctx.fillRect(cx - 13, cy + 17, 26, 3);
        },
      },
      {
        label: '回收站',
        y: 116,
        draw: (cx, cy) => {
          ctx.fillStyle = '#9fb3c8';
          ctx.beginPath();
          ctx.roundRect(cx - 12, cy - 9, 24, 27, 3);
          ctx.fill();
          ctx.fillStyle = '#c4d2e2';
          ctx.beginPath();
          ctx.roundRect(cx - 15, cy - 14, 30, 5, 2);
          ctx.fill();
          ctx.fillStyle = '#7f95ad';
          [-6, 0, 6].forEach((dx) => ctx.fillRect(cx + dx - 1, cy - 4, 2, 17));
        },
      },
      {
        label: APP_NAME,
        y: L.iconApp.y,
        draw: (cx, cy) => drawAppLogo(ctx, cx - 20, cy - 20, 40),
      },
    ];
    items.forEach((it) => {
      const cx = 20 + 40;
      const cy = it.y + 28;
      it.draw(cx, cy);
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.85)';
      ctx.shadowBlur = 4;
      this.text(it.label, cx, it.y + 66, `12px ${UI_FONT}`, '#fff', 'center');
      ctx.restore();
    });
  }

  private frame(r: Rect, radius = 8) {
    const { ctx } = this;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.3)';
    ctx.shadowBlur = 30;
    ctx.shadowOffsetY = 10;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.roundRect(r.x, r.y, r.w, r.h, radius);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = 'rgba(0,0,0,0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, radius);
    ctx.stroke();
  }

  private controls(right: number, y: number) {
    const { ctx } = this;
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    const xs = [right - 115, right - 69, right - 23];
    ctx.beginPath();
    ctx.moveTo(xs[0] - 5, y + 0.5);
    ctx.lineTo(xs[0] + 5, y + 0.5);
    ctx.stroke();
    ctx.strokeRect(xs[1] - 4.5, y - 4.5, 9, 9);
    ctx.beginPath();
    ctx.moveTo(xs[2] - 4.5, y - 4.5);
    ctx.lineTo(xs[2] + 4.5, y + 4.5);
    ctx.moveTo(xs[2] + 4.5, y - 4.5);
    ctx.lineTo(xs[2] - 4.5, y + 4.5);
    ctx.stroke();
  }

  private drawNotepad(r: Rect) {
    const { ctx } = this;
    this.frame(r);
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(r.x, r.y, r.w, r.h, 8);
    ctx.clip();
    // 标题栏
    ctx.fillStyle = '#1e6fd9';
    ctx.beginPath();
    ctx.roundRect(r.x + 14, r.y + 10, 14, 16, 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    [0, 1, 2].forEach((i) => ctx.fillRect(r.x + 17, r.y + 14 + i * 4, 8, 1.5));
    this.text('备忘录.txt - 记事本', r.x + 38, r.y + 18, `12px ${UI_FONT}`, '#1a1a1a');
    this.controls(r.x + r.w, r.y + 18);
    // 菜单栏
    ['文件', '编辑', '查看'].forEach((m, i) => this.text(m, r.x + 16 + i * 44, r.y + 50, `13px ${UI_FONT}`, '#1a1a1a'));
    ctx.fillStyle = '#e5e5e5';
    ctx.fillRect(r.x, r.y + 66, r.w, 1);
    // 正文
    const lines = [
      `${APP_NAME} 使用备忘`,
      '',
      '截图：Ctrl + 1',
      '贴图：Ctrl + 2',
      '长截图：Ctrl + 3',
      '',
      '双击选区 = 复制到剪贴板',
      'Enter 完成 / Esc 取消',
      '',
      '长截图注意事项：',
      ' - 选区尽量大',
      ' - 不要包含滚动条',
      ' - 滚动不要过快',
    ];
    lines.forEach((l, i) => this.text(l, r.x + 18, r.y + 90 + i * 24, `14px ${MONO}`, '#222'));
    // 状态栏
    ctx.fillStyle = '#f3f3f3';
    ctx.fillRect(r.x, r.y + r.h - 24, r.w, 24);
    this.text('行 1，列 1', r.x + 16, r.y + r.h - 12, `11px ${UI_FONT}`, '#555');
    this.text('100%    Windows (CRLF)    UTF-8', r.x + r.w - 16, r.y + r.h - 12, `11px ${UI_FONT}`, '#555', 'right');
    ctx.restore();
  }

  private drawBrowser(L: DesktopLayout) {
    const { ctx, dpr } = this;
    const r = L.browser;
    this.frame(r);
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(r.x, r.y, r.w, r.h, 8);
    ctx.clip();

    // 标签栏
    ctx.fillStyle = '#dfe4ec';
    ctx.fillRect(r.x, r.y, r.w, 40);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.roundRect(r.x + 10, r.y + 8, 236, 32, [8, 8, 0, 0]);
    ctx.fill();
    drawAppLogo(ctx, r.x + 20, r.y + 16, 16);
    this.text(`${APP_NAME} 长截图功能完全指南`, r.x + 42, r.y + 24, `12px ${UI_FONT}`, '#1a1a1a');
    this.text('✕', r.x + 226, r.y + 24, `11px ${UI_FONT}`, '#666');
    this.text('+', r.x + 262, r.y + 23, `18px ${UI_FONT}`, '#444');
    this.controls(r.x + r.w, r.y + 18);

    // 工具栏
    ctx.fillStyle = '#fff';
    ctx.fillRect(r.x, r.y + 40, r.w, 44);
    ['←', '→', '↻'].forEach((g, i) => this.text(g, r.x + 18 + i * 28, r.y + 62, `15px ${UI_FONT}`, i === 1 ? '#bbb' : '#444'));
    ctx.fillStyle = '#f1f3f6';
    ctx.beginPath();
    ctx.roundRect(r.x + 100, r.y + 48, r.w - 200, 28, 14);
    ctx.fill();
    // 锁图标
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 1.2;
    ctx.strokeRect(r.x + 116, r.y + 61, 8, 7);
    ctx.beginPath();
    ctx.arc(r.x + 120, r.y + 61, 3, Math.PI, 0);
    ctx.stroke();
    this.text(`${APP_DOMAIN}/docs/long-screenshot`, r.x + 132, r.y + 62, `12.5px ${UI_FONT}`, '#333');
    this.text('☆', r.x + r.w - 76, r.y + 62, `14px ${UI_FONT}`, '#555');
    this.text('…', r.x + r.w - 36, r.y + 60, `16px ${UI_FONT}`, '#555');
    ctx.fillStyle = '#e6e8ec';
    ctx.fillRect(r.x, r.y + 84, r.w, 1);

    // 网页内容
    const c = L.content;
    const scale = this.contentScale(L);
    const visibleH = c.h / scale;
    const sy = this.docScroll;
    const drawH = Math.min(visibleH, this.articleH - sy);
    const drawW = ARTICLE_W * scale;
    const dx = c.x + Math.max(0, (c.w - SCROLLBAR_W - drawW) / 2);
    ctx.fillStyle = '#fff';
    ctx.fillRect(c.x, c.y, c.w, c.h);
    ctx.save();
    ctx.beginPath();
    ctx.rect(c.x, c.y, c.w - SCROLLBAR_W, c.h);
    ctx.clip();
    ctx.drawImage(this.article, 0, sy * dpr, ARTICLE_W * dpr, drawH * dpr, dx, c.y, drawW, drawH * scale);
    ctx.restore();

    // 滚动条
    const trackX = c.x + c.w - SCROLLBAR_W;
    ctx.fillStyle = '#f1f1f1';
    ctx.fillRect(trackX, c.y, SCROLLBAR_W, c.h);
    const maxS = this.maxScroll(L);
    const thumbH = Math.max(30, c.h * (visibleH / this.articleH));
    const thumbY = c.y + (c.h - thumbH) * (maxS > 0 ? sy / maxS : 0);
    ctx.fillStyle = '#c1c1c1';
    ctx.beginPath();
    ctx.roundRect(trackX + 3, thumbY, 6, thumbH, 3);
    ctx.fill();
    ctx.restore();
  }

  private drawTaskbar(L: DesktopLayout) {
    const { ctx, width: W } = this;
    const t = L.taskbar;
    ctx.fillStyle = 'rgba(243,243,243,0.94)';
    ctx.fillRect(t.x, t.y, t.w, t.h);
    ctx.fillStyle = 'rgba(0,0,0,0.08)';
    ctx.fillRect(t.x, t.y, t.w, 1);

    L.centerIcons.forEach((r, i) => {
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      ctx.lineWidth = 1.6;
      switch (i) {
        case 0: {
          // Windows 徽标
          ctx.fillStyle = '#0a7ad8';
          [
            [-8, -8],
            [1, -8],
            [-8, 1],
            [1, 1],
          ].forEach(([dx, dy]) => ctx.fillRect(cx + dx, cy + dy, 7, 7));
          break;
        }
        case 1: {
          ctx.strokeStyle = '#1a1a1a';
          ctx.beginPath();
          ctx.arc(cx - 2, cy - 2, 6.5, 0, Math.PI * 2);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(cx + 3, cy + 3);
          ctx.lineTo(cx + 8, cy + 8);
          ctx.stroke();
          break;
        }
        case 2: {
          ctx.strokeStyle = '#1a1a1a';
          ctx.beginPath();
          ctx.roundRect(cx - 9, cy - 5, 13, 11, 2);
          ctx.stroke();
          ctx.fillStyle = '#f3f3f3';
          ctx.beginPath();
          ctx.roundRect(cx - 4, cy - 1, 13, 11, 2);
          ctx.fill();
          ctx.stroke();
          break;
        }
        case 3: {
          ctx.fillStyle = '#f2b632';
          ctx.beginPath();
          ctx.roundRect(cx - 10, cy - 8, 20, 16, 2);
          ctx.fill();
          ctx.fillStyle = '#ffd05b';
          ctx.beginPath();
          ctx.roundRect(cx - 10, cy - 4, 20, 12, 2);
          ctx.fill();
          break;
        }
        case 4: {
          const g = ctx.createLinearGradient(cx - 10, cy - 10, cx + 10, cy + 10);
          g.addColorStop(0, '#35c7a2');
          g.addColorStop(1, '#1b6fd6');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(cx, cy, 10, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,0.9)';
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.arc(cx, cy + 1, 5, Math.PI * 0.15, Math.PI * 1.35);
          ctx.stroke();
          break;
        }
      }
      if (i === 4) {
        ctx.fillStyle = '#0a7ad8';
        ctx.beginPath();
        ctx.roundRect(cx - 8, t.y + t.h - 4, 16, 3, 1.5);
        ctx.fill();
      }
    });

    // 托盘
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(W - 214, t.y + 27);
    ctx.lineTo(W - 209, t.y + 22);
    ctx.lineTo(W - 204, t.y + 27);
    ctx.stroke();
    drawAppLogo(ctx, L.trayIcon.x + 3, L.trayIcon.y + 3, 18);
    // Wi-Fi
    for (let k = 1; k <= 3; k++) {
      ctx.beginPath();
      ctx.arc(W - 127, t.y + 30, k * 4, Math.PI * 1.25, Math.PI * 1.75);
      ctx.stroke();
    }
    // 音量
    ctx.fillStyle = '#333';
    ctx.beginPath();
    ctx.moveTo(W - 108, t.y + 21);
    ctx.lineTo(W - 108, t.y + 27);
    ctx.lineTo(W - 105, t.y + 27);
    ctx.lineTo(W - 100, t.y + 31);
    ctx.lineTo(W - 100, t.y + 17);
    ctx.lineTo(W - 105, t.y + 21);
    ctx.closePath();
    ctx.fill();
    // 电池
    ctx.strokeRect(W - 88.5, t.y + 19.5, 16, 9);
    ctx.fillRect(W - 72, t.y + 22, 2, 4);
    ctx.fillRect(W - 87, t.y + 21, 11, 6);
    // 时钟
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    this.text(`${pad(now.getHours())}:${pad(now.getMinutes())}`, W - 14, t.y + 17, `12px ${UI_FONT}`, '#1a1a1a', 'right');
    this.text(`${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}`, W - 14, t.y + 33, `12px ${UI_FONT}`, '#1a1a1a', 'right');
  }
}

/* ======================= 长文章内容（长截图演示用） ======================= */

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const ch of text) {
    const test = line + ch;
    if (ctx.measureText(test).width > maxW && line) {
      lines.push(line);
      line = ch;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function buildArticle(dpr: number): HTMLCanvasElement {
  const W = ARTICLE_W;
  const MAXH = 7000;
  const tmp = document.createElement('canvas');
  tmp.width = W * dpr;
  tmp.height = MAXH * dpr;
  const ctx = tmp.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, MAXH);
  ctx.textBaseline = 'alphabetic';
  let y = 40;

  const para = (
    text: string,
    o: { font?: string; color?: string; lh?: number; x?: number; after?: number; align?: CanvasTextAlign } = {}
  ) => {
    const { font = `15px ${UI_FONT}`, color = '#333', lh = 27, x = 0, after = 14, align = 'left' } = o;
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    for (const line of wrap(ctx, text, W - x)) {
      y += lh;
      ctx.fillText(line, align === 'center' ? W / 2 : x, y);
    }
    ctx.textAlign = 'left';
    y += after;
  };
  const h2 = (t: string) => {
    y += 12;
    para(t, { font: `700 21px ${UI_FONT}`, color: '#111', lh: 30, after: 6 });
  };
  const list = (items: string[], ordered: boolean) =>
    items.forEach((it, i) => {
      ctx.font = `${ordered ? '600 ' : ''}15px ${UI_FONT}`;
      ctx.fillStyle = '#2b6cf0';
      ctx.fillText(ordered ? `${i + 1}.` : '•', 8, y + 27);
      para(it, { x: 32, after: 4 });
    });
  const tip = (text: string) => {
    y += 6;
    ctx.font = `14px ${UI_FONT}`;
    const lines = wrap(ctx, text, W - 40);
    const bh = lines.length * 24 + 22;
    ctx.fillStyle = '#eef4ff';
    ctx.beginPath();
    ctx.roundRect(0, y, W, bh, 8);
    ctx.fill();
    ctx.fillStyle = '#2b6cf0';
    ctx.fillRect(0, y, 4, bh);
    ctx.fillStyle = '#2a4a8a';
    lines.forEach((l, i) => ctx.fillText(l, 20, y + 28 + i * 24));
    y += bh + 16;
  };
  const figure = (h: number, caption: string) => {
    y += 6;
    const g = ctx.createLinearGradient(0, y, W, y + h);
    g.addColorStop(0, '#dbe7ff');
    g.addColorStop(1, '#ece4ff');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.roundRect(0, y, W, h, 10);
    ctx.fill();
    const fw = 250;
    const fh = 64;
    const cx = 60;
    [0, 1, 2].forEach((i) => {
      const fy = y + 26 + i * 44;
      ctx.fillStyle = 'rgba(255,255,255,0.94)';
      ctx.strokeStyle = '#8fb0ff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(cx + i * 8, fy, fw, fh, 6);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#c7d6f7';
      for (let k = 0; k < 3; k++) ctx.fillRect(cx + i * 8 + 14, fy + 14 + k * 14, fw - 28 - (k === 2 ? 90 : 0), 6);
    });
    ctx.strokeStyle = '#2b6cf0';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx + fw + 44, y + h / 2);
    ctx.lineTo(cx + fw + 96, y + h / 2);
    ctx.stroke();
    ctx.fillStyle = '#2b6cf0';
    ctx.beginPath();
    ctx.moveTo(cx + fw + 104, y + h / 2);
    ctx.lineTo(cx + fw + 94, y + h / 2 - 6);
    ctx.lineTo(cx + fw + 94, y + h / 2 + 6);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#2b6cf0';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(cx + fw + 130, y + 16, 130, h - 32, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#c7d6f7';
    for (let k = 0; k < 9; k++) ctx.fillRect(cx + fw + 144, y + 30 + k * 18, 102 - (k % 3 === 2 ? 40 : 0), 6);
    y += h + 4;
    para(caption, { font: `13px ${UI_FONT}`, color: '#777', lh: 22, after: 10, align: 'center' });
  };
  const table = (head: string[], rows: string[][]) => {
    const cols = [150, 250, W - 400];
    const pad = 12;
    y += 6;
    const drawRow = (cells: string[], isHead: boolean) => {
      ctx.font = isHead ? `600 14px ${UI_FONT}` : `14px ${UI_FONT}`;
      const wrapped = cells.map((c, i) => wrap(ctx, c, cols[i] - pad * 2));
      const rh = Math.max(...wrapped.map((l) => l.length)) * 22 + 16;
      ctx.fillStyle = isHead ? '#f3f5f9' : '#fff';
      ctx.fillRect(0, y, W, rh);
      ctx.strokeStyle = '#e3e6eb';
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, y + 0.5, W - 1, rh);
      let x = 0;
      wrapped.forEach((lines, i) => {
        ctx.fillStyle = isHead ? '#111' : '#333';
        lines.forEach((l, k) => ctx.fillText(l, x + pad, y + 25 + k * 22));
        x += cols[i];
        if (i < cols.length - 1) {
          ctx.beginPath();
          ctx.moveTo(x + 0.5, y);
          ctx.lineTo(x + 0.5, y + rh);
          ctx.stroke();
        }
      });
      y += rh;
    };
    drawRow(head, true);
    rows.forEach((r) => drawRow(r, false));
    y += 18;
  };
  const code = (lines: string[]) => {
    y += 6;
    const lh = 22;
    const bh = lines.length * lh + 28;
    ctx.fillStyle = '#1e1e2e';
    ctx.beginPath();
    ctx.roundRect(0, y, W, bh, 8);
    ctx.fill();
    ctx.font = `13px ${MONO}`;
    lines.forEach((l, i) => {
      ctx.fillStyle = l.trim().startsWith('//') ? '#7f849c' : '#cdd6f4';
      ctx.fillText(l, 18, y + 30 + i * lh);
    });
    y += bh + 18;
  };

  /* ---- 正文 ---- */
  para('文档  ›  功能指南  ›  长截图', { font: `13px ${UI_FONT}`, color: '#888', lh: 18, after: 10 });
  para(`${APP_NAME} 长截图功能完全指南`, { font: `700 30px ${UI_FONT}`, color: '#111', lh: 40, after: 6 });
  para(`${APP_NAME}团队 · 更新于 2026-01-12 · 阅读约 6 分钟`, { font: `13px ${UI_FONT}`, color: '#888', lh: 20, after: 8 });
  ctx.fillStyle = '#eee';
  ctx.fillRect(0, y, W, 1);
  y += 10;

  para(
    '当需要记录的内容超出了一屏范围——比如一段很长的聊天记录、一篇公众号文章、一张跨越多页的数据表格，或者几百行代码——普通截图就显得力不从心。拾屏的长截图功能通过智能的图像拼接算法，把滚动过程中的多帧画面无缝合成一张完整的长图。'
  );

  h2('一、长截图是如何工作的');
  para(
    '长截图并不依赖滚动条的位置信息，而是使用内容识别算法：每当选区内的画面发生滚动，拾屏会截取一帧新画面，并与上一帧进行特征比对，计算出两帧之间的偏移量，然后把新出现的部分追加到长图的末尾。这意味着它几乎可以在任何软件中工作——浏览器、微信、Word、PDF 阅读器、IDE，都不需要特别适配。'
  );
  figure(200, '图 1：多帧画面按重叠区域对齐后，拼接为一张完整的长图');

  h2('二、使用步骤');
  list(
    [
      '按下截图快捷键 Ctrl + 1 进入截图界面；',
      '框选需要滚动截取的区域，尽量让选区覆盖完整的内容区域；',
      '点击工具栏中的「长截图」图标进入长截图模式；',
      '在选区内滚动鼠标滚轮（或开启自动滚动），拾屏会实时拼接并在侧边显示预览；',
      '滚动到需要的位置后点击「完成」，长图会自动复制到剪贴板或以贴图形式显示。',
    ],
    true
  );
  tip('提示：默认快捷键为 截图 Ctrl+1、贴图 Ctrl+2、长截图 Ctrl+3，均可在「配置 - 快捷键/动作」中自定义。');

  h2('三、获得更好拼接效果的建议');
  list(
    [
      '选区尽可能大，为算法提供更多可供比对的内容；',
      '滚动过程尽量平缓、不要过快，每次滚动的距离不要超过选区高度的三分之二；',
      '选区内最好只包含一个主要的滚动区域，避免多个可滚动区域同时进入选区；',
      '尽量避开固定不动的元素（如吸顶导航栏、悬浮按钮、滚动条），它们会干扰偏移量的计算；',
      '内容最好是静态的，包含动图、视频或闪烁光标的区域可能导致拼接错位。',
    ],
    false
  );

  h2('四、常见问题');
  table(
    ['问题', '可能原因', '解决方法'],
    [
      ['拼接出现重复内容', '滚动幅度过小或页面有回弹动画', '适当加大每次滚动距离，等待画面稳定后再继续'],
      ['拼接出现错位或缺失', '滚动过快，两帧之间没有重叠区域', '放慢滚动速度，或改用自动滚动'],
      ['长图底部被截断', '内容已到底部但未点击完成', '看到「已到达底部」提示后点击完成'],
      ['固定表头重复出现', '选区包含吸顶元素', '调整选区，避开固定不动的区域'],
    ]
  );

  h2('五、开发者视角：核心算法示意');
  code([
    '// 计算两帧之间的垂直偏移量',
    'function findOffset(prev: Frame, next: Frame): number {',
    '  let best = { shift: 0, cost: Infinity };',
    '  for (let s = 1; s < prev.height - MIN_OVERLAP; s++) {',
    '    const cost = rowDiff(prev, next, s);   // 逐行灰度差',
    '    if (cost < best.cost) best = { shift: s, cost };',
    '  }',
    '  return best.cost < THRESHOLD ? best.shift : -1;',
    '}',
  ]);
  para(
    '在真实实现中，我们还会对图像进行降采样与灰度化以提高比对速度，并使用截尾均值来忽略少量不匹配的行（例如固定表头或闪烁的光标），从而在保证速度的同时获得稳定的拼接结果。'
  );

  h2('六、下一步');
  para(
    '长截图完成后，你可以直接使用拾屏的标注工具在长图上添加箭头、文字与马赛克，也可以把它作为贴图钉在屏幕上随时参考。更多功能请查阅「贴图」与「标注」章节。'
  );

  y += 10;
  ctx.fillStyle = '#eee';
  ctx.fillRect(0, y, W, 1);
  y += 6;
  para('— 本文完 —', { font: `14px ${UI_FONT}`, color: '#999', lh: 30, after: 0, align: 'center' });
  para(`© ${APP_NAME} 文档 · 本页面为浏览器预览环境内置的演示内容`, { font: `12px ${UI_FONT}`, color: '#aaa', lh: 22, after: 0, align: 'center' });
  y += 40;

  const out = document.createElement('canvas');
  out.width = W * dpr;
  out.height = Math.ceil(y * dpr);
  out.getContext('2d')!.drawImage(tmp, 0, 0);
  return out;
}
