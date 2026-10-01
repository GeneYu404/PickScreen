/**
 * Tauri v2 + WebView2 桥接层 (Bridge) —— 方案 B
 *
 * 方案 B 的定位：全程使用官方插件与官方 JS SDK。
 * - IPC 用 @tauri-apps/api 的 invoke，事件用官方 listen
 * - 配置持久化用 tauri-plugin-store（前端 JS 直接读写 store）
 * - 保存路径用 tauri-plugin-dialog 的系统「另存为」对话框
 * - 全局热键 / 剪贴板由 Rust 侧的插件实现（syncHotkeys / copyPng 走插件命令）
 *
 * 导出的接口签名与方案 A 完全一致，因此 App/Overlay/ResultWindow 等
 * 业务组件在两个方案之间零改动复用。
 *
 * 若运行在普通浏览器预览环境，所有接口静默降级为 no-op（isTauriEnv() === false）。
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { load } from '@tauri-apps/plugin-store';
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';
import type { Store } from '@tauri-apps/plugin-store';
import type { Hotkeys, Settings } from '../types';

/* ---------------- 类型契约（与 Rust 侧一一对应，与方案 A 相同） ---------------- */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 真实窗口矩形（已由物理像素换算为 CSS 像素，顺序 = Z 序） */
export interface NativeWindowInfo extends Rect {
  title: string;
}

export type LongStatus = 'init' | 'appended' | 'nochange' | 'seam' | 'full';

export interface LongState {
  frames: number;
  width: number;
  height: number;
  status: LongStatus;
}

/** 需要参与「鼠标穿透动态切换」的交互矩形（CSS 像素） */
export interface PinRegion extends Rect {
  id: string;
  /** true = 需要键盘焦点（设置面板 / 托盘菜单），false = 贴图（仅鼠标，不抢焦点） */
  focus?: boolean;
}

/** 当前是否运行在真实的 Tauri v2 WebView2 桌面客户端中 */
export function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && typeof (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ === 'object';
}

async function optionalInvoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T | undefined> {
  if (!isTauriEnv()) return undefined;
  return invoke<T>(cmd, args);
}

function requireInvoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriEnv()) return Promise.reject(new Error(`当前为浏览器预览环境，未连接 Tauri 后端 (命令: ${cmd})`));
  return invoke<T>(cmd, args);
}

/* ---------------- CSS px <-> 物理 px 坐标映射 ---------------- */

const dpr0 = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
/** 抓帧物理尺寸 / 窗口 CSS 尺寸；grabScreen() 之后用真实值校准 */
let map = { sx: dpr0, sy: dpr0 };

function physRect(r: Rect) {
  return {
    x: Math.round(r.x * map.sx),
    y: Math.round(r.y * map.sy),
    w: Math.max(1, Math.round(r.w * map.sx)),
    h: Math.max(1, Math.round(r.h * map.sy)),
  };
}
function cssRect(r: Rect): Rect {
  return { x: r.x / map.sx, y: r.y / map.sy, w: r.w / map.sx, h: r.h / map.sy };
}

/* ---------------- 可见视口真值（DPI 切换自愈） ---------------- */

let lastNudge = 0;

/**
 * 可见视口（CSS 像素）。
 *
 * 健康态下 innerWidth == screen.width（两者同为 DIP 口径），互为参照；
 * 一旦布局口径异常（远程会话/分辨率切换后 WebView2 视口被腰斩或谎报），
 * 触发 Rust 侧重下 bounds 自愈（Rust 按 物理窗口/真实DPI 计算，幂等，
 * 限流 2s）。收拢取两者较小值，保证面板始终落在可见区内。
 * 浏览器预览环境直接返回 innerWidth / innerHeight。
 */
export async function viewportCss(): Promise<{ w: number; h: number }> {
  const iw = window.innerWidth;
  const ih = window.innerHeight;
  if (!isTauriEnv()) return { w: iw, h: ih };
  const rw = window.screen.width || iw;
  const rh = window.screen.height || ih;
  if (Math.abs(iw - rw) > 4) {
    const now = Date.now();
    if (now - lastNudge > 2000) {
      lastNudge = now;
      void optionalInvoke('renudge');
    }
  }
  return { w: Math.min(iw, rw), h: Math.min(ih, rh) };
}

/* ---------------- 二进制 IPC 工具 ---------------- */

