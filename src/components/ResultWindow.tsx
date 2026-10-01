import React, { useEffect, useRef, useState } from 'react';
import { Copy, Download, X, Pin } from 'lucide-react';
import type { ResultItem } from '../types';
import { FILE_PREFIX } from '../brand';
import { isTauriEnv, NativeBridge } from '../bridge/tauri';

interface Props {
  item: ResultItem;
  dpr: number;
  onClose: (id: string) => void;
  onToast: (msg: string) => void;
}

export async function copyDataUrl(dataUrl: string): Promise<boolean> {
  // 原生 Tauri：交给 Rust（A 方案手写 Win32 剪贴板 / B 方案 plugin-clipboard-manager）
  if (isTauriEnv()) return NativeBridge.copyPng(dataUrl);
  try {
    const blob = await (await fetch(dataUrl)).blob();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return true;
  } catch {
    return false;
  }
}

/**
 * 保存 PNG。
 * 原生 Tauri：A = 直接写入「下载」目录；B = 弹出系统「另存为」对话框。
 * 返回落盘路径（浏览器环境返回空字符串，走浏览器下载通道）。
 */
export async function downloadDataUrl(dataUrl: string, prefix = FILE_PREFIX): Promise<string> {
  if (isTauriEnv()) return NativeBridge.savePng(dataUrl, prefix);
  const t = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const a = document.createElement('a');
  a.download = `${prefix}_${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}_${p(t.getHours())}-${p(t.getMinutes())}-${p(t.getSeconds())}.png`;
  a.href = dataUrl;
  a.click();
  return '';
}

/** 贴图 / 结果预览窗口：无边框悬浮图片，可拖动，悬停显示操作栏 */
export const ResultWindow: React.FC<Props> = ({ item, dpr, onClose, onToast }) => {
  const [pos, setPos] = useState({ x: item.x, y: item.y });
  const [hover, setHover] = useState(false);
  const [zoom, setZoom] = useState(1);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  const maxW = Math.max(200, window.innerWidth * 0.5);
  const baseW = Math.min(item.w / dpr, maxW);
  const displayW = baseW * zoom;
  const maxH = window.innerHeight * 0.72;

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragRef.current) return;
      setPos({
        x: Math.max(-displayW + 80, Math.min(window.innerWidth - 80, e.clientX - dragRef.current.dx)),
        y: Math.max(0, Math.min(window.innerHeight - 60, e.clientY - dragRef.current.dy)),
      });
    };
    const up = () => (dragRef.current = null);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [displayW]);

  return (
    <div
      className="absolute z-30 bg-card shadow-pin select-none"
      data-region="pin"
      style={{ left: pos.x, top: pos.y, width: displayW, outline: `1px solid ${hover ? 'var(--accent)' : 'var(--stroke-strong)'}` }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onMouseDown={(e) => {
        e.stopPropagation();
        dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
      }}
      onWheel={(e) => {
        e.stopPropagation();
        setZoom((z) => Math.max(0.15, Math.min(4, z * (e.deltaY < 0 ? 1.12 : 0.89))));
      }}
      title="拖动移动 · 滚轮缩放 · 悬停后点 ✕ 关闭"
    >
      <div className="overflow-y-auto overflow-x-hidden" style={{ maxHeight: maxH, cursor: 'move' }}>
        <img src={item.dataUrl} alt="" draggable={false} className="block" style={{ width: displayW }} />
      </div>

      {/* 悬停操作栏 */}
      <div
        className={`absolute top-2 right-2 flex items-center gap-0.5 bg-acrylic backdrop-blur rounded-md border border-stroke shadow-flyout p-0.5 transition-opacity ${
          hover ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        onMouseDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <span className="px-1.5 text-[11px] text-fg2 font-mono flex items-center gap-1" title={`${item.w} × ${item.h} px`}>
          <Pin size={11} className="text-accent" />
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          title="复制"
          onClick={async () => onToast((await copyDataUrl(item.dataUrl)) ? '已复制到剪贴板' : '复制失败：浏览器未授权剪贴板')}
          className="w-7 h-7 rounded flex items-center justify-center text-fg hover:bg-subtle cursor-pointer"
        >
          <Copy size={14} />
        </button>
        <button
          type="button"
          title="保存"
          onClick={async () => {
            const path = await downloadDataUrl(item.dataUrl, item.kind === 'long' ? `${FILE_PREFIX}_长截图` : FILE_PREFIX);
            onToast(path ? `已保存到 ${path}` : '已保存');
          }}
          className="w-7 h-7 rounded flex items-center justify-center text-fg hover:bg-subtle cursor-pointer"
        >
          <Download size={14} />
        </button>
        <button
          type="button"
          title="关闭"
          onClick={() => onClose(item.id)}
          className="w-7 h-7 rounded flex items-center justify-center text-danger hover:bg-danger-soft cursor-pointer"
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
};
