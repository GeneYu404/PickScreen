# AGENTS.md

> AI agent / 协作者的工作守则。**先读这页，再动手改东西。**
> 本文件只放规则；架构说明与设计决策在 [后端方案.md](后端方案.md) 与 [方案对比报告.md](方案对比报告.md)。

## 文档索引

| 想了解 | 看 |
| --- | --- |
| 后端架构、Rust/WebView2 职责划分、踩坑清单、**设计稿与实际代码的差异** | [后端方案.md](后端方案.md) |
| 方案 A（手写 Win32）vs 方案 B（Tauri 官方插件）的量化对比与选型结论 | [方案对比报告.md](方案对比报告.md) |

## 1. 运行时与包管理器

**只用 Bun**（1.4+，Rust 重写版）。

- `bun install` / `bun run dev` / `bun run build` / `bun run tauri dev`
- 锁文件是 `bun.lock`，**不要**生成 / 提交 `package-lock.json`
- 不要主动 `npm install`；Node 24 只在 CI 缺 Bun 时允许降级

## 2. 构建

**只出 exe，不打 NSIS 安装包**（用户明确要求）。用：

```bash
bun run build:exe        # = tauri build --no-bundle
```

产物在 `src-tauri/target/release/pickscreen.exe`。
`bun run tauri build`（不带 `--no-bundle`）会多跑一遍 makensis 产安装包，除非用户明确要安装包，否则不要用。

前端单独构建 `bun run build` 约 6 秒；完整 `build:exe` 约 2 分钟（大部分在 Rust 链接）。

## 3. `src-tauri/target` —— 绝对不能动

它是 **mbx 缓存 symlink**（mode `l----` → `D:\mbx\targets\v1\<hash>`，hash 来自 `Cargo.lock`）。

- ❌ `rm -rf` / `rmdir` / `mkdir` 这个路径
- ❌ 手工删建来"清理"构建产物
- ✅ 损坏时走 `mbx clean && mbx adopt`

## 4. 透明穿透窗口 —— 本项目最容易踩的坑

主窗口**不是普通窗口**，它是一块铺满整块虚拟桌面的透明穿透 webview：

- `main.rs` setup 调 `cover_virtual_desktop()`，把 HWND `SetWindowPos` 到虚拟桌面边界
  （`capture.rs::virtual_desktop_bounds()`，取 `SM_*VIRTUALSCREEN`，多屏包围盒）
- 空闲态写 `WS_EX_TRANSPARENT | WS_EX_LAYERED`，让点击 / 滚轮穿透到真实桌面
- `winapi.rs` 有 60Hz 轮询线程，按鼠标是否落在 `[data-region]` 同步来的交互矩形内动态切换样式

由此产生两条硬性约束：

1. **`body` 必须保持 `background: transparent`。**
   任何不透明底色都会把整块 webview 刷成纯色、盖住用户真实桌面。
   模拟桌面的底色由 `App.tsx` 根节点在 `showSim` 时单独挂 `--desktop`，不要挪到 body。
2. **浮在用户真实屏幕上的色块必须固定，不能跟随主题。**
   判据：**该色块背后是本应用的窗口表面，还是用户的桌面？**
   - 桌面之上 → 固定色（覆盖层 `ACCENT = '#2b6cf0'`、坐标/尺寸读数气泡、放大镜、toast 深色条）
   - 本应用窗口之上 → 可主题化（配置面板、截图工具栏、长截图面板、托盘菜单）

另：托盘菜单用浅色 `bg-acrylic` 是**对的** —— Windows 11 原生右键菜单本身就是浅色亚克力，
那是正常窗口表面，不是穿透层。

## 5. 改动前先核对清单

1. 改到窗口显隐 / 穿透逻辑了吗？→ 见 §3、§4
2. 动了 `data-region` 属性吗？→ **不能删改**。原生鼠标穿透靠前端每 250ms 用
   `querySelectorAll('[data-region]')` 同步矩形给 Rust，丢了会导致整窗不可点或不可穿透
3. 动了 `grab_screen` 的 hide/show 顺序吗？→ 必须**先隐藏 → 抓帧 → 再 show**，
   顺序反了会把自己拍进去（套娃）
4. 改到前端文案了吗？→ `index.html` 的 `<title>` / `<meta description>` 也会被 Vite
   内联进产物，**grep 时别只搜 `src/`**
5. 要删文件吗？→ 先问用户；`rm` 走运行时可恢复删除，不要用永久删除命令

## 6. 验证步骤

```bash
bun run typecheck     # tsc --noEmit，TS 7 比 5 严格
bun run build         # vite build
bun run build:exe     # 仅在需要出 exe 时
```

改到 Rust 时追加：

```bash
cd src-tauri && cargo check
```

**交付前必须查产物**（源码对 ≠ 打进包了）：

```powershell
$d = Get-Content dist\index.html -Raw
$d -match '要确认的文案'      # 确认改动进了产物
```

`index.html`、`src/**` 都会被 Vite singlefile 内联进 `dist/index.html`，直接从产物 grep 最可靠。

## 7. 设计稿 ≠ 实际代码

[后端方案.md](后端方案.md) 第三节是**原始设计稿**（含 `todo!()` 占位），
第六节才记录与实际仓库的差异。单窗口模型、抓屏只用 BitBlt（未启用 WGC）、
`window_detect.rs`/`overlay_win.rs` 已并入 `winapi.rs`、`pin_host.rs` 不存在 ——
按设计稿找文件会找不到。**改代码前先读第六节。**