function asU8(res: unknown): Uint8Array {
  if (res instanceof Uint8Array) return res;
  if (res instanceof ArrayBuffer) return new Uint8Array(res);
  if (ArrayBuffer.isView(res)) return new Uint8Array(res.buffer, res.byteOffset, res.byteLength);
  if (Array.isArray(res)) return Uint8Array.from(res as number[]);
  throw new Error('无法识别的二进制 IPC 响应');
}

/** 原始帧：[u32 width][u32 height][BGRA...] -> ImageBitmap（BGRA -> RGBA，alpha 归 255） */
async function frameToBitmap(res: unknown): Promise<ImageBitmap> {
  const u8 = asU8(res);
  if (u8.byteLength < 8) throw new Error('抓帧数据不完整');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const w = dv.getUint32(0, true);
  const h = dv.getUint32(4, true);
  const rgba = new Uint8ClampedArray(w * h * 4);
  const src = u8.subarray(8);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = src[i + 2];
    rgba[i + 1] = src[i + 1];
    rgba[i + 2] = src[i];
    rgba[i + 3] = 255;
  }
  return createImageBitmap(new ImageData(rgba, w, h));
}

async function pngToCanvas(res: unknown): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(new Blob([asU8(res) as BlobPart], { type: 'image/png' }));
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext('2d')!.drawImage(bmp, 0, 0);
  bmp.close();
  return c;
}

let previewUrl: string | null = null;
let storeCache: Store | null = null;

async function settingsStore(): Promise<Store> {
  if (!storeCache) storeCache = await load('settings.json', { autoSave: false });
  return storeCache;
}

/* ---------------- 对外统一契约（与方案 A 的 bridge 接口完全一致） ---------------- */

