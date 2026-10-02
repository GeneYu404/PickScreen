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

### 构建产物统一归档到 `D:\Tool`

打包好的可执行文件**一律放进 `D:\Tool`**，不要留在项目目录里散落：

- `bun run build:exe` 产出后，把 `pickscreen.exe` 复制到 `D:\Tool\`
- 交付给用户的文件是 `D:\Tool\pickscreen.exe`
- `src-tauri/target/release/` 属构建缓存，**不是**交付物

## 3. `src-tauri/target` —— 绝对不能动

它是 **mbx 缓存 symlink**（mode `l----` → `D:\mbx\targets\v1\<hash>`，hash 来自 `Cargo.lock`）。

- ❌ `rm -rf` / `rmdir` / `mkdir` 这个路径
- ❌ 手工删建来"清理"构建产物
- ✅ 损坏时走 `mbx clean && mbx adopt`

## 4. 单例：必须第一个注册

`tauri-plugin-single-instance` 要注册在**所有其它插件之前**。

没有它的话，第二次启动会叠一层铺满虚拟桌面的透明穿透窗，而且**抢不到全局热键**——
`hotkey.rs` 里 `gs.register()` 失败是静默忽略的，用户看到的只是"快捷键突然不灵了"。

第二次启动的回调里**不要裸调 `win.show()`**，要调 `set_window_visible(app, true)`：
它先把 `WS_EX_NOACTIVATE` 钉好再 show。裸 show 走的是 tao 的 `SW_SHOW`，会顺手激活窗口，
而这块 webview 铺满整块虚拟桌面 —— 抢到前台后用户按键会落进透明窗口。
show 之后再 `emit("action", "show")`，与托盘菜单复用同一条通道（前端已处理该 action）。

## 5. Git

本仓库是 git 仓库，分支 `main`，**目前没有配置远端**（仅本地版本管理）。
提交身份用已配置的全局值 `GeneYu <61930645+GeneYu404@users.noreply.github.com>`，不要写死别的。

**commit**：

- 消息格式 `<scope>: <一句话>`，例：`fix:` / `feat:` / `docs:` / `chore:`
- 用户没明确要求就**不要 commit / push**；建仓库、改代码都不等于授权提交
- 要删文件先问用户；`rm` 走运行时可恢复删除（`mavis-trash`），不要用永久删除命令

**`src-tauri/target` 绝不能进版本库。** `.gitignore` 里那条规则**不能带尾斜杠**：

| 规则 | 结果 |
| --- | --- |
| `src-tauri/target/`（带斜杠） | ❌ 尾斜杠只匹配目录，git 看到的是 symlink，**规则失效** |
| `src-tauri/target`（无斜杠） | ✅ 正确忽略 |

一旦失效，target 会被当 `120000` 条目提交，克隆到别的机器就是指向
`D:\mbx\...` 的死链，**本地完全看不出来**。所以暂存后必须自查：

```bash
git ls-files -s | Select-String '120000'   # 必须无输出
git check-ignore -v src-tauri/target       # 必须命中 .gitignore
```

**换行符**：`index.html`（根）与 `.gitattributes` 由 git 按 `* text=auto eol=lf` 处理，
索引里恒为 LF。**不要改成 `eol=crlf`** —— 那会把 CRLF 写死进规则，
macOS/Linux 克隆也会被污染成 CRLF。本仓库没有任何 `.bat`/`.cmd`/`.ps1`/`.sh`，
Windows 上用 LF 无兼容问题，无需改成 CRLF。

**远端**：用户当前未要求配置。将来要加 remote 或 push，先问；
force push 默认禁止，且只能用 `--force-with-lease`，绝不能 `--force`。

## 6. 透明穿透窗口 —— 本项目最容易踩的坑

主窗口**不是普通窗口**，它是一块铺满整块虚拟桌面的透明穿透 webview：

- `main.rs` setup 调 `cover_virtual_desktop()`，把 HWND `SetWindowPos` 到虚拟桌面边界
  （`capture.rs::virtual_desktop_bounds()`，取 `SM_*VIRTUALSCREEN`，多屏包围盒）
- 空闲态写 `WS_EX_TRANSPARENT | WS_EX_LAYERED`，让点击 / 滚轮穿透到真实桌面
- `winapi.rs` 有 60Hz 轮询线程，按鼠标是否落在 `[data-region]` 同步来的交互矩形内动态切换样式

由此产生两条硬性约束：

1. **`body` 必须保持 `background: transparent`。**
   任何不透明底色都会把整块 webview 刷成纯色、盖住用户真实桌面。
   （模拟桌面已删除，不再有「谁负责给 body 上色」的问题——body 恒为透明。）
2. **浮在用户真实屏幕上的色块必须固定，不能跟随主题。**
   判据：**该色块背后是本应用的窗口表面，还是用户的桌面？**
   - 桌面之上 → 固定色（覆盖层 `ACCENT = '#2b6cf0'`、坐标/尺寸读数气泡、放大镜、toast 深色条）
   - 本应用窗口之上 → 可主题化（配置面板、截图工具栏、长截图面板、托盘菜单）

另：托盘菜单用浅色 `bg-acrylic` 是**对的** —— Windows 11 原生右键菜单本身就是浅色亚克力，
那是正常窗口表面，不是穿透层。

## 7. webview 只做 UI，不重新实现后端

**Rust 负责所有系统能力，webview 只负责渲染 UI 与用户交互。**
判断新代码该不该写进前端的标准：**它是否需要「操作系统」的知识？**
需要 → 写进 Rust；不需要（纯裁剪 / 取色 / 画标注）→ 才写前端。

前端只允许做这几件纯 canvas 运算（都在 `bridge/desktop.ts`）：

| 允许 | 说明 |
| --- | --- |
| `captureRegion(r)` | 从已抓到的帧里裁一块 |
| `getPixel(x, y)` | 读像素颜色 |
| `setEraseRect(r)` | 长截图时把选区擦成透明 |
| `hitTest` / `detectRegions` | 遍历 **Rust `list_windows` 给的**真实窗口矩形 |

已从前端删除、**不要以任何形式加回来**的东西：

- ❌ `sim/desktop.ts` 模拟的 Windows 桌面（壁纸 / 任务栏 / 假 Edge 长文 / 假记事本）
- ❌ `utils/stitch.ts` 的 TypeScript 拼接器 —— 拼接只在 Rust `stitch.rs` 里
- ❌ `utils/capture.ts` 的 getDisplayMedia 降级
- ❌ 任何 `if (native) { Rust } else { JS 重新实现 }` 的双路径写法

Rust 已提供对应命令，不要在前端另写一套：
`grab_screen` / `list_windows` / `scroll_region` / `long_begin` / `long_push` /
`long_preview` / `long_finish` / `long_cancel` / `copy_png` / `save_png`。

`bridge/desktop.ts` 的 no-op 降级是**结构自带**的，不靠 `isTauriEnv()` 分支：
浏览器下没人调 `setScreenImage`，画布自然保持透明，`detectRegions()` 自然退化成「全屏」。

> 代价：浏览器预览只能展示设置面板等 UI，**无法演示截图功能**（没有画面可截）。这是有意接受的。

## 8. 改动前先核对清单

1. 改到窗口显隐 / 穿透逻辑了吗？→ 见 §3、§5
2. 动了 `data-region` 属性吗？→ **不能删改**。原生鼠标穿透靠前端每 250ms 用
   `querySelectorAll('[data-region]')` 同步矩形给 Rust，丢了会导致整窗不可点或不可穿透
3. 动了 `grab_screen` 的 hide/show 顺序吗？→ 必须**先隐藏 → 抓帧 → 再 show**，
   顺序反了会把自己拍进去（套娃）。且「隐藏」要**当场生效**：tao 的 `hide()` 只是
   `PostMessage`，必须再在 HWND 上直接 `ShowWindow`（`winapi::set_shown`），
   并在 BitBlt 前 `DwmFlush()` 等 DWM 合成完 —— 否则抓到上一帧（覆盖层 45% 黑遮罩），
   表现是整屏「雾蒙蒙」。详见 [后端方案.md](后端方案.md) §6.7
4. 动过 `set_window_visible(true)` 吗？→ 必须**先写 `WS_EX_NOACTIVATE` 再 show**：
   tao 用 `SW_SHOW` 会激活这块铺满虚拟桌面的透明 webview，用户的按键会落进来
5. 改到前端文案了吗？→ `index.html` 的 `<title>` / `<meta description>` 也会被 Vite
   内联进产物，**grep 时别只搜 `src/`**
6. 新逻辑该写前端还是 Rust？→ 见 §6。**先问「它是否需要操作系统的知识」**，
   需要就写 Rust。前端只做纯 canvas 运算
7. 要暂存/提交吗？→ 见 §4，先确认 `git ls-files -s` 里没有 `120000`
8. 要删文件吗？→ 先问用户；`rm` 走运行时可恢复删除，不要用永久删除命令

## 9. 验证步骤

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

## 10. 设计稿 ≠ 实际代码

[后端方案.md](后端方案.md) 第三节是**原始设计稿**（含 `todo!()` 占位），
第六节才记录与实际仓库的差异。单窗口模型、抓屏只用 BitBlt（未启用 WGC）、
`window_detect.rs`/`overlay_win.rs` 已并入 `winapi.rs`、`pin_host.rs` 不存在 ——
按设计稿找文件会找不到。**改代码前先读第六节。**
