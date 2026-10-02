import { useCallback, useEffect, useRef, useState } from 'react';
import { Crop, ScrollText, Settings2, Info, Power, Pin } from 'lucide-react';
import { emit, listen } from '@tauri-apps/api/event';
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
import { currentWindowLabel, isTauriEnv, NativeBridge } from './bridge/tauri';

const uid = () => Math.random().toString(36).slice(2, 7);

/**
 * 等两帧再放行。
 *
 * 第一帧回调时 DOM/canvas 已提交，但浏览器往往还没把它合成上屏；第二帧回调时屏幕
 * 像素才是最新的。用于「窗口显示前先让画面就绪」，避免全屏 overlay 先闪一个空层。
 */
const nextPaint = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

/** 是否运行在 Tauri v2 + WebView2 原生容器中（模块级常量，双环境编译） */
const native = isTauriEnv();

/**
 * 当前 webview 是哪个窗口。
 *
 * 拆窗之后这是整个前端的分流依据：
 * - `main`：配置面板。正常尺寸（820×560）的普通窗口，整块可交互，只渲染面板本身。
 * - `overlay`：铺满虚拟桌面的透明穿透窗，承载抓屏画布 / 截图覆盖层 / 贴图 /
 *   提示条 / 托盘菜单。60Hz 穿透轮询只作用在它身上。
 *
 * 两者通过 Rust 的全局 `action` 事件通信（托盘、热键、面板显隐、配置变更），
 * 没有任何一个窗口需要「同时」知道对方的 DOM。
 */
const isPanel = currentWindowLabel() === 'main';

