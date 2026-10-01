export interface Hotkeys {
  /** 截图 */
  shot: string;
  /** 长截图 */
  long: string;
  /** 贴图（把最近一次截图钉在屏幕上） */
  pin: string;
  /** 各动作是否注册到系统（与总开关 hotkeysEnabled 叠加，任一为假即不注册） */
  shotEnabled: boolean;
  longEnabled: boolean;
  pinEnabled: boolean;
}

export interface Settings {
  /** 全局快捷键，可在设置中修改 */
  hotkeys: Hotkeys;
  /** 全局快捷键总开关：关掉后三组热键全部注销（托盘菜单与配置面板不受影响） */
  hotkeysEnabled: boolean;
  /** 完成后自动复制到剪贴板 */
  autoCopy: boolean;
  /** 鼠标移动时自动识别窗口 */
  detectWindows: boolean;
  /** 显示放大镜 */
  showMagnifier: boolean;
  /** 显示十字准线 */
  showCrosshair: boolean;
  /** 遮罩不透明度 0.2 - 0.8 */
  maskOpacity: number;
  /** 进入长截图后自动开始滚动 */
  longAutoStart: boolean;
  /** 自动滚动速度 */
  longSpeed: 1 | 2 | 3;
  /** 长截图完成后的动作 */
  longResult: 'preview' | 'copy';
  /** 开机自动启动（登录 Windows 后在托盘静默运行） */
  autoStart: boolean;
  /** 允许把拾屏自己的窗口也截进去（关闭时抓屏前先隐藏自己） */
  captureSelf: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  hotkeys: { shot: 'Ctrl+1', long: 'Ctrl+3', pin: 'Ctrl+2', shotEnabled: true, longEnabled: true, pinEnabled: true },
  hotkeysEnabled: true,
  autoStart: false,
  captureSelf: false,
  autoCopy: true,
  detectWindows: true,
  showMagnifier: true,
  showCrosshair: false,
  maskOpacity: 0.45,
  longAutoStart: false,
  longSpeed: 2,
  longResult: 'preview',
};

export interface ResultItem {
  id: string;
  dataUrl: string;
  /** 像素尺寸（设备像素） */
  w: number;
  h: number;
  kind: 'shot' | 'long';
  x: number;
  y: number;
}
