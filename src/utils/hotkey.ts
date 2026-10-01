/** 组合键序列化：Ctrl / Alt / Shift + 主键 */
export type HotkeyField = 'shot' | 'long' | 'pin';

export function comboFromEvent(e: KeyboardEvent): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let k = e.key;
  if (k === ' ') k = 'Space';
  else if (k.length === 1) k = k.toUpperCase();
  else if (k === 'Escape') k = 'Esc';
  else if (k.startsWith('Arrow')) k = k.slice(5);
  parts.push(k);
  return parts.join('+');
}

function normalize(combo: string): string {
  const p = combo.split('+');
  const mods = p.slice(0, -1).sort().join('+');
  return mods ? `${mods}+${p[p.length - 1]}` : p[p.length - 1];
}

export function comboMatches(e: KeyboardEvent, combo: string): boolean {
  if (!combo) return false;
  const c = comboFromEvent(e);
  return !!c && normalize(c) === normalize(combo);
}

import { NativeBridge } from '../bridge/tauri';

/** 录制过程中挂起应用级热键响应（在 Tauri WebView2 下同步通知 Rust 临时 UnregisterHotKey） */
export const hotkeyCapture = {
  active: false,
  setPaused(paused: boolean) {
    this.active = paused;
    void NativeBridge.setHotkeyPaused(paused);
  },
};