export function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // 抓屏画布只属于覆盖层窗口；面板窗口没有 canvas 也不需要。
  const [desktop, setDesktop] = useState<ScreenFrame | null>(null);

  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  // 原生模式启动不弹面板：纯托盘常驻，靠全局热键 / 托盘菜单唤起。
  // 浏览器原型没有托盘，仍保持开箱即见，避免开发调试要多点一次桌面图标。
  const [showMain, setShowMain] = useState(!native);
  const [trayMenu, setTrayMenu] = useState(false);
  const [overlay, setOverlay] = useState<{ mode: 'shot' | 'long' } | null>(null);
  /** 覆盖层窗口的**抓屏画面是否已就绪**。false 时窗口保持隐藏，避免先闪一个空的全屏层。 */
  const [frameReady, setFrameReady] = useState(false);
  /**
   * 抓屏准备期：窗口已显示但**内容为空**（无 canvas 图像、无覆盖层 DOM）。
   *
   * 靠的就是「全透明 layered 窗口不参与桌面合成」——它待在屏幕上，`BitBlt` 抓到的
   * 仍是它后面的桌面。这样窗口全程可见，不必「先藏后显」，也就没有那一下闪烁。
   */
  const [preparing, setPreparing] = useState(false);
  const [results, setResults] = useState<ResultItem[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef(0);

  /** 配置加载完成前不回写，避免用默认值覆盖磁盘上的旧配置 */
  const settingsReady = useRef(!native);

  /**
   * 统一提示条的位置是「屏幕底部居中」，那是 overlay 窗口（全屏）的地盘。
   * 面板窗口没有 toast 的 UI，若让它自己 setToast，用户在面板里点开关会**看不到任何反馈**。
   * 所以面板侧一律广播给 overlay 窗口显示 —— 位置与拆窗前完全一致。
   */
  const showToast = useCallback(
    (msg: string) => {
      if (isPanel) {
        if (native) void emit('toast', msg);
        return;
      }
      setToast(msg);
      window.clearTimeout(toastTimer.current);
      toastTimer.current = window.setTimeout(() => setToast(null), 2600);
    },
    [isPanel]
  );

  /* ---------- 面板窗口广播过来的提示条 ---------- */
  useEffect(() => {
    if (!native || isPanel) return;
    let un: (() => void) | null = null;
    let disposed = false;
    void listen<string>('toast', (e) => {
      if (disposed) return;
      setToast(String(e.payload ?? ''));
      window.clearTimeout(toastTimer.current);
      toastTimer.current = window.setTimeout(() => setToast(null), 2600);
    }).then((u) => {
      if (disposed) u();
      else un = u;
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, [isPanel]);

  /* ---------- 启动时读取已保存配置 ---------- */
  const reloadSettings = useCallback(() => {
    if (!native) return;
    void NativeBridge.loadSettings().then((saved) => {
      if (saved) {
        setSettings({ ...DEFAULT_SETTINGS, ...saved, hotkeys: { ...DEFAULT_SETTINGS.hotkeys, ...saved.hotkeys } });
      }
      settingsReady.current = true;
    });
  }, []);

  useEffect(() => {
    reloadSettings();
  }, [reloadSettings]);

  /* ---------- 跨窗口：配置变更广播 ----------
     只有面板窗口会改配置（设置 UI 在它身上），落盘后广播一次，
     覆盖层窗口据此刷新托盘菜单里显示的快捷键。频率极低，直接重读 store 即可。 */
  useEffect(() => {
    if (!native) return;
    let un: (() => void) | null = null;
    if (isPanel) {
      void listen('settings-changed', () => reloadSettings()).then((u) => {
        un = u;
      });
    }
    return () => {
      un?.();
    };
  }, [isPanel, reloadSettings]);

  /* ---------- 自动同步配置至 Rust 后端（快捷键 + 持久化） ---------- */
  useEffect(() => {
    if (!native || !settingsReady.current) return;
    void NativeBridge.syncHotkeys(settings.hotkeys, settings.hotkeysEnabled);
    void NativeBridge.saveSettings(settings).then(() => {
      if (isPanel) void emit('settings-changed');
    });
  }, [settings, isPanel]);

  /** 托盘事件回调里读到的最新配置（事件订阅不依赖 settings，避免每次改动都重订阅） */
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  /** 同理：事件回调里读到的最新面板显隐状态（截图前后要还原它） */
  const showMainRef = useRef(showMain);
  showMainRef.current = showMain;

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

  /* ---------- 定期同步「参与鼠标穿透切换」的矩形（仅覆盖层窗口：贴图 / 托盘菜单） ---------- */
  useEffect(() => {
    if (!native || isPanel) return;
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
  }, [isPanel]);

  /* ---------- 初始化桌面（仅覆盖层窗口需要真实抓帧画布） ---------- */
  useEffect(() => {
    if (isPanel) return;
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
  }, [isPanel]);

  /* ---------- 启动截图：覆盖层窗口先藏起自己抓一帧真实屏幕，再铺到覆盖层 ---------- */
  const startOverlay = useCallback(
    (mode: 'shot' | 'long') => {
      if (overlay || hotkeyCapture.active) return;
      if (isPanel) {
        // 面板窗口不承载覆盖层：直接广播，由 overlay 窗口接手。
        if (native) void emit('action', mode);
        return;
      }
      setTrayMenu(false);
      setFrameReady(false);
      if (!native) {
        setOverlay({ mode });
        setFrameReady(true);
        return;
      }
      // **先清空**。这一步必须在窗口显示之前完成：只要残留了上一帧图像或挂着的
      // 覆盖层 DOM（45% 黑遮罩），BitBlt 就会把它们一起拍进去。
      setOverlay(null);
      desktop?.setScreenImage(null);
      desktop?.setEraseRect(null);
      if (desktop) desktop.setWindows([]);
      // 置位 `preparing`：让 hasContent 为真，窗口先在**空内容**状态下显示出来。
      setPreparing(true);
      void (async () => {
        try {
          // **不主动弹出面板。**
          //
          // 「允许截取拾屏自身」指的是「若面板此刻开着，就把它一起拍进去」，
          // 而**不是**「为了拍它而先把面板叫出来」。托盘常驻下面板常态是隐藏的，
          // 若在这里广播 'show' 强行弹出，用户在后台按一次热键就被面板糊一脸 ——
          // 大多数时候他根本不想要这个。需要截自身时，自己先把面板打开再截图。
          //
          // 抓屏前再等一帧：等覆盖层窗口真正上屏、且 WebView2 提交完那帧空白，
          // 此刻它才是「全透明且稳定」的，BitBlt 才能可靠穿透过去。
          await nextPaint();
          const bmp = await NativeBridge.grabScreen(settings.captureSelf);
          if (desktop) {
            desktop.setWindows(
              (await NativeBridge.listWindows()).map<DetectRegion>((w) => ({ x: w.x, y: w.y, w: w.w, h: w.h, name: w.title }))
            );
          }
          setOverlay({ mode });
          desktop?.setScreenImage(bmp);
          // 画面已提交上屏，再让用户看见（窗口全程可见，视觉上是连续过渡）。
          await nextPaint();
          setPreparing(false);
          setFrameReady(true);
        } catch (err) {
          setPreparing(false);
          setOverlay(null);
          setFrameReady(true);
          showToast(`抓取屏幕失败：${String(err)}`);
          // 失败路径同样要让面板收起来，否则它会停在「grab_screen 已藏窗、
          // 但 showMain 还是 true」的不一致状态里，之后托盘唤不回来。
          if (native) void emit('action', 'overlay-end');
        }
      })();
    },
    [overlay, desktop, showToast, isPanel, settings.captureSelf]
  );

  const closeOverlay = useCallback(() => {
    desktop?.setEraseRect(null);
    desktop?.setScreenImage(null);
    if (desktop) desktop.setWindows([]);
    setOverlay(null);
    // 截图是「用完即走」的临时态，结束就回到桌面（覆盖层窗口 hasContent 变 false →
    // 整窗隐藏，键盘焦点由 Rust end_overlay 交还给下层窗口）。配置面板仍可从托盘唤起。
    if (native) void NativeBridge.endOverlay();
    // 通知面板窗口收起来。注意**不能**反过来在 startOverlay 一开始就 emit 让面板关闭：
    // 抓屏期间面板必须留在屏上，「允许截取拾屏自身」才截得到它。
    // Rust 的 grab_screen 只在 capture_self == false 时藏面板。
    if (native) void emit('action', 'overlay-end');
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

  /* ---------- 打开配置面板（面板窗口自己显示自己；覆盖层窗口广播过去） ---------- */
  const openPanel = useCallback(() => {
    setTrayMenu(false);
    if (isPanel) {
      setShowMain(true);
    } else if (native) {
      void emit('action', 'show');
    }
  }, [isPanel]);

  /**
   * 截图**之前**面板是不是开着的。
   *
   * 面板不能在截图一开始就关 —— 开着面板截一张含拾屏界面的图正是 `capture_self` 的用途。
   * 但 Rust 的 `grab_screen` 在 `capture_self == false` 时会把面板藏掉，而 React 的
   * `showMain` 仍是 true，于是 `hasContent` 不变化、那个 effect 不会重跑，没人把它放回来。
   * 所以这里记一份「截图前的原状」，等 `overlay-end` 再连同显隐一起恢复。
   */
  const panelWasOpen = useRef(false);

  /* ---------- 原生模式：订阅 Rust 侧全局热键 / 托盘事件 ---------- */
  useEffect(() => {
    if (!native) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void NativeBridge.onNativeAction((action) => {
      if (disposed) return;
      // 每个窗口只解读与自己相关的动作：`emit` 是全局广播，两边都会收到。
      if (action === 'shot' || action === 'long' || action === 'pin') {
        if (isPanel) {
          if (action !== 'pin') panelWasOpen.current = showMainRef.current;
          return;
        }
        if (action === 'pin') pinLast();
        else startOverlay(action);
      } else if (action === 'show') {
        // 面板窗口负责真正显示；覆盖层窗口只需要关掉托盘菜单。
        if (isPanel) setShowMain(true);
        else setTrayMenu(false);
      } else if (action === 'overlay-end') {
        if (!isPanel) return;
        setShowMain(panelWasOpen.current);
        // 显式 show，不能只靠 setShowMain：原值可能就是 true（面板没关过），
        // 那样 hasContent 不变、effect 不跑，Rust 藏起来的窗口就再也回不来。
        if (panelWasOpen.current) void NativeBridge.setWindowVisible(true);
      } else if (action === 'toggle_hotkeys') {
        if (isPanel) toggleHotkeys();
        else showToast('全局快捷键开关在配置面板里');
      }
    }).then((u) => {
      if (disposed) u();
      else unlisten = u;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [startOverlay, pinLast, toggleHotkeys, showToast, isPanel]);

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
  }, [native, overlay, startOverlay, pinLast, settings.hotkeys, settings.hotkeysEnabled]);

  /* ---------- 空闲时隐藏窗口 ----------
     两个窗口各算各的：面板窗口只看「有没有面板」，覆盖层窗口看「有没有覆盖层 /
     贴图 / 提示条 / 托盘菜单」。全都为空时把 HWND 藏掉，托盘常驻期间不占顶层窗口位，
     Rust 侧 60Hz 穿透轮询也会因窗口不可见而自动休眠。
     贴图与提示条必须计入覆盖层：截图结束（Esc / 完成）后不再回主面板，
     窗口只靠提示条再亮 2.6s，让「已复制到剪贴板 · 1024×768」这类回执仍然可见。

     覆盖层那一项额外计入 `preparing`：抓屏准备期窗口**必须已经可见且是全透明的**，
     靠「分层透明窗口不参与合成」让 `BitBlt` 穿透它。若此时把窗口藏起来、抓完再显示，
     就会多出一次「整块全屏层的显隐」——那正是闪烁的来源。 */
  const hasContent = isPanel
    ? showMain
    : preparing || (!!overlay && frameReady) || results.length > 0 || !!toast || trayMenu;
  useEffect(() => {
    if (!native) return;
    void NativeBridge.setWindowVisible(hasContent);
  }, [hasContent, native]);

  /* ---------- 面板窗口：标记 html 为不透明底（与 Rust 注入、内联脚本三路互为兜底） ---------- */
  useEffect(() => {
    if (!isPanel) return;
    document.documentElement.setAttribute('data-win', 'main');
    document.body.style.background = 'var(--bg)';
  }, [isPanel]);

  /* ---------- 面板窗口：首帧绘制完成后上报，供抓屏做条件等待 ----------
     双 rAF：第一帧执行时 DOM 已提交，但浏览器往往还没把它真正合成上屏；
     第二帧回调时，屏幕像素才是最新的。 */
  useEffect(() => {
    if (!native || !isPanel) return;
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => void NativeBridge.markPanelPainted());
    });
    return () => cancelAnimationFrame(id);
  }, [isPanel]);

  /* ================= 面板窗口：只渲染配置面板 ================= */
  if (isPanel) {
    // 注意：这里**不能**有 onMouseDown={stopPropagation}。它在冒泡阶段掐断 Tauri 对
    // `data-tauri-drag-region` 的原生拖拽探测，表现为标题栏拖不动。它原本存在只为
    // 「点面板时别关掉托盘菜单」，而托盘菜单现在住在 overlay 窗口，理由已不成立。
    //
    // 根节点必须自带不透明底色：窗口已是 transparent:false + 无 WS_EX_LAYERED，
    // 而 body 恒为 transparent（overlay 窗口需要），这里不铺满就会露黑。
    return (
      <div className="panel-root">
        {showMain && (
          <MainWindow
            settings={settings}
            onChange={setSettings}
            onClose={() => setShowMain(false)}
            onShot={() => startOverlay('shot')}
            onLong={() => startOverlay('long')}
            onToast={showToast}
          />
        )}
      </div>
    );
  }

  /* ================= 覆盖层窗口：抓屏画布 / 覆盖层 / 贴图 / 托盘菜单 / 提示条 ================= */
  return (
    <div
      className="overlay-root"
      onMouseDown={() => setTrayMenu(false)}
    >
      {/* 桌面 / 真实屏幕抓帧画布（原生空闲态隐藏，让窗口对鼠标完全穿透） */}
      <canvas ref={canvasRef} className="capture-canvas" style={{ display: overlay ? 'block' : 'none' }} />

      {/* 托盘菜单（原生由真实托盘图标事件唤起）—— `preparing` 期间同样不渲染 */}
      {desktop && trayMenu && !overlay && !preparing && (
        <div
          className="tray-menu"
          data-region="tray"
          style={{ right: 16, bottom: 64 }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="tray-head">
            <AppLogo size={16} /> {APP_NAME} {APP_VERSION}
          </div>
          <div className="tray-sep" />
          {[
            { icon: <Crop size={15} />, label: '截图', kbd: settings.hotkeys.shot, onClick: () => startOverlay('shot') },
            { icon: <ScrollText size={15} />, label: '长截图', kbd: settings.hotkeys.long, onClick: () => startOverlay('long') },
            { icon: <Pin size={15} />, label: '贴图', kbd: settings.hotkeys.pin, onClick: pinLast },
          ].map((m) => (
            <button key={m.label} type="button" onClick={m.onClick} className="tray-item">
              <span className="tray-icon">{m.icon}</span>
              <span className="tray-label">{m.label}</span>
              <span className="tray-kbd">{m.kbd}</span>
            </button>
          ))}
          <div className="tray-sep" />
          <button type="button" onClick={openPanel} className="tray-item">
            <Settings2 size={15} className="u-fg2" /> 配置…
          </button>
          <button type="button" onClick={openPanel} className="tray-item">
            <Info size={15} className="u-fg2" /> 关于
          </button>
          <div className="tray-sep" />
          <button
            type="button"
            onClick={() => {
              setTrayMenu(false);
              showToast(`请右键托盘图标退出${APP_NAME}`);
            }}
            className="tray-item"
          >
            <Power size={15} className="u-fg2" /> 退出
          </button>
        </div>
      )}

      {/* 贴图 / 结果窗口 —— `preparing` 期间**必须不渲染**。
          抓屏穿透的前提是整窗 alpha=0：只要有任何一处画了东西（贴图、提示条、菜单），
          `BitBlt` 就会把它一起拍进来，或让「全透明」这个前提不成立。
          状态不清除，抓完自然恢复。 */}
      {desktop && !preparing &&
        results.map((r) => (
          <ResultWindow key={r.id} item={r} dpr={desktop.dpr} onClose={(id) => setResults((prev) => prev.filter((x) => x.id !== id))} onToast={showToast} />
        ))}

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

      {/* 提示 —— 同上，`preparing` 期间不渲染（否则提示条会破坏整窗透明） */}
      {toast && !preparing && (
        <div className="toast" style={{ bottom: 72 }}>
          <AppLogo size={14} />
          {toast}
        </div>
      )}
    </div>
  );
}

export default App;
