import React, { useEffect, useRef, useState } from 'react';
import { Settings2, Crop, ScrollText, Keyboard, Info, X, Minus, Pin } from 'lucide-react';
import type { Settings, Hotkeys, OverlayAction } from '../types';
import { comboFromEvent, hotkeyCapture } from '../utils/hotkey';
import { viewportCss, NativeBridge } from '../bridge/tauri';
import { APP_NAME, APP_NAME_EN, APP_VERSION } from '../brand';
import { Kbd, Segmented, Slider, Toggle as ToggleSwitch } from './ui/Controls';

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
  onClose: () => void;
  onShot: () => void;
  onLong: () => void;
}

type Tab = 'general' | 'shot' | 'long' | 'keys' | 'about';
/** 三个可绑定组合键的动作 —— 不要用 `keyof Hotkeys`，那会把 *Enabled 布尔字段也算进来 */
type Field = 'shot' | 'long' | 'pin';

/** 应用 Logo：青蓝渐变圆角方块 + 取景角标 + 中心画面 */
export const AppLogo: React.FC<{ size?: number }> = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 32 32">
    <defs>
      <linearGradient id="app-logo-g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#14b8a6" />
        <stop offset="1" stopColor="#2563eb" />
      </linearGradient>
    </defs>
    <rect x="1" y="1" width="30" height="30" rx="8" fill="url(#app-logo-g)" />
    <path
      d="M9 13V10a1 1 0 0 1 1-1h3M19 9h3a1 1 0 0 1 1 1v3M23 19v3a1 1 0 0 1-1 1h-3M13 23h-3a1 1 0 0 1-1-1v-3"
      fill="none"
      stroke="#fff"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <rect x="13" y="12.5" width="6" height="7" rx="1.5" fill="#fff" />
  </svg>
);

/** 开关：转接共享 Toggle（on → checked），保持既有调用点不变 */
const Toggle: React.FC<{ on: boolean; onChange?: (v: boolean) => void; disabled?: boolean }> = ({ on, onChange, disabled }) => (
  <ToggleSwitch checked={on} onChange={(v) => onChange?.(v)} disabled={disabled} />
);

const Row: React.FC<{ title: string; desc?: string; children: React.ReactNode }> = ({ title, desc, children }) => (
  <div className="flex items-center justify-between gap-6 px-4 py-3 bg-card border border-stroke rounded-lg">
    <div className="min-w-0">
      <div className="text-[13px] text-fg">{title}</div>
      {desc && <div className="text-[11.5px] text-fg2 mt-0.5">{desc}</div>}
    </div>
    {children}
  </div>
);

/** 行末「清除」：把该行快捷键置空 = 不绑定任何按键 */
const ClearButton: React.FC<{ label: string; combo: string; onClear: () => void }> = ({ label, combo, onClear }) => (
  <button
    type="button"
    disabled={!combo}
    onClick={onClear}
    title={combo ? `清除「${label}」的快捷键（置为未设置，不再绑定）` : '该行已是未设置'}
    className="h-6 rounded px-2 text-[11.5px] text-fg2 transition-colors hover:bg-subtle hover:text-fg disabled:pointer-events-none disabled:opacity-30 cursor-pointer"
  >
    清除
  </button>
);

/** 组合键展示：Ctrl + 1 拆成两个键帽 */
const Combo: React.FC<{ combo: string }> = ({ combo }) =>
  combo ? (
    <span className="inline-flex items-center gap-1">
      {combo.split('+').map((k, i) => (
        <Kbd key={`${k}-${i}`}>{k}</Kbd>
      ))}
    </span>
  ) : (
    <span className="text-[11px] text-fg3">未设置</span>
  );

