import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Square,
  Circle,
  MoveUpRight,
  Pencil,
  Highlighter,
  Type,
  LayoutGrid,
  Undo2,
  Redo2,
  Pin,
  X,
  Download,
  Copy,
  Check,
  ScrollText,
  Play,
  Pause,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ScreenFrame, Rect, DetectRegion } from '../bridge/desktop';
import { COLORS, drawAnnotation } from '../utils/annotations';
import type { Annotation, ToolId } from '../utils/annotations';
import type { Settings, OverlayAction } from '../types';
import { comboMatches } from '../utils/hotkey';
import { NativeBridge } from '../bridge/tauri';
import { Sep } from './ui/Button';

/** 与 Rust 侧 `long_*` 命令返回的 status 取值保持一致 */
type StitchStatus = 'init' | 'appended' | 'nochange' | 'seam' | 'full';

export interface OverlayResult {
  canvas: HTMLCanvasElement;
  kind: 'shot' | 'long';
  action: 'done' | 'copy' | 'save' | 'pin';
}

interface Props {
  desktop: ScreenFrame;
  mode: 'shot' | 'long';
  settings: Settings;
  allowLong: boolean;
  onClose: () => void;
  onResult: (r: OverlayResult) => void;
  onToast: (msg: string) => void;
}

type Phase = 'pick' | 'selected' | 'long';
type DragKind = 'none' | 'new' | 'move' | 'resize' | 'draw';
interface DragState {
  kind: DragKind;
  sx: number;
  sy: number;
  orig: Rect | null;
  handle: string;
  moved: boolean;
}
type LongStatus = StitchStatus | 'noscroll' | 'bottom';

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const HANDLE_CURSOR: Record<string, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
};
const TOOLS: { id: ToolId; icon: LucideIcon; label: string }[] = [
  { id: 'rect', icon: Square, label: '矩形' },
  { id: 'ellipse', icon: Circle, label: '椭圆' },
  { id: 'arrow', icon: MoveUpRight, label: '箭头' },
  { id: 'pen', icon: Pencil, label: '画笔' },
  { id: 'marker', icon: Highlighter, label: '马克笔' },
  { id: 'text', icon: Type, label: '文字' },
  { id: 'mosaic', icon: LayoutGrid, label: '马赛克' },
];
const ACCENT = '#2b6cf0';
/** 屏幕空间：准线与 ACCENT 同源但半透明，始终压在真实屏幕像素上 */
const ACCENT_SOFT = 'rgba(43,108,240,0.85)';
const TB_H = 40;
const SUB_H = 36;
const PANEL_W = 236;

const uid = () => Math.random().toString(36).slice(2, 9);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const norm = (x1: number, y1: number, x2: number, y2: number): Rect => ({
  x: Math.min(x1, x2),
  y: Math.min(y1, y2),
  w: Math.abs(x2 - x1),
  h: Math.abs(y2 - y1),
});
const clampRect = (r: Rect, W: number, H: number): Rect => {
  const x = Math.max(0, r.x);
  const y = Math.max(0, r.y);
  const x2 = Math.min(W, r.x + r.w);
  const y2 = Math.min(H, r.y + r.h);
  return { x, y, w: Math.max(0, x2 - x), h: Math.max(0, y2 - y) };
};
const inRect = (x: number, y: number, r: Rect) => x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h;
const resizeRect = (o: Rect, handle: string, dx: number, dy: number, W: number, H: number): Rect => {
  let x1 = o.x;
  let y1 = o.y;
  let x2 = o.x + o.w;
  let y2 = o.y + o.h;
  if (handle.includes('w')) x1 += dx;
  if (handle.includes('e')) x2 += dx;
  if (handle.includes('n')) y1 += dy;
  if (handle.includes('s')) y2 += dy;
  return clampRect(norm(x1, y1, x2, y2), W, H);
};
const toHex = (c: [number, number, number]) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();

