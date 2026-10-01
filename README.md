# 拾屏 PickScreen

> ⚠️ **本项目由 AI 协助完成，状态不稳定。** 可能存在尚未发现的缺陷，请自行评估使用风险。

> Windows 10 / 11 的截图工具 · **截图** / **长截图** / **贴图**
> Tauri 2 + Rust + React 19 + Tailwind v4，托盘常驻，全局快捷键唤起。

## 功能

| 快捷键 | 功能 | 说明 |
| --- | --- | --- |
| `Ctrl+1` | **截图** | 框选任意区域，或点击自动识别的窗口。支持 7 种标注：矩形、椭圆、箭头、画笔、马克笔、文字、马赛克。框选时带像素级放大镜，十字准线可在设置中开启。 |
| `Ctrl+3` | **长截图** | 框选滚动区域后滚动滚轮，自动识别内容并拼接成一张长图。拼接状态全在 Rust 侧，滚轮通过 `PostMessage` 代理给选区下方的真实窗口。 |
| `Ctrl+2` | **贴图** | 把最近一次截图钉在屏幕最前，用于对照录入。拖动移动、滚轮缩放、悬停后点 ✕ 关闭。 |

快捷键均可在设置中修改，改键时若与其它动作冲突会自动交换。

其它行为：完成后自动复制到剪贴板、悬停显示窗口名与尺寸、多显示器与混合 DPI 下的坐标自适应（WebView2 布局口径异常时自动重下窗口 bounds）。

## 环境要求

- Windows 10 1809+ / Windows 11
- [Bun](https://bun.sh) 1.4+（包管理与脚本运行）
- Rust 1.98+（MSVC 工具链）
- [Tauri 依赖](https://tauri.app/start/prerequisites/)：MSVC Build Tools、WebView2 Runtime（Win11 自带）

## 构建与运行

```bash
bun install

bun run dev          # 前端开发服务器（仅 UI 演示，无法截图，见下）
bun run typecheck    # tsc --noEmit
bun run build:exe    # 产出 src-tauri/target/release/pickscreen.exe
```

**只出 exe，不打 NSIS 安装包**。需要安装包时用 `bun run tauri build`。

> `src-tauri/target` 是 **mbx 编译缓存软链**，不要手工删建，损坏时走 `mbx clean && mbx adopt`。

## 架构要点

这是一个**铺满整块虚拟桌面的透明穿透窗口**，不是普通窗口：

- `main.rs` 启动时把 HWND `SetWindowPos` 到虚拟桌面边界（多屏包围盒，物理像素）
- 空闲态写 `WS_EX_TRANSPARENT | WS_EX_LAYERED`，点击与滚轮直接穿透到真实桌面
- `winapi.rs` 有 60Hz 轮询线程，按鼠标是否落在前端每 250ms 同步来的交互矩形内动态切换样式
- **没有东西要渲染时窗口整体隐藏**，托盘常驻期间不占顶层窗口位，轮询线程随之休眠

**webview 只负责渲染 UI，不重新实现后端。** 抓屏、窗口枚举、滚轮代理、长截图拼接全部在 Rust 侧完成。判断新代码该不该写进前端的唯一标准：*它是否需要「操作系统」的知识？* 需要就写 Rust。

| 前端允许 | 前端禁止 |
| --- | --- |
| 对已抓到的帧做裁剪 / 取色 | 模拟操作系统（桌面、任务栏、假窗口） |
| 画标注 | 重新实现拼接算法 |
| 遍历 Rust 枚举出的真实窗口矩形 | 浏览器端降级实现后端能力 |

> **代价**：浏览器预览只能展示设置面板等 UI，**无法演示截图功能**——没有画面可截。

## 文档

| 文档 | 内容 |
| --- | --- |
| [AGENTS.md](AGENTS.md) | AI 协作者工作守则：构建约定、穿透窗口约束、薄桥红线、Git 规则 |
| [后端方案.md](后端方案.md) | 架构说明、职责划分、踩坑清单，**含设计稿与实际代码的差异** |
| [方案对比报告.md](方案对比报告.md) | 方案 A（手写 Win32）vs 方案 B（Tauri 官方插件）的量化对比与选型结论 |

## 目录结构

```
src/
├── App.tsx                  应用外壳：托盘、热键、窗口显隐、贴图
├── bridge/
│   ├── tauri.ts             IPC 契约（抓屏 / 窗口枚举 / 滚动 / 拼接 / 剪贴板）
│   └── desktop.ts           屏幕帧薄壳：只做纯 canvas 运算
├── components/
│   ├── ScreenshotOverlay.tsx  框选、放大镜、标注工具栏、长截图面板
│   ├── MainWindow.tsx         配置面板（通用 / 截图 / 长截图 / 快捷键 / 关于）
│   ├── ResultWindow.tsx       贴图窗口
│   └── ui/                    Fluent 基础组件（Button / Toggle / Slider / Segmented …）
└── index.css                Windows 11 Fluent 设计令牌（明暗两套）

src-tauri/src/
├── main.rs        入口、命令注册、托盘常驻
├── capture.rs     GDI BitBlt 抓屏 + 虚拟桌面边界
├── stitch.rs      长截图拼接（32 灰度桶行签名 + 截尾均值对齐）
├── winapi.rs      手写 Win32：窗口枚举 / 样式加固 / 60Hz 穿透轮询 / 滚轮代理
├── hotkey.rs      全局热键注册 / 改键 / 录制时挂起
└── tray.rs        托盘图标与菜单
```

## 隐私

所有图片仅在本机处理，不上传任何数据。