/** 可修改的快捷键：点击后按下新的组合键即可替换，Backspace 清除，Esc 取消 */
const HotkeyField: React.FC<{ value: string; onChange: (v: string) => void; disabled?: boolean }> = ({ value, onChange, disabled }) => {
  const [listening, setListening] = useState(false);

  useEffect(() => {
    if (!listening) return;
    hotkeyCapture.setPaused(true);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setListening(false);
        return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        onChange('');
        setListening(false);
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) return; // 只按下了修饰键，继续等待
      onChange(combo);
      setListening(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      hotkeyCapture.setPaused(false);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [listening, onChange]);

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => setListening(true)}
      className={`h-7 min-w-[132px] px-2.5 rounded-md border text-[12px] flex items-center justify-center transition-colors ${
        disabled
          ? 'border-stroke bg-card text-fg3 cursor-not-allowed'
          : listening
            ? 'border-accent bg-accent-soft text-accent animate-pulse cursor-pointer'
            : 'border-stroke-strong bg-card text-fg hover:bg-card-hover cursor-pointer'
      }`}
      title={disabled ? '全局快捷键已关闭，先打开上方总开关' : '点击后按下新的组合键 · Backspace 清除 · Esc 取消'}
    >
      {listening ? (
        <span className="font-medium">请按新组合键…</span>
      ) : (
        <Combo combo={value} />
      )}
    </button>
  );
};

