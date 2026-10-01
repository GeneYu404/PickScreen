import type { Rect } from '../sim/desktop';
import { UI_FONT } from '../sim/desktop';

export type ToolId = 'rect' | 'ellipse' | 'arrow' | 'pen' | 'marker' | 'text' | 'number' | 'mosaic';

export interface Annotation {
  id: string;
  tool: ToolId;
  color: string;
  size: 1 | 2 | 3;
  /** 屏幕 CSS 像素坐标 */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  points?: { x: number; y: number }[];
  text?: string;
  n?: number;
}

export const COLORS = ['#e5312b', '#ff8c00', '#ffd400', '#22c55e', '#2b6cf0', '#a855f7', '#111111', '#ffffff'];
export const STROKE: Record<1 | 2 | 3, number> = { 1: 2, 2: 4, 3: 7 };
export const FONT_SIZE: Record<1 | 2 | 3, number> = { 1: 15, 2: 20, 3: 28 };

/** 取得某个屏幕区域的原始像素（用于马赛克） */
export type Sampler = (r: Rect) => HTMLCanvasElement;

function polyline(ctx: CanvasRenderingContext2D, pts?: { x: number; y: number }[]) {
  if (!pts || pts.length === 0) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  if (pts.length === 1) ctx.lineTo(pts[0].x + 0.1, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
}

function arrow(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, lw: number) {
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const head = Math.max(12, lw * 3.5);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2 - Math.cos(ang) * head * 0.6, y2 - Math.sin(ang) * head * 0.6);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * Math.cos(ang - Math.PI / 7), y2 - head * Math.sin(ang - Math.PI / 7));
  ctx.lineTo(x2 - head * Math.cos(ang + Math.PI / 7), y2 - head * Math.sin(ang + Math.PI / 7));
  ctx.closePath();
  ctx.fill();
}

export function drawAnnotation(ctx: CanvasRenderingContext2D, a: Annotation, sample: Sampler) {
  ctx.save();
  const lw = STROKE[a.size];
  ctx.strokeStyle = a.color;
  ctx.fillStyle = a.color;
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const x = Math.min(a.x1, a.x2);
  const y = Math.min(a.y1, a.y2);
  const w = Math.abs(a.x2 - a.x1);
  const h = Math.abs(a.y2 - a.y1);

  switch (a.tool) {
    case 'rect':
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 2);
      ctx.stroke();
      break;

    case 'ellipse':
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + h / 2, Math.max(1, w / 2), Math.max(1, h / 2), 0, 0, Math.PI * 2);
      ctx.stroke();
      break;

    case 'arrow':
      arrow(ctx, a.x1, a.y1, a.x2, a.y2, lw);
      break;

    case 'pen':
      polyline(ctx, a.points);
      break;

    case 'marker':
      ctx.globalAlpha = 0.4;
      ctx.globalCompositeOperation = 'multiply';
      ctx.lineWidth = lw * 4;
      polyline(ctx, a.points);
      break;

    case 'text': {
      const fs = FONT_SIZE[a.size];
      ctx.font = `600 ${fs}px ${UI_FONT}`;
      ctx.textBaseline = 'top';
      ctx.lineJoin = 'round';
      (a.text || '').split('\n').forEach((line, i) => {
        const ty = a.y1 + i * fs * 1.3;
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.strokeText(line, a.x1, ty);
        ctx.fillText(line, a.x1, ty);
      });
      break;
    }

    case 'number': {
      const r = 10 + a.size * 3;
      ctx.beginPath();
      ctx.arc(a.x1, a.y1, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.fillStyle = a.color === '#ffffff' ? '#111' : '#fff';
      ctx.font = `700 ${Math.round(r * 1.1)}px ${UI_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(a.n ?? 1), a.x1, a.y1 + 1);
      break;
    }

    case 'mosaic': {
      if (w < 2 || h < 2) break;
      const block = 6 + a.size * 4;
      const src = sample({ x, y, w, h });
      const small = document.createElement('canvas');
      small.width = Math.max(1, Math.round(w / block));
      small.height = Math.max(1, Math.round(h / block));
      small.getContext('2d')!.drawImage(src, 0, 0, small.width, small.height);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(small, x, y, w, h);
      break;
    }
  }
  ctx.restore();
}