export const NativeBridge = {
  /* ===== 配置持久化：tauri-plugin-store（A 方案是手写 JSON 文件） ===== */

  async syncHotkeys(hotkeys: Hotkeys, enabled: boolean): Promise<void> {
    await optionalInvoke('sync_hotkeys', {
      shot: hotkeys.shot,
      long: hotkeys.long,
      pin: hotkeys.pin,
      shotEnabled: hotkeys.shotEnabled,
      longEnabled: hotkeys.longEnabled,
      pinEnabled: hotkeys.pinEnabled,
      enabled,
    });
  },

  /* ===== 开机自启动（官方插件，浏览器环境静默降级） ===== */

  /** 当前是否已注册开机自启（读系统真实状态，不是本地缓存） */
  async isAutoStartEnabled(): Promise<boolean> {
    if (!isTauriEnv()) return false;
    try {
      return await isEnabled();
    } catch {
      return false;
    }
  },

  /** 开启 / 关闭开机自启。失败时抛错，由调用方回滚 UI 状态 */
  async setAutoStart(on: boolean): Promise<void> {
    if (!isTauriEnv()) return;
    if (on) await enable();
    else await disable();
  },

  async setHotkeyPaused(paused: boolean): Promise<void> {
    await optionalInvoke('set_hotkey_paused', { paused });
  },

  /** 同步「参与鼠标穿透切换」的矩形，Rust 侧 60Hz 轮询切换 WS_EX_TRANSPARENT */
  async syncPinRegions(regions: PinRegion[]): Promise<void> {
    if (!isTauriEnv()) return;
    await invoke('sync_pin_regions', {
      regions: regions.map((r) => ({ ...physRect(r), id: r.id, focus: !!r.focus })),
    });
  },

  /** 保存配置到插件 store（%APPDATA%\<identifier>\settings.json） */
  async saveSettings(settings: Settings): Promise<void> {
    if (!isTauriEnv()) return;
    const store = await settingsStore();
    await store.set('settings', settings);
    await store.save();
  },

  async loadSettings(): Promise<Settings | null> {
    if (!isTauriEnv()) return null;
    try {
      const store = await settingsStore();
      const v = await store.get<Settings>('settings');
      return v ?? null;
    } catch {
      return null;
    }
  },

  /* ===== 屏幕捕获 ===== */

  /**
   * 抓取整块虚拟桌面：先隐藏本窗口 → 抓帧 → 显示并聚焦（避免把自己拍进去）。
   * 返回 ImageBitmap（物理像素1:1）。
   */
  async grabScreen(captureSelf = false): Promise<ImageBitmap> {
    const u8 = asU8(await requireInvoke('grab_screen', { captureSelf }));
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const w = dv.getUint32(0, true);
    const h = dv.getUint32(4, true);
    // 用可见视口真值校准（帧为整块物理虚拟桌面；布局口径说谎时 innerWidth 不可用）
    const vis = await viewportCss();
    if (vis.w > 0 && vis.h > 0) {
      map = { sx: w / vis.w, sy: h / vis.h };
    }
    return frameToBitmap(u8);
  },

  /** 枚举真实可见窗口（DWM 扩展帧边界，已换算为 CSS 像素，顺序 = Z 序） */
  async listWindows(): Promise<NativeWindowInfo[]> {
    const rows = await optionalInvoke<{ title: string; x: number; y: number; w: number; h: number }[]>('list_windows');
    if (!rows) return [];
    return rows.map((r) => ({ ...cssRect(r), title: r.title }));
  },

  /** 截图覆盖层结束：把窗口交还给「按鼠标位置动态穿透」的空闲逻辑 */
  async endOverlay(): Promise<void> {
    await optionalInvoke('end_overlay');
  },

  /**
   * 窗口整体显隐。空闲（无配置面板 / 无覆盖层 / 无贴图）时隐藏整块 webview，
   * 让托盘常驻期间不占顶层窗口位；Rust 侧 60Hz 穿透轮询见窗口不可见即休眠。
   * 覆盖层启动路径不依赖它 —— grab_screen 自己收尾时就会 show。
   */
  async setWindowVisible(visible: boolean): Promise<void> {
    await optionalInvoke('set_window_visible', { visible });
  },

  /* ===== 长截图（拼接器在 Rust 侧，与 A 共用实现） ===== */

  async longBegin(r: Rect): Promise<LongState> {
    const p = physRect(r);
    return requireInvoke<LongState>('long_begin', { x: p.x, y: p.y, w: p.w, h: p.h });
  },

  async longPush(hint: number): Promise<LongState> {
    return requireInvoke<LongState>('long_push', { hint: Math.round(hint) });
  },

  /** 返回缩略图 PNG 的 blob URL（自动回收上一张） */
  async longPreview(): Promise<string> {
    const u8 = asU8(await requireInvoke('long_preview'));
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(new Blob([u8 as BlobPart], { type: 'image/png' }));
    return previewUrl;
  },

  /** 拉取全分辨率长图，返回画布 */
  async longFinish(): Promise<HTMLCanvasElement> {
    return pngToCanvas(await requireInvoke('long_finish'));
  },

  async longCancel(): Promise<void> {
    await optionalInvoke('long_cancel');
  },

  /** 把滚轮滚动代理给选区下方的真实窗口；入参/返回值均为 CSS 像素，0 = 下方无目标 */
  async scrollRegion(x: number, y: number, dy: number): Promise<number> {
    const moved = await optionalInvoke<number>('scroll_region', {
      x: Math.round(x * map.sx),
      y: Math.round(y * map.sy),
      dy: Math.round(dy * map.sy),
    });
    return (moved ?? 0) / map.sy;
  },

  /* ===== 剪贴板 / 落盘 ===== */

  /** 剪贴板：Rust 侧通过 tauri-plugin-clipboard-manager 写入（A 为手写 Win32 CF_DIB） */
  async copyPng(dataUrl: string): Promise<boolean> {
    try {
      await requireInvoke('copy_png', { req: { dataUrl } });
      return true;
    } catch {
      return false;
    }
  },

  /** 保存 PNG：先用 tauri-plugin-dialog 弹「另存为」，再由 Rust 落盘；取消返回 '' */
  async savePng(dataUrl: string, prefix = '拾屏'): Promise<string> {
    if (!isTauriEnv()) return '';
    const t = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const suggested = `${prefix}_${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}_${p(t.getHours())}-${p(t.getMinutes())}-${p(t.getSeconds())}.png`;
    const path = await saveDialog({
      title: '保存截图',
      defaultPath: suggested,
      filters: [{ name: 'PNG 图片', extensions: ['png'] }],
    });
    if (!path) return ''; // 用户取消
    const finalPath = path.toLowerCase().endsWith('.png') ? path : `${path}.png`;
    return (await invoke<string>('save_png', { req: { dataUrl, path: finalPath } })) ?? '';
  },

  /* ===== 事件 ===== */

  /** 订阅 Rust 侧事件（热键 / 托盘）。返回取消订阅函数。 */
  async onNativeAction(cb: (action: string) => void): Promise<() => void> {
    if (!isTauriEnv()) return () => undefined;
    const un = await listen<string>('action', (e) => cb(String(e.payload ?? '')));
    return () => {
      void un();
    };
  },
};
