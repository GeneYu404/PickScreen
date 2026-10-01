import { useCallback, useEffect, useRef, useState } from 'react';
import { Crop, ScrollText, Settings2, Info, Power, Pin } from 'lucide-react';
import { ScreenFrame } from './bridge/desktop';
import type { DetectRegion } from './bridge/desktop';
import { ScreenshotOverlay } from './components/ScreenshotOverlay';
import type { OverlayResult } from './components/ScreenshotOverlay';
import { MainWindow, AppLogo } from './components/MainWindow';
import { ResultWindow, copyDataUrl, downloadDataUrl } from './components/ResultWindow';
import { DEFAULT_SETTINGS } from './types';
import type { Settings, ResultItem } from './types';
import { APP_NAME, APP_VERSION } from './brand';
import { comboMatches, hotkeyCapture } from './utils/hotkey';
import { isTauriEnv, NativeBridge } from './bridge/tauri';

const uid = () => Math.random().toString(36).slice(2, 7);

/** 是否运行在 Tauri v2 + WebView2 原生容器中（模块级常量，双环境编译） */
const native = isTauriEnv();

export function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [desktop, setDesktop] = useState<ScreenFrame | null>(null);

  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  // 原生模式启动不弹面板：纯托盘常驻，靠全局热键 / 托盘菜单唤起。
  // 浏览器原型没有托盘，仍保持开箱即见，避免开发调试要多点一次桌面图标。
  const [showMain, setShowMain] = useState(!native);
  const [trayMenu, setTrayMenu] = useState(false);
  const [overlay, setOverlay] = useState<{ mode: 'shot' | 'long' } | null>(null);
  const [results, setResults] = useState<ResultItem[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef(0);

  /** 配置加载完成前不回写，避免用默认值覆盖磁盘上的旧配置 */
  const settingsReady = useRef(!native);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  /* ---------- 启动时读取已保存配置 ---------- */
  useEffect(() => {
    if (!native) return;
    void NativeBridge.loadSettings().then((saved) => {
      if (saved) {
        setSettings({ ...DEFAULT_SETTINGS, ...saved, hotkeys: { ...DEFAULT_SETTINGS.hotkeys, ...saved.hotkeys } });
      }
      settingsReady.current = true;
    });
  }, []);

  /* ---------- 自动同步配置至 Rust 后端（快捷键 + 持久化） ---------- */
  useEffect(() => {
    if (!native || !settingsReady.current) return;
    void NativeBridge.syncHotkeys(settings.hotkeys, settings.hotkeysEnabled);
    void NativeBridge.saveSettings(settings);
  }, [settings]);

  /** 托盘事件回调里读到的最新配置（事件订阅不依赖 settings，避免每次改动都重订阅） */
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  /** 全局快捷键总开关：托盘菜单触发，落盘后由上面的 effect 同步给 Rust 注销/注册 */
  const toggleHotkeys = useCallback(() => {
    const next = !settingsRef.current.hotkeysEnabled;
    setSettings((s) => ({ ...s, hotkeysEnabled: next }));
    showToast(next ? '全局快捷键已开启' : '全局快捷键已关闭 · 仍可从托盘唤起');
  }, [showToast]);

  /* ---------- 原生模式：屏蔽 WebView2 默认右键菜单（表单控件除外） ---------- */
  useEffect(() => {
    if (!native) return;
    const onCtx = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select, [contenteditable="true"]')) return;
      e.preventDefault();
    };
    document.addEventListener('contextmenu', onCtx);
    return () => document.removeEventListener('contextmenu', onCtx);
  }, []);

  /* ---------- 定期同步「参与鼠标穿透切换」的矩形：贴图 / 设置面板 / 托盘菜单 ---------- */
  useEffect(() => {
    if (!native) return;
    const sync = () => {
      const regions = Array.from(document.querySelectorAll<HTMLElement>('[data-region]')).map((el, i) => {
        const r = el.getBoundingClientRect();
        const kind = el.getAttribute('data-region') || 'pin';
        return { id: `${kind}-${i}`, x: r.x, y: r.y, w: r.width, h: r.height, focus: kind !== 'pin' };
      });
      void NativeBridge.syncPinRegions(regions);
    };
    sync();
    const id = window.setInterval(sync, 250);
    return () => window.clearInterval(id);
  }, []);

  /* ---------- 初始化桌面（原生模式：不绘制模拟桌面，画布保持透明） ---------- */
  useEffect(() => {
    if (!canvasRef.current) return;
    const d = new ScreenFrame(canvasRef.current);
    setDesktop(d);
    const onResize = () => {
      d.resize();
      setOverlay(null);
    };
    window.addEventListener('resize', onResize);
    const clock = window.setInterval(() => d.requestRender(), 30000);
    return () => {
      window.removeEventListener('resize', onResize);
      window.clearInterval(clock);
    };
  }, []);

  /* ---------- 启动截图：原生模式先隐藏窗口抓一帧真实屏幕，再铺到覆盖层 ---------- */
  const startOverlay = useCallback(
    (mode: 'shot' | 'long') => {
      if (overlay || hotkeyCapture.active) return;
      setShowMain(false);
      setTrayMenu(false);
      setOverlay({ mode });
      if (!native) return;
      void (async () => {
        try {
          const bmp = await NativeBridge.grabScreen();
          if (!desktop) return;
          desktop.setEraseRect(null);
          desktop.setWindows(
            (await NativeBridge.listWindows()).map<DetectRegion>((w) => ({ x: w.x, y: w.y, w: w.w, h: w.h, name: w.title }))
          );
          desktop.setScreenImage(bmp);
        } catch (err) {
          setOverlay(null);
          setShowMain(true);
          showToast(`抓取屏幕失败：${String(err)}`);
        }
      })();
    },
    [overlay, desktop, showToast]
  );

  const closeOverlay = useCallback(() => {
    desktop?.setEraseRect(null);
    desktop?.setScreenImage(null);
    if (desktop) desktop.setWindows([]);
    setOverlay(null);
    // 不恢复主面板：截图是「用完即走」的临时态，结束就回到桌面（hasContent 变 false → 整窗隐藏，
    // 键盘焦点由 Rust end_overlay 交还给下层窗口）。配置面板仍可从托盘左键 / 右键菜单打开。
    if (native) void NativeBridge.endOverlay();
  }, [desktop]);

  /* ---------- 结果处理 ---------- */
  const addResult = useCallback(
    (canvas: HTMLCanvasElement, kind: 'shot' | 'long') => {
      const dpr = desktop?.dpr ?? 1;
      const displayW = Math.min(canvas.width / dpr, window.innerWidth * 0.5);
      const n = results.length % 6;
      setResults((prev) => [
        ...prev,
        {
          id: uid(),
          dataUrl: canvas.toDataURL('image/png'),
          w: canvas.width,
          h: canvas.height,
          kind,
          x: Math.max(16, window.innerWidth - displayW - 60 - n * 28),
          y: 60 + n * 28,
        },
      ]);
    },
    [desktop, results.length]
  );

  const handleResult = useCallback(
    async ({ canvas, kind, action }: OverlayResult) => {
      const sizeText = `${canvas.width} × ${canvas.height}`;
      if (action === 'save') {
        const path = await downloadDataUrl(canvas.toDataURL('image/png'));
        showToast(path ? `已保存到 ${path} · ${sizeText}` : `已保存 · ${sizeText}`);
        return;
      }
      if (action === 'pin' || (kind === 'long' && settings.longResult === 'preview')) {
        addResult(canvas, kind);
        if (settings.autoCopy) await copyDataUrl(canvas.toDataURL('image/png'));
        showToast(kind === 'long' ? `长截图完成 · ${sizeText}${settings.autoCopy ? ' · 已复制' : ''}` : '已贴到屏幕上 · 悬停后点 ✕ 关闭');
        return;
      }
      const ok = await copyDataUrl(canvas.toDataURL('image/png'));
      if (ok) {
        showToast(`已复制到剪贴板 · ${sizeText}`);
      } else {
        addResult(canvas, kind);
        showToast('剪贴板不可用，已改为显示贴图');
      }
    },
    [addResult, settings.autoCopy, settings.longResult, showToast]
  );

  /* ---------- 贴图：把最近一次截图再钉一张到屏幕最前 ---------- */
  const pinLast = useCallback(() => {
    if (overlay || hotkeyCapture.active) return;
    if (results.length === 0) {
      showToast(`暂无可贴图的截图，请先用 ${settings.hotkeys.shot || '截图快捷键'} 完成一次截图`);
      return;
    }
    const last = results[results.length - 1];
    const dpr = desktop?.dpr ?? 1;
    const displayW = Math.min(last.w / dpr, window.innerWidth * 0.5);
    const n = results.length % 6;
    setResults((prev) => [
      ...prev,
      { ...last, id: uid(), x: Math.max(16, window.innerWidth - displayW - 60 - n * 28), y: 60 + n * 28 },
    ]);
    showToast('已贴图 · 拖动移动 · 滚轮缩放 · 悬停后点 ✕ 关闭');
  }, [overlay, results, desktop, settings.hotkeys.shot, showToast]);

  /* ---------- 原生模式：订阅 Rust 侧全局热键 / 托盘事件 ---------- */
  useEffect(() => {
    if (!native) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void NativeBridge.onNativeAction((action) => {
      if (disposed) return;
      if (action === 'shot') startOverlay('shot');
      else if (action === 'long') startOverlay('long');
      else if (action === 'pin') pinLast();
      else if (action === 'show') setShowMain(true);
      else if (action === 'toggle_hotkeys') toggleHotkeys();
    }).then((u) => {
      if (disposed) u();
      else unlisten = u;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [startOverlay, pinLast, toggleHotkeys]);

  /* ---------- 应用内快捷键（浏览器环境；原生环境由 Rust 的 RegisterHotKey 接管） ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (native) {
        // 原生模式下只有 Esc 关闭托盘菜单由前端处理，其余组合键全部走 Rust 全局热键
        if (e.key === 'Escape') setTrayMenu(false);
        return;
      }
      if (overlay || hotkeyCapture.active) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const hk = settings.hotkeys;
      if (!settings.hotkeysEnabled) {
        if (e.key === 'Escape') setTrayMenu(false);
        return;
      }
      if (comboMatches(e, hk.shot)) {
        e.preventDefault();
        startOverlay('shot');
      } else if (comboMatches(e, hk.long)) {
        e.preventDefault();
        startOverlay('long');
      } else if (comboMatches(e, hk.pin)) {
        e.preventDefault();
        pinLast();
      } else if (e.key === 'Escape') {
        setTrayMenu(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [native, overlay, startOverlay, pinLast, settings.hotkeys]);

  /* ---------- 空闲时隐藏整块窗口 ----------
     这块 webview 覆盖整个虚拟桌面（Rust cover_virtual_desktop），
     但只有「有东西要渲染」时才需要可见：配置面板 / 截图覆盖层 / 贴图 / 提示条。
     四者皆空时把 HWND 藏掉，托盘常驻期间不占顶层窗口位，
     Rust 侧 60Hz 穿透轮询也会因窗口不可见而自动休眠。
     贴图与提示条必须计入：截图结束（Esc / 完成）后不再回主面板，
     窗口只靠提示条再亮 2.6s，让「已复制到剪贴板 · 1024×768」这类回执仍然可见。 */
  const hasContent = showMain || !!overlay || results.length > 0 || !!toast;
  useEffect(() => {
    if (!native) return;
    void NativeBridge.setWindowVisible(hasContent);
  }, [hasContent, native]);

  return (
    <div
      className="fixed inset-0 overflow-hidden select-none"
      onMouseDown={() => setTrayMenu(false)}
    >
      {/* 桌面 / 真实屏幕抓帧画布（原生空闲态隐藏，让窗口对鼠标完全穿透） */}
      <canvas ref={canvasRef} className="absolute left-0 top-0 block" style={{ display: overlay ? 'block' : 'none' }} />

      {/* 托盘菜单（原生由真实托盘图标事件唤起） */}
      {desktop && trayMenu && !overlay && (
        <div
          className="absolute z-50 w-[200px] bg-acrylic backdrop-blur rounded-lg border border-stroke shadow-flyout animate-menu-in py-1.5 text-[13px] text-fg"
          data-region="tray"
          style={{ right: 16, bottom: 64 }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-1.5 flex items-center gap-2 text-[12px] text-fg2">
            <AppLogo size={16} /> {APP_NAME} {APP_VERSION}
          </div>
          <div className="h-px bg-stroke my-1" />
          {[
            { icon: <Crop size={15} />, label: '截图', kbd: settings.hotkeys.shot, onClick: () => startOverlay('shot') },
            { icon: <ScrollText size={15} />, label: '长截图', kbd: settings.hotkeys.long, onClick: () => startOverlay('long') },
            { icon: <Pin size={15} />, label: '贴图', kbd: settings.hotkeys.pin, onClick: pinLast },
          ].map((m) => (
            <button key={m.label} type="button" onClick={m.onClick} className="w-full h-8 px-3 flex items-center gap-2.5 hover:bg-subtle cursor-pointer">
              <span className="text-accent">{m.icon}</span>
              <span className="flex-1 text-left">{m.label}</span>
              <span className="text-[11px] text-fg3">{m.kbd}</span>
            </button>
          ))}
          <div className="h-px bg-stroke my-1" />
          <button
            type="button"
            onClick={() => {
              setShowMain(true);
              setTrayMenu(false);
            }}
            className="w-full h-8 px-3 flex items-center gap-2.5 hover:bg-subtle cursor-pointer"
          >
            <Settings2 size={15} className="text-fg2" /> 配置…
          </button>
          <button
            type="button"
            onClick={() => {
              setShowMain(true);
              setTrayMenu(false);
            }}
            className="w-full h-8 px-3 flex items-center gap-2.5 hover:bg-subtle cursor-pointer"
          >
            <Info size={15} className="text-fg2" /> 关于
          </button>
          <div className="h-px bg-stroke my-1" />
          <button
            type="button"
            onClick={() => {
              setTrayMenu(false);
              showToast(`请右键托盘图标退出${APP_NAME}`);
            }}
            className="w-full h-8 px-3 flex items-center gap-2.5 hover:bg-subtle cursor-pointer"
          >
            <Power size={15} className="text-fg2" /> 退出
          </button>
        </div>
      )}

      {/* 贴图 / 结果窗口 */}
      {desktop &&
        results.map((r) => (
          <ResultWindow key={r.id} item={r} dpr={desktop.dpr} onClose={(id) => setResults((prev) => prev.filter((x) => x.id !== id))} onToast={showToast} />
        ))}

      {/* 配置主窗口 */}
      {showMain && !overlay && (
        <MainWindow
          settings={settings}
          onChange={setSettings}
          onClose={() => setShowMain(false)}
          onShot={() => startOverlay('shot')}
          onLong={() => startOverlay('long')}
        />
      )}

      {/* 截图覆盖层 */}
      {overlay && desktop && (
        <ScreenshotOverlay
          desktop={desktop}
          mode={overlay.mode}
          settings={settings}
          allowLong={true}
          onClose={closeOverlay}
          onResult={handleResult}
          onToast={showToast}
        />
      )}

      {/* 提示 */}
      {toast && (
        <div className="fixed left-1/2 -translate-x-1/2 z-[200] bg-[#1f1f1f]/92 text-white border border-white/15 text-[12.5px] px-4 h-9 rounded-md shadow-dialog animate-toast-in flex items-center gap-2 pointer-events-none" style={{ bottom: 72 }}>
          <AppLogo size={14} />
          {toast}
        </div>
      )}
    </div>
  );
}

export default App;