export function MainWindow({ settings, onChange, onClose, onShot, onLong }: Props) {
  const [tab, setTab] = useState<Tab>('general');
  /** 自启动开关的「写系统」中转态：写失败时回滚设置并提示 */
  const [autoStartBusy, setAutoStartBusy] = useState(false);
  const WIN_W = 820;
  const WIN_H = 560;
  const [pos, setPos] = useState({
    x: Math.max(8, (window.innerWidth - WIN_W) / 2),
    y: Math.max(8, (window.innerHeight - WIN_H) / 2 - 24),
  });
  const [size, setSize] = useState({ w: WIN_W, h: WIN_H });
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  /* 视口变化（含 DPI / 远程会话缩放变化）后把面板重新收进可视区：
     初始居中值可能算自旧视口，尺寸/位置都会随 resize 校正，避免面板被裁出屏幕 */
  useEffect(() => {
    const fit = () => {
      // viewportCss = OS 物理尺寸/dpr 的真值：WebView2 布局口径说谎时仍能正确收拢
      void viewportCss().then(({ w: iw, h: ih }) => {
        const w = Math.min(WIN_W, Math.max(240, iw - 16));
        const h = Math.min(WIN_H, Math.max(200, ih - 16));
        setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
        setPos((p) => {
          const x = Math.max(8, Math.min(p.x, iw - w - 8));
          const y = Math.max(8, Math.min(p.y, ih - h - 8));
          return x === p.x && y === p.y ? p : { x, y };
        });
      });
    };
    fit();
    window.addEventListener('resize', fit);
    // WebView2 在 DPI / 远程会话缩放切换时可能漏发 resize，轮询兜底校正
    const id = window.setInterval(fit, 400);
    return () => {
      window.removeEventListener('resize', fit);
      window.clearInterval(id);
    };
  }, []);

  /**
   * 自启动开关的初始值以**系统真实状态**为准，而不是 settings 里的缓存：
   * 用户可能在「任务管理器 → 启动」里手动改过，缓存会撒谎。
   */
  useEffect(() => {
    let alive = true;
    void NativeBridge.isAutoStartEnabled().then((real) => {
      if (!alive) return;
      if (real !== settings.autoStart) onChange({ ...settings, autoStart: real });
    });
    return () => {
      alive = false;
    };
    // 仅在挂载时读一次；后续由 toggleAutoStart 写系统后自行维持
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragRef.current) return;
      setPos({
        x: Math.max(-WIN_W + 120, Math.min(window.innerWidth - 120, e.clientX - dragRef.current.dx)),
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
  }, []);

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => onChange({ ...settings, [k]: v });

  /** 修改快捷键；与其它动作冲突时互换，保证始终唯一 */
  const changeHotkey = (field: Field, combo: string) => {
    const hk = settings.hotkeys;
    const next: Hotkeys = { ...hk };
    const conflict = (['shot', 'long', 'pin'] as Field[]).find((k) => k !== field && combo && hk[k] === combo);
    if (conflict) next[conflict] = hk[field];
    next[field] = combo;
    onChange({ ...settings, hotkeys: next });
  };

  /** 修改覆盖层内的动作键（截图界面用），支持清空 */
  const changeOverlayKey = (action: OverlayAction, combo: string) => {
    onChange({ ...settings, overlayKeys: { ...settings.overlayKeys, [action]: combo } });
  };

  /** 开启 / 关闭开机自启动：真正写入 HKCU\...\CurrentVersion\Run（官方插件）。
   * 失败时把设置回滚，避免 UI 显示「已开启」而系统里其实没有。
   */
  const toggleAutoStart = async () => {
    const next = !settings.autoStart;
    const prev = settings.autoStart;
    onChange({ ...settings, autoStart: next });
    setAutoStartBusy(true);
    try {
      await NativeBridge.setAutoStart(next);
    } catch {
      onChange({ ...settings, autoStart: prev });
      setTab('general');
    } finally {
      setAutoStartBusy(false);
    }
  };

  const NAV: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'general', label: '通用', icon: <Settings2 size={16} /> },
    { id: 'shot', label: '截图', icon: <Crop size={16} /> },
    { id: 'long', label: '长截图', icon: <ScrollText size={16} /> },
    { id: 'keys', label: '快捷键 / 动作', icon: <Keyboard size={16} /> },
    { id: 'about', label: '关于', icon: <Info size={16} /> },
  ];

  return (
    <div
      className="absolute z-40 flex flex-col bg-app rounded-lg overflow-hidden border border-stroke-strong shadow-window animate-panel-in"
      data-region="panel"
      style={{ left: pos.x, top: pos.y, width: size.w, height: size.h }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* 标题栏 */}
      <div
        className="h-10 flex items-center justify-between pl-3 bg-card border-b border-stroke shrink-0 cursor-default"
        onMouseDown={(e) => {
          dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
        }}
      >
        <div className="flex items-center gap-2">
          <AppLogo size={18} />
          <span className="text-[13px] font-semibold text-fg">{APP_NAME}</span>
          <span className="text-[11px] text-fg3">{APP_VERSION}</span>
        </div>
        <div className="flex h-full" onMouseDown={(e) => e.stopPropagation()}>
          <button type="button" onClick={onClose} className="w-11 h-full flex items-center justify-center text-fg hover:bg-subtle cursor-pointer" title="最小化到托盘">
            <Minus size={14} />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="w-11 h-full flex items-center justify-center text-fg hover:bg-danger hover:text-white cursor-pointer"
            title={`关闭（${APP_NAME}将继续在托盘运行）`}
          >
            <X size={15} />
          </button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* 左侧导航 */}
        <div className="w-[168px] shrink-0 border-r border-stroke py-3 px-2 flex flex-col gap-0.5">
          {NAV.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => setTab(n.id)}
              className={`relative h-9 px-3 rounded-md flex items-center gap-2.5 text-[13px] cursor-pointer transition-colors ${
                tab === n.id ? 'bg-card text-accent font-medium' : 'text-fg hover:bg-subtle'
              }`}
            >
              {tab === n.id && <span className="absolute left-0 top-2.5 bottom-2.5 w-[3px] rounded-full bg-accent" />}
              {n.icon}
              {n.label}
            </button>
          ))}
          <div className="flex-1" />
          <div className="px-3 text-[11px] text-fg3 leading-5">
            正在托盘运行
            <br />
            {settings.hotkeysEnabled ? (
              <>
                按 <Kbd>{settings.hotkeys.shot || '未设置'}</Kbd> 截图
              </>
            ) : (
              '全局快捷键已关闭'
            )}
          </div>
        </div>

        {/* 右侧内容 */}
        <div className="flex-1 min-w-0 overflow-y-auto win-scroll p-5 space-y-3">
          {tab === 'general' && (
            <>
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-card border border-stroke rounded-lg p-4 flex flex-col">
                  <div className="flex items-center justify-between">
                    <div className="w-9 h-9 rounded-lg bg-shot-soft text-shot flex items-center justify-center">
                      <Crop size={18} />
                    </div>
                    <Combo combo={settings.hotkeys.shot} />
                  </div>
                  <div className="mt-3 text-[14px] font-semibold text-fg">截图</div>
                  <div className="mt-1 text-[12px] text-fg2 leading-5 flex-1">框选任意区域或点击自动识别的窗口，支持矩形、箭头、文字、马赛克等标注。</div>
                  <button type="button" onClick={onShot} className="mt-3 h-8 rounded-md bg-accent hover:bg-accent-hover text-on-accent text-[12.5px] cursor-pointer transition-colors">
                    立即截图
                  </button>
                </div>
                <div className="bg-card border border-stroke rounded-lg p-4 flex flex-col">
                  <div className="flex items-center justify-between">
                    <div className="w-9 h-9 rounded-lg bg-long-soft text-long flex items-center justify-center">
                      <ScrollText size={18} />
                    </div>
                    <Combo combo={settings.hotkeys.long} />
                  </div>
                  <div className="mt-3 text-[14px] font-semibold text-fg">长截图</div>
                  <div className="mt-1 text-[12px] text-fg2 leading-5 flex-1">框选滚动区域后滚动鼠标滚轮，{APP_NAME}会自动识别内容并拼接成一张长图。</div>
                  <button type="button" onClick={onLong} className="mt-3 h-8 rounded-md bg-long text-on-accent hover:brightness-110 text-[12.5px] cursor-pointer transition-colors">
                    开始长截图
                  </button>
                </div>
                <div className="bg-card border border-stroke rounded-lg p-4 flex flex-col">
                  <div className="flex items-center justify-between">
                    <div className="w-9 h-9 rounded-lg bg-pin-soft text-pin flex items-center justify-center">
                      <Pin size={18} />
                    </div>
                    <Combo combo={settings.hotkeys.pin} />
                  </div>
                  <div className="mt-3 text-[14px] font-semibold text-fg">贴图</div>
                  <div className="mt-1 text-[12px] text-fg2 leading-5 flex-1">把最近一次截图钉在屏幕最前，用于对照录入。拖动移动、滚轮缩放、点 ✕ 关闭。</div>
                  <div className="mt-3 h-8 rounded-md border border-stroke-strong bg-layer-solid text-[12.5px] text-fg2 flex items-center justify-center">
                    截图完成后点 📌 贴图
                  </div>
                </div>
              </div>

              <Row title="截图完成后自动复制到剪贴板" desc="点击「完成」或双击选区时，把结果写入剪贴板">
                <Toggle on={settings.autoCopy} onChange={(v) => set('autoCopy', v)} />
              </Row>
              <Row title="开机自动启动" desc="登录 Windows 后在托盘静默运行（写入注册表，无需管理员）">
                <Toggle on={settings.autoStart} disabled={autoStartBusy} onChange={() => void toggleAutoStart()} />
              </Row>
              <Row title="允许截取拾屏自身" desc="开启后截图里会包含本软件的面板；关闭则抓屏前先隐藏自己（默认）">
                <Toggle on={settings.captureSelf} onChange={(v) => set('captureSelf', v)} />
              </Row>
              <Row title="关闭主窗口时最小化到托盘">
                <Toggle on disabled />
              </Row>
            </>
          )}

          {tab === 'shot' && (
            <>
              <Row title="自动识别窗口" desc="鼠标经过时高亮窗口与内容区域，单击即可截取整个区域">
                <Toggle on={settings.detectWindows} onChange={(v) => set('detectWindows', v)} />
              </Row>
              <Row title="显示放大镜" desc="框选时显示像素级放大镜、坐标与颜色值（按 C 复制颜色）">
                <Toggle on={settings.showMagnifier} onChange={(v) => set('showMagnifier', v)} />
              </Row>
              <Row title="显示十字准线" desc="框选前显示贯穿全屏的辅助线">
                <Toggle on={settings.showCrosshair} onChange={(v) => set('showCrosshair', v)} />
              </Row>
              <Row title="遮罩不透明度" desc="截图时选区以外区域的变暗程度">
                <div className="flex items-center gap-3">
                  <Slider
                    value={settings.maskOpacity}
                    min={0.2}
                    max={0.8}
                    step={0.05}
                    onChange={(v) => set('maskOpacity', v)}
                    className="!w-36"
                    ariaLabel="遮罩不透明度"
                  />
                  <span className="w-9 text-right text-[12px] font-mono text-fg2">{Math.round(settings.maskOpacity * 100)}%</span>
                </div>
              </Row>
              <Row title="双击选区完成截图" desc="与 Enter 键效果相同">
                <Toggle on disabled />
              </Row>
            </>
          )}

          {tab === 'long' && (
            <>
              <Row title="进入长截图后自动开始滚动" desc={`无需手动滚动滚轮，${APP_NAME}逐步滚动并拼接，直到内容底部`}>
                <Toggle on={settings.longAutoStart} onChange={(v) => set('longAutoStart', v)} />
              </Row>
              <Row title="自动滚动速度" desc="速度越慢，拼接越稳定">
                <Segmented
                  value={settings.longSpeed}
                  options={[
                    { value: 1 as const, label: '慢' },
                    { value: 2 as const, label: '中' },
                    { value: 3 as const, label: '快' },
                  ]}
                  onChange={(v) => set('longSpeed', v)}
                />
              </Row>
              <Row title="完成后的动作">
                <Segmented
                  value={settings.longResult}
                  options={[
                    { value: 'preview' as const, label: '显示为贴图' },
                    { value: 'copy' as const, label: '复制到剪贴板' },
                  ]}
                  onChange={(v) => set('longResult', v)}
                />
              </Row>
              <div className="bg-accent-soft border border-stroke rounded-lg px-4 py-3 text-[12px] text-fg2 leading-6">
                <div className="font-medium mb-0.5 text-fg">拼接效果建议</div>
                • 选区尽量大，不要包含滚动条；选区内只包含一个滚动区域
                <br />• 滚动尽量平缓，每次不超过选区高度的 2/3；避开吸顶导航等固定元素
                <br />• 演示桌面中的 Edge 窗口内是一篇可滚动的长文章，可直接用于体验
              </div>
            </>
          )}

          {tab === 'keys' && (
            <>
              <Row title="启用全局快捷键" desc="关闭后下方三组组合键全部注销，托盘菜单与「立即截图」按钮仍可用">
                <Toggle on={settings.hotkeysEnabled} onChange={(v) => set('hotkeysEnabled', v)} />
              </Row>
              <div className="bg-accent-soft border border-stroke rounded-lg px-4 py-2.5 text-[12px] text-fg2">
                两组表格里的按键都能改：点方框后直接按下新组合键，<b>Backspace</b> 清除、<b>Esc</b> 取消；
                也可以点行末「清除」直接置为未设置（等于不绑定）。全局热键若与其它动作冲突会自动交换。
                {!settings.hotkeysEnabled && <b className="text-fg"> 当前总开关已关闭，三组全局热键都不会注册到系统。</b>}
              </div>
              <div className="bg-card border border-stroke rounded-lg overflow-hidden">
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr className="bg-layer text-left text-fg2">
                      <th className="font-medium px-4 py-2.5">动作</th>
                      <th className="font-medium px-4 py-2.5">快捷键</th>
                      <th className="font-medium px-4 py-2.5">范围</th>
                      <th className="font-medium px-4 py-2.5" />
                    </tr>
                  </thead>
                  <tbody className="text-fg">
                    {([
                      ['shot', '截图', settings.hotkeys.shot],
                      ['long', '长截图', settings.hotkeys.long],
                      ['pin', '贴图（最近一次截图）', settings.hotkeys.pin],
                    ] as const).map(([field, label, combo]) => (
                      <tr key={field} className="border-t border-stroke">
                        <td className="px-4 py-2.5">{label}</td>
                        <td className="px-4 py-2.5">
                          <HotkeyField
                            value={combo}
                            onChange={(v) => changeHotkey(field, v)}
                            disabled={!settings.hotkeysEnabled}
                          />
                        </td>
                        <td className="px-4 py-2.5 text-fg3">全局</td>
                        <td className="px-4 py-2.5 text-right">
                          <ClearButton label={label} combo={combo} onClear={() => changeHotkey(field, '')} />
                        </td>
                      </tr>
                    ))}
                    {([
                      ['done', '完成（复制并关闭）', '截图界面'],
                      ['cancel', '取消 / 退出工具', '截图界面'],
                      ['undo', '撤销', '截图界面'],
                      ['redo', '重做', '截图界面'],
                      ['copy', '复制结果到剪贴板', '截图界面'],
                      ['save', '保存为文件', '截图界面'],
                      ['pickColor', '复制当前颜色', '框选前'],
                    ] as [OverlayAction, string, string][]).map(([action, label, scope]) => (
                      <tr key={action} className="border-t border-stroke">
                        <td className="px-4 py-2.5">{label}</td>
                        <td className="px-4 py-2.5">
                          <HotkeyField
                            value={settings.overlayKeys[action]}
                            onChange={(v) => changeOverlayKey(action, v)}
                          />
                        </td>
                        <td className="px-4 py-2.5 text-fg3">{scope}</td>
                        <td className="px-4 py-2.5 text-right">
                          <ClearButton
                            label={label}
                            combo={settings.overlayKeys[action]}
                            onClear={() => changeOverlayKey(action, '')}
                          />
                        </td>
                      </tr>
                    ))}
                    {/* 以下不是按键绑定，无法自定义，保持说明性质 */}
                    {(
                      [
                        ['长截图：完成 / 停止', ['同上「完成 / 取消」'], '长截图模式'],
                        ['完成（另一入口）', ['双击选区'], '截图界面'],
                        ['取消（另一入口）', ['右键'], '截图界面'],
                        ['贴图：关闭', ['点 ✕ 按钮'], '贴图窗口'],
                        ['贴图：缩放 / 移动', ['滚轮 / 拖动'], '贴图窗口'],
                      ] as [string, string[], string][]
                    ).map(([a, keys, scope]) => (
                      <tr key={a} className="border-t border-stroke">
                        <td className="px-4 py-2.5">{a}</td>
                        <td className="px-4 py-2.5 space-x-1.5">
                          {keys.map((k) => (
                            <Kbd key={k}>{k}</Kbd>
                          ))}
                        </td>
                        <td className="px-4 py-2.5 text-fg3">{scope}</td>
                        <td className="px-4 py-2.5" />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {tab === 'about' && (
            <div className="bg-card border border-stroke rounded-lg p-6 flex flex-col items-center text-center">
              <AppLogo size={64} />
              <div className="mt-3 text-[18px] font-semibold text-fg">{APP_NAME}</div>
              <div className="text-[12px] text-fg2">
                {APP_NAME_EN} · {APP_VERSION}
              </div>
              <p className="mt-4 text-[12.5px] text-fg2 leading-6 max-w-[420px]">
                拾屏是一款 Windows 截图工具，围绕「截图」「长截图」「贴图」三项核心功能：
                框选或自动识别窗口截图，支持矩形、箭头、文字、马赛克等标注；
                长截图可自动识别内容并拼接成一张长图；贴图把截图钉在屏幕最前用于对照录入。
              </p>
              <div className="mt-4 text-[11.5px] text-fg3">所有图片仅在本机处理，不上传任何数据。</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