/* ---------- 工具栏按钮 ---------- */
const TbBtn: React.FC<{
  active?: boolean;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ active, primary, danger, disabled, title, onClick, children }) => {
  let cls = 'tb-btn--default';
  if (active) cls = 'tb-btn--active';
  else if (primary) cls = 'tb-btn--primary';
  else if (danger) cls = 'tb-btn--danger';
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`tb-btn ${disabled ? 'tb-btn--disabled' : ''} ${cls}`}
    >
      {children}
    </button>
  );
};
export function ScreenshotOverlay({ desktop, mode, settings, allowLong, onClose, onResult, onToast }: Props) {
  const W = desktop.width;
  const H = desktop.height;
  const dpr = desktop.dpr;

  const [phase, setPhase] = useState<Phase>('pick');
  const [sel, setSel] = useState<Rect | null>(null);
  const [cursor, setCursor] = useState({ x: -100, y: -100 });
  const [detected, setDetected] = useState<DetectRegion | null>(null);
  const [dragKind, setDragKind] = useState<DragKind>('none');
  const [tool, setTool] = useState<ToolId | null>(null);
  const [color, setColor] = useState(COLORS[0]);
  const [size, setSize] = useState<1 | 2 | 3>(2);
  const [annos, setAnnos] = useState<Annotation[]>([]);
  const [redoStack, setRedoStack] = useState<Annotation[]>([]);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const [textEdit, setTextEdit] = useState<{ x: number; y: number } | null>(null);
  const [textVal, setTextVal] = useState('');
  const [tbW, setTbW] = useState(520);
  const [long, setLong] = useState<{ frames: number; w: number; h: number; status: LongStatus; auto: boolean }>({
    frames: 0,
    w: 0,
    h: 0,
    status: 'init',
    auto: false,
  });

  const drag = useRef<DragState>({ kind: 'none', sx: 0, sy: 0, orig: null, handle: '', moved: false });
  const annoCanvas = useRef<HTMLCanvasElement | null>(null);
  const magCanvas = useRef<HTMLCanvasElement | null>(null);
  const previewCanvas = useRef<HTMLCanvasElement | null>(null);
  const previewBox = useRef<HTMLDivElement | null>(null);
  const tbRef = useRef<HTMLDivElement | null>(null);
  const captureTimer = useRef(0);
  const lastCapture = useRef(0);
  const pendingHint = useRef(0);
  const longStarted = useRef(false);
  /** 长截图会话序号：取消 / 完成 / 关闭后，让仍在飞行中的异步请求作废 */
  const longEpoch = useRef(0);
  const selRef = useRef<Rect | null>(null);
  selRef.current = sel;

  /* ---------- 标注层绘制 ---------- */
  useEffect(() => {
    const c = annoCanvas.current;
    if (!c) return;
    const pw = Math.round(W * dpr);
    const ph = Math.round(H * dpr);
    if (c.width !== pw || c.height !== ph) {
      c.width = pw;
      c.height = ph;
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!sel) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(sel.x, sel.y, sel.w, sel.h);
    ctx.clip();
    const sampler = (r: Rect) => desktop.captureRegion(r);
    annos.forEach((a) => drawAnnotation(ctx, a, sampler));
    if (draft) drawAnnotation(ctx, draft, sampler);
    ctx.restore();
  }, [annos, draft, sel, W, H, dpr, desktop]);

  /* ---------- 放大镜 ---------- */
  const showMag = settings.showMagnifier && (phase === 'pick' || dragKind === 'new') && !textEdit;
  useEffect(() => {
    const c = magCanvas.current;
    if (!c || !showMag) return;
    const SZ = 140;
    const ZOOM = 10;
    const n = SZ / ZOOM;
    c.width = SZ * dpr;
    c.height = SZ * dpr;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, SZ, SZ);
    const sx = Math.round((cursor.x - n / 2) * dpr);
    const sy = Math.round((cursor.y - n / 2) * dpr);
    ctx.drawImage(desktop.canvas, sx, sy, Math.round(n * dpr), Math.round(n * dpr), 0, 0, SZ, SZ);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    for (let i = 1; i < n; i++) {
      const p = i * ZOOM + 0.5;
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, SZ);
      ctx.moveTo(0, p);
      ctx.lineTo(SZ, p);
      ctx.stroke();
    }
    const c0 = Math.floor(n / 2) * ZOOM;
    ctx.strokeStyle = 'rgba(43,108,240,0.55)';
    ctx.beginPath();
    ctx.moveTo(c0 + ZOOM / 2, 0);
    ctx.lineTo(c0 + ZOOM / 2, SZ);
    ctx.moveTo(0, c0 + ZOOM / 2);
    ctx.lineTo(SZ, c0 + ZOOM / 2);
    ctx.stroke();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(c0 + 0.75, c0 + 0.75, ZOOM - 1.5, ZOOM - 1.5);
  }, [cursor, showMag, dpr, desktop]);

  /* ---------- 工具栏宽度测量 ---------- */
  useLayoutEffect(() => {
    if (tbRef.current) setTbW(tbRef.current.offsetWidth);
  }, [phase, sel, allowLong]);

  /* ---------- 标注操作 ---------- */
  const pushAnno = useCallback((a: Annotation) => {
    setAnnos((prev) => [...prev, a]);
    setRedoStack([]);
  }, []);
  const undo = useCallback(() => {
    setAnnos((prev) => {
      if (!prev.length) return prev;
      const last = prev[prev.length - 1];
      setRedoStack((r) => [...r, last]);
      return prev.slice(0, -1);
    });
  }, []);
  const redo = useCallback(() => {
    setRedoStack((r) => {
      if (!r.length) return r;
      const last = r[r.length - 1];
      setAnnos((prev) => [...prev, last]);
      return r.slice(0, -1);
    });
  }, []);
  const commitText = useCallback(() => {
    if (textEdit && textVal.trim()) {
      pushAnno({ id: uid(), tool: 'text', color, size, x1: textEdit.x, y1: textEdit.y, x2: textEdit.x, y2: textEdit.y, text: textVal });
    }
    setTextEdit(null);
    setTextVal('');
  }, [textEdit, textVal, color, size, pushAnno]);

  /* ---------- 输出 ---------- */
  const buildOutput = useCallback(() => {
    const r = selRef.current!;
    const out = desktop.captureRegion(r);
    const ctx = out.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, -r.x * dpr, -r.y * dpr);
    const sampler = (rr: Rect) => desktop.captureRegion(rr);
    annos.forEach((a) => drawAnnotation(ctx, a, sampler));
    return out;
  }, [annos, desktop, dpr]);

  const finish = useCallback(
    (action: OverlayResult['action']) => {
      if (!selRef.current) return;
      onResult({ canvas: buildOutput(), kind: 'shot', action });
      onClose();
    },
    [buildOutput, onResult, onClose]
  );

  /* ---------- 长截图 ---------- */
  // 原生 Tauri：长截图的抓帧 / 拼接 / 滚动代理全部在 Rust 侧完成
  const drawPreview = useCallback(async () => {
    const c = previewCanvas.current;
    if (!c) return;
    // 预览图由 Rust 侧降采样后以 PNG 返回
    const url = await NativeBridge.longPreview();
    const img = new Image();
    img.onload = () => {
      const PW = PANEL_W - 32;
      const ph = Math.max(1, Math.round((img.height / Math.max(1, img.width)) * PW));
      c.width = Math.round(PW * dpr);
      c.height = Math.round(ph * dpr);
      c.style.width = `${PW}px`;
      c.style.height = `${ph}px`;
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      requestAnimationFrame(() => {
        if (previewBox.current) previewBox.current.scrollTop = previewBox.current.scrollHeight;
      });
    };
    img.src = url;
  }, [dpr]);

  const captureFrame = useCallback(async () => {
    const r = selRef.current;
    if (!r) return;
    lastCapture.current = performance.now();
    try {
      const st = await NativeBridge.longPush(pendingHint.current);
      if (st.status !== 'nochange') pendingHint.current = 0;
      const status = st.status === 'nochange' ? 'bottom' : st.status;
      // 到底后自动滚动也停下来
      setLong((l) => ({ ...l, frames: st.frames, w: st.width, h: st.height, status, auto: status === 'bottom' ? false : l.auto }));
      await drawPreview();
    } catch {
      /* 会话已结束等竞态，忽略 */
    }
  }, [drawPreview]);

  const scrollAndCapture = useCallback(
    async (dy: number): Promise<boolean> => {
      const r = selRef.current;
      if (!r) return false;
      // 把滚轮代理给选区下方的真实窗口，再抓一帧推进 Rust 拼接器
      const moved = await NativeBridge.scrollRegion(r.x + r.w / 2, r.y + r.h / 2, dy);
      if (moved <= 0) {
        setLong((l) => ({ ...l, status: 'noscroll', auto: false }));
        return false;
      }
      pendingHint.current += moved * dpr;
      window.clearTimeout(captureTimer.current);
      if (performance.now() - lastCapture.current > 60) await captureFrame();
      else captureTimer.current = window.setTimeout(() => void captureFrame(), 120);
      return true;
    },
    [dpr, captureFrame]
  );

  const enterLong = useCallback(
    (r: Rect) => {
      if (!allowLong) {
        onToast('真实屏幕模式下不支持长截图');
        return;
      }
      setTool(null);
      setTextEdit(null);
      pendingHint.current = 0;
      const epoch = ++longEpoch.current;
      void (async () => {
        try {
          const st = await NativeBridge.longBegin(r);
          if (epoch !== longEpoch.current) return;
          // 把选区擦成透明：用户看到实时滚动内容，抓帧也不会拍到自己的遮罩
          desktop.setEraseRect(r);
          setLong({ frames: st.frames, w: st.width, h: st.height, status: 'init', auto: settings.longAutoStart });
          setPhase('long');
        } catch (err) {
          onToast(`长截图启动失败：${String(err)}`);
        }
      })();
    },
    [allowLong, desktop, onToast, settings.longAutoStart]
  );

  useEffect(() => {
    if (phase === 'long') void drawPreview();
  }, [phase, drawPreview]);

  const cancelLong = useCallback(() => {
    longEpoch.current++;
    window.clearTimeout(captureTimer.current);
    void NativeBridge.longCancel();
    desktop.setEraseRect(null);
    setLong({ frames: 0, w: 0, h: 0, status: 'init', auto: false });
    setPhase('selected');
  }, [desktop]);

  const finishLong = useCallback(() => {
    longEpoch.current++;
    window.clearTimeout(captureTimer.current);
    void (async () => {
      try {
        const canvas = await NativeBridge.longFinish();
        desktop.setEraseRect(null);
        onResult({ canvas, kind: 'long', action: 'done' });
        onClose();
      } catch (err) {
        onToast(`导出长图失败：${String(err)}`);
      }
    })();
  }, [desktop, onResult, onClose, onToast]);

  // 自动滚动
  useEffect(() => {
    if (phase !== 'long' || !long.auto) return;
    const interval = { 1: 700, 2: 450, 3: 260 }[settings.longSpeed];
    const id = window.setInterval(() => {
      const r = selRef.current;
      if (!r) return;
      void scrollAndCapture(r.h * 0.55).then((moved) => {
        if (!moved) setLong((l) => ({ ...l, auto: false }));
      });
    }, interval);
    return () => window.clearInterval(id);
  }, [phase, long.auto, settings.longSpeed, scrollAndCapture]);

  /* ---------- 键盘 ---------- */
  useEffect(() => {
    const ok = settings.overlayKeys;
    const onKey = (e: KeyboardEvent) => {
      if (textEdit) {
        if (e.key === 'Escape') {
          setTextEdit(null);
          setTextVal('');
        }
        return;
      }
      // 键位全部可在设置里改，这里按配置查表而不是写死
      const hit = (a: OverlayAction) => comboMatches(e, ok[a]);
      if (hit('cancel')) {
        e.preventDefault();
        if (phase === 'long') cancelLong();
        else onClose();
      } else if (hit('done')) {
        e.preventDefault();
        if (phase === 'long') finishLong();
        else if (phase === 'selected') finish('done');
      } else if (hit('undo')) {
        e.preventDefault();
        undo();
      } else if (hit('redo')) {
        e.preventDefault();
        redo();
      } else if (phase === 'selected' && hit('save')) {
        e.preventDefault();
        finish('save');
      } else if (phase === 'selected' && hit('copy')) {
        e.preventDefault();
        finish('copy');
      } else if (phase === 'pick' && hit('pickColor')) {
        e.preventDefault();
        const hex = toHex(desktop.getPixel(cursor.x, cursor.y));
        navigator.clipboard?.writeText(hex).catch(() => undefined);
        onToast(`已复制颜色 ${hex}`);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    textEdit,
    phase,
    settings.overlayKeys,
    cancelLong,
    onClose,
    finishLong,
    finish,
    undo,
    redo,
    desktop,
    cursor,
    onToast,
  ]);

  /* ---------- 鼠标 ---------- */
  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || phase === 'long') return;
    const x = e.clientX;
    const y = e.clientY;
    if (textEdit) {
      commitText();
      return;
    }
    const handle = (e.target as HTMLElement).dataset?.handle;
    if (handle && sel) {
      drag.current = { kind: 'resize', sx: x, sy: y, orig: sel, handle, moved: false };
      setDragKind('resize');
      return;
    }
    if (phase === 'selected' && sel) {
      if (tool && inRect(x, y, sel)) {
        if (tool === 'text') {
          setTextEdit({ x, y });
          setTextVal('');
          return;
        }
        drag.current = { kind: 'draw', sx: x, sy: y, orig: null, handle: '', moved: false };
        setDragKind('draw');
        setDraft({ id: uid(), tool, color, size, x1: x, y1: y, x2: x, y2: y, points: [{ x, y }] });
        return;
      }
      if (inRect(x, y, sel)) {
        drag.current = { kind: 'move', sx: x, sy: y, orig: sel, handle: '', moved: false };
        setDragKind('move');
        return;
      }
      // 选区外按下：重新框选
      setAnnos([]);
      setRedoStack([]);
      setSel(null);
      setPhase('pick');
    }
    drag.current = { kind: 'new', sx: x, sy: y, orig: null, handle: '', moved: false };
    setDragKind('new');
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const x = e.clientX;
    const y = e.clientY;
    setCursor({ x, y });
    const d = drag.current;
    if (d.kind === 'none') {
      if (phase === 'pick' && settings.detectWindows) {
        const r = desktop.hitTest(x, y);
        setDetected((p) => (p && p.name === r.name && p.x === r.x && p.y === r.y && p.w === r.w && p.h === r.h ? p : r));
      }
      return;
    }
    if (Math.abs(x - d.sx) > 3 || Math.abs(y - d.sy) > 3) d.moved = true;
    if (d.kind === 'new') {
      setSel(clampRect(norm(d.sx, d.sy, x, y), W, H));
    } else if (d.kind === 'move' && d.orig) {
      setSel({ ...d.orig, x: clamp(d.orig.x + x - d.sx, 0, W - d.orig.w), y: clamp(d.orig.y + y - d.sy, 0, H - d.orig.h) });
    } else if (d.kind === 'resize' && d.orig) {
      setSel(resizeRect(d.orig, d.handle, x - d.sx, y - d.sy, W, H));
    } else if (d.kind === 'draw') {
      setDraft((df) => (df ? { ...df, x2: x, y2: y, points: [...(df.points || []), { x, y }] } : df));
    }
  };

  const onMouseUp = (e: React.MouseEvent) => {
    const d = drag.current;
    if (d.kind === 'none') return;
    drag.current = { ...d, kind: 'none' };
    setDragKind('none');
    const x = e.clientX;
    const y = e.clientY;
    if (d.kind === 'new') {
      let r: Rect | null;
      if (!d.moved) {
        r = detected ? { x: detected.x, y: detected.y, w: detected.w, h: detected.h } : settings.detectWindows ? desktop.hitTest(x, y) : { x: 0, y: 0, w: W, h: H };
      } else {
        r = clampRect(norm(d.sx, d.sy, x, y), W, H);
        if (r.w < 4 || r.h < 4) r = null;
      }
      if (!r) {
        setSel(null);
        setPhase('pick');
        return;
      }
      setSel(r);
      setDetected(null);
      setPhase('selected');
      if (mode === 'long' && !longStarted.current) {
        longStarted.current = true;
        enterLong(r);
      }
    } else if (d.kind === 'draw') {
      if (draft && (d.moved || draft.tool === 'pen' || draft.tool === 'marker')) pushAnno(draft);
      setDraft(null);
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    if (phase !== 'long' || !sel || long.auto) return;
    if (!inRect(e.clientX, e.clientY, sel)) return;
    // 长截图只支持向下滚动拼接
    if (e.deltaY <= 0) return;
    void scrollAndCapture(Math.min(e.deltaY, sel.h * 0.6));
  };

  /* ---------- 布局计算 ---------- */
  const op = settings.maskOpacity;
  let tbTop = 0;
  let tbLeft = 0;
  let subTop = 0;
  if (sel) {
    const need = TB_H + (tool ? SUB_H + 6 : 0);
    const below = sel.y + sel.h + 8;
    if (below + need <= H - 6) {
      tbTop = below;
      subTop = below + TB_H + 6;
    } else if (sel.y - 8 - need >= 6) {
      tbTop = sel.y - 8 - TB_H;
      subTop = tbTop - 6 - SUB_H;
    } else {
      tbTop = sel.y + sel.h - 8 - TB_H;
      subTop = tbTop - 6 - SUB_H;
    }
    tbLeft = clamp(sel.x + sel.w - tbW, 6, Math.max(6, W - tbW - 6));
  }
  let panelLeft = 0;
  let panelTop = 0;
  if (sel) {
    panelLeft = sel.x + sel.w + 12;
    if (panelLeft + PANEL_W > W - 8) panelLeft = sel.x - 12 - PANEL_W;
    if (panelLeft < 8) panelLeft = Math.max(8, W - PANEL_W - 8);
    panelTop = clamp(sel.y, 8, Math.max(8, H - 470));
  }
  const MAG_W = 140;
  const MAG_H = 200;
  const magLeft = cursor.x + 22 + MAG_W > W ? cursor.x - 22 - MAG_W : cursor.x + 22;
  const magTop = cursor.y + 22 + MAG_H > H ? cursor.y - 22 - MAG_H : cursor.y + 22;
  const pixel = showMag ? desktop.getPixel(cursor.x, cursor.y) : null;

  let rootCursor = 'crosshair';
  if (phase === 'long') rootCursor = 'default';
  else if (phase === 'selected' && sel && !tool && inRect(cursor.x, cursor.y, sel)) rootCursor = 'move';

  const longStatusText: Record<LongStatus, string> = {
    init: '在选区内滚动鼠标滚轮开始拼接',
    appended: '正在拼接…继续滚动',
    nochange: '已到达底部，点击「完成」',
    bottom: '已到达底部，点击「完成」',
    seam: '未找到重叠区域，已按顺序追加（请放慢滚动）',
    full: '已达到最大长度，请点击「完成」',
    noscroll: '该区域内没有可滚动的内容',
  };

  return (
    <div
      className="shot-root"
      style={{ cursor: rootCursor }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      onDoubleClick={() => {
        if (phase === 'selected' && sel && !tool && inRect(cursor.x, cursor.y, sel)) finish('done');
      }}
      onWheel={onWheel}
      onContextMenu={(e) => {
        e.preventDefault();
        if (phase === 'long') cancelLong();
        else if (tool) setTool(null);
        else onClose();
      }}
    >
      {/* 标注层 */}
      <canvas ref={annoCanvas} className="anno-canvas" style={{ width: W, height: H }} />

      {/* 遮罩 */}
      {!sel &&
        (detected && phase === 'pick' ? (
          <div
            className="shot-outline"
            style={{
              left: detected.x,
              top: detected.y,
              width: detected.w,
              height: detected.h,
              boxShadow: `0 0 0 9999px rgba(0,0,0,${op})`,
              outline: `2px solid ${ACCENT}`,
              outlineOffset: -1,
            }}
          />
        ) : (
          <div className="shot-mask" style={{ background: `rgba(0,0,0,${op})` }} />
        ))}
      {sel && (
        <div
          className="shot-outline"
          style={{
            left: sel.x,
            top: sel.y,
            width: sel.w,
            height: sel.h,
            boxShadow: `0 0 0 9999px rgba(0,0,0,${op})`,
            outline: `${phase === 'long' ? 2 : 1}px solid ${ACCENT}`,
          }}
        />
      )}

      {/* 十字准线 */}
      {settings.showCrosshair && phase === 'pick' && (
        <>
          <div className="crosshair-v" style={{ left: cursor.x, background: ACCENT_SOFT }} />
          <div className="crosshair-h" style={{ top: cursor.y, background: ACCENT_SOFT }} />
        </>
      )}

      {/* 自动识别标签 */}
      {!sel && detected && phase === 'pick' && (
        <div
          className="detect-tag"
          style={{ left: detected.x + 6, top: detected.y + 6 }}
        >
          <span>{detected.name}</span>
          <span className="detect-tag-size">
            {Math.round(detected.w * dpr)} × {Math.round(detected.h * dpr)}
          </span>
        </div>
      )}

      {/* 选区尺寸 */}
      {sel && (
        <div
          className="size-tag"
          style={{ left: sel.x, top: sel.y >= 32 ? sel.y - 30 : sel.y + 6 }}
        >
          {Math.round(sel.w * dpr)} × {Math.round(sel.h * dpr)}
          {phase === 'long' && <span className="size-tag-hint">长截图中 · 滚动滚轮拼接 · Enter 完成 · Esc 取消</span>}
        </div>
      )}

      {/* 手柄 */}
      {sel &&
        phase === 'selected' &&
        !tool &&
        HANDLES.map((h) => {
          const hx = h.includes('w') ? sel.x : h.includes('e') ? sel.x + sel.w : sel.x + sel.w / 2;
          const hy = h.includes('n') ? sel.y : h.includes('s') ? sel.y + sel.h : sel.y + sel.h / 2;
          return (
            <div
              key={h}
              data-handle={h}
              className="sel-handle"
              style={{ left: hx - 5, top: hy - 5, border: `1.5px solid ${ACCENT}`, cursor: HANDLE_CURSOR[h] }}
            />
          );
        })}

      {/* 工具栏 */}
      {sel && phase === 'selected' && (
        <>
          <div
            ref={tbRef}
            className="shot-toolbar"
            style={{ left: tbLeft, top: tbTop, cursor: 'default' }}
            onMouseDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {TOOLS.map((t) => (
              <TbBtn key={t.id} active={tool === t.id} title={t.label} onClick={() => setTool(tool === t.id ? null : t.id)}>
                <t.icon size={17} strokeWidth={1.8} />
              </TbBtn>
            ))}
            <TbBtn
              active={tool === 'number'}
              title="序号"
              onClick={() => setTool(tool === 'number' ? null : 'number')}
            >
              <span className="tool-index">
                {annos.filter((a) => a.tool === 'number').length + 1}
              </span>
            </TbBtn>
            <Sep />
            <TbBtn disabled={!annos.length} title="撤销 (Ctrl+Z)" onClick={undo}>
              <Undo2 size={17} strokeWidth={1.8} />
            </TbBtn>
            <TbBtn disabled={!redoStack.length} title="重做 (Ctrl+Y)" onClick={redo}>
              <Redo2 size={17} strokeWidth={1.8} />
            </TbBtn>
            <Sep />
            <TbBtn disabled={!allowLong} title={allowLong ? '长截图' : '真实屏幕模式下不支持长截图'} onClick={() => enterLong(sel)}>
              <ScrollText size={17} strokeWidth={1.8} />
            </TbBtn>
            <TbBtn title="贴图" onClick={() => finish('pin')}>
              <Pin size={17} strokeWidth={1.8} />
            </TbBtn>
            <Sep />
            <TbBtn danger title="取消 (Esc)" onClick={onClose}>
              <X size={18} strokeWidth={2} />
            </TbBtn>
            <TbBtn title="保存 (Ctrl+S)" onClick={() => finish('save')}>
              <Download size={17} strokeWidth={1.8} />
            </TbBtn>
            <TbBtn title="复制 (Ctrl+C)" onClick={() => finish('copy')}>
              <Copy size={17} strokeWidth={1.8} />
            </TbBtn>
            <TbBtn primary title="完成 (Enter / 双击)" onClick={() => finish('done')}>
              <Check size={19} strokeWidth={2.2} />
            </TbBtn>
          </div>

          {/* 二级工具栏：粗细 / 颜色 */}
          {tool && (
            <div
              className="shot-subbar"
              style={{ left: tbLeft, top: subTop, cursor: 'default' }}
              onMouseDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              {([1, 2, 3] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSize(s)}
                  className={`swatch-btn ${size === s ? 'swatch-btn--on' : 'swatch-btn--off'}`}
                  title={['细', '中', '粗'][s - 1]}
                >
                  <span className="swatch-dot" style={{ width: 4 + s * 3, height: 4 + s * 3 }} />
                </button>
              ))}
              {tool !== 'mosaic' && (
                <>
                  <Sep />
                  {COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setColor(c)}
                      className="color-swatch"
                      style={{
                        background: c,
                        boxShadow: color === c ? `0 0 0 2px var(--card), 0 0 0 3.5px ${ACCENT}` : undefined,
                        transform: color === c ? 'scale(1.1)' : undefined,
                      }}
                    />
                  ))}
                </>
              )}
            </div>
          )}
        </>
      )}

      {/* 文字输入 */}
      {textEdit && (
        <textarea
          autoFocus
          value={textVal}
          onChange={(e) => setTextVal(e.target.value)}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              commitText();
            }
          }}
          placeholder="输入文字，Enter 确认"
          className="anno-input"
          style={{
            left: textEdit.x - 5,
            top: textEdit.y - 3,
            color,
            borderColor: ACCENT,
            fontSize: { 1: 15, 2: 20, 3: 28 }[size],
            textShadow: '0 0 3px #fff, 0 0 3px #fff',
            cursor: 'text',
          }}
          rows={1}
        />
      )}

      {/* 放大镜 */}
      {showMag && pixel && (
        <div
          className="magnifier"
          style={{ left: magLeft, top: magTop, width: MAG_W }}
        >
          <canvas ref={magCanvas} className="u-block" style={{ width: MAG_W, height: MAG_W }} />
          <div className="mag-info">
            <div>
              POS ({Math.round(cursor.x * dpr)}, {Math.round(cursor.y * dpr)})
            </div>
            <div className="mag-row">
              <span className="mag-chip" style={{ background: toHex(pixel) }} />
              <span>{toHex(pixel)}</span>
            </div>
            <div className="mag-dim">
              RGB({pixel[0]},{pixel[1]},{pixel[2]}) · 按 C 复制
            </div>
          </div>
        </div>
      )}

      {/* 长截图面板 */}
      {sel && phase === 'long' && (
        <div
          className="long-panel"
          style={{ left: panelLeft, top: panelTop, width: PANEL_W, cursor: 'default' }}
          onMouseDown={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
        >
          <div className="long-head">
            <div className="long-title">
              <ScrollText size={15} className="u-accent" />
              长截图
            </div>
            <span className="long-badge">{long.frames} 帧</span>
          </div>
          <div ref={previewBox} className="long-preview win-scroll">
            <canvas ref={previewCanvas} className="long-canvas" />
          </div>
          <div className="long-foot">
            <div className="long-size">
              {long.w} × {long.h} px
            </div>
            <div
              className={`long-status ${
                long.status === 'seam' || long.status === 'noscroll'
                  ? 'long-status--danger'
                  : long.status === 'bottom' || long.status === 'nochange' || long.status === 'full'
                    ? 'long-status--ok'
                    : 'long-status--muted'
              }`}
            >
              {long.auto ? '自动滚动中… ' : ''}
              {longStatusText[long.status]}
            </div>
          </div>
          <div className="long-actions">
            <button
              type="button"
              onClick={() => setLong((l) => ({ ...l, auto: !l.auto }))}
              className={`auto-btn ${long.auto ? 'auto-btn--on' : 'auto-btn--off'}`}
            >
              {long.auto ? <Pause size={13} /> : <Play size={13} />}
              {long.auto ? '暂停' : '自动滚动'}
            </button>
            <div className="u-flex-1" />
            <button
              type="button"
              onClick={cancelLong}
              title="取消 (Esc)"
              className="panel-btn panel-btn--icon"
            >
              <X size={16} />
            </button>
            <button
              type="button"
              onClick={finishLong}
              title="完成 (Enter)"
              className="panel-btn panel-btn--primary"
            >
              <Check size={14} /> 完成
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
