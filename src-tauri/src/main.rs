//! 拾屏 B —— 方案 B：Tauri 官方插件后端
//!
//! 特征：
//! - 全局热键：tauri-plugin-global-shortcut（register / unregister / 回调）
//! - 配置持久化：tauri-plugin-store（前端 JS 直接读写，无 Rust 命令）
//! - 保存路径：tauri-plugin-dialog 系统「另存为」对话框
//! - 剪贴板：tauri-plugin-clipboard-manager
//! - 抓屏 / 穿透 / 滚轮代理 / 拼接与方案 A 共用实现（BitBlt + 手写 Win32，
//!   这部分插件生态没有现成方案，正好体现「插件能覆盖多少」的边界）

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod capture;
mod clipboard;
mod hotkey;
mod png_util;
mod state;
mod stitch;
mod tray;
mod util;
mod winapi;

use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use state::SharedState;
use tauri::Manager;
use windows::Win32::Foundation::HWND;

/* ---------------- 前端入参 ---------------- */

/// copy_png(req: { dataUrl })
#[derive(serde::Deserialize)]
struct CopyReq {
    #[serde(rename = "dataUrl")]
    data_url: String,
}

/// save_png(req: { dataUrl, path })
#[derive(serde::Deserialize)]
struct SaveReq {
    #[serde(rename = "dataUrl")]
    data_url: String,
    path: String,
}

/// 配置面板窗口：正常尺寸（820×560）的可交互窗口，整块可点、点它能获得焦点。
fn panel_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    app.get_webview_window("main")
        .ok_or_else(|| "配置面板窗口不存在".to_string())
}

fn hwnd_of(win: &tauri::WebviewWindow) -> Result<HWND, String> {
    let raw = win.hwnd().map_err(|e| e.to_string())?;
    Ok(HWND(raw.0))
}

/// 两个自有窗口的 HWND：抓屏要避开它们，窗口枚举 / 滚轮代理 / 焦点交还要排除它们。
/// 取不到时填 null 指针 —— 比较 `contains(&hwnd)` 对 null 不会误伤真实窗口。
fn self_hwnds(app: &tauri::AppHandle) -> [HWND; 2] {
    let grab = |label: &str| {
        app.get_webview_window(label)
            .and_then(|w| w.hwnd().ok())
            .map(|raw| HWND(raw.0))
            .unwrap_or(HWND(std::ptr::null_mut()))
    };
    [grab("main"), grab("overlay")]
}

/* ---------------- 命令 ---------------- */

/// 抓取整块虚拟桌面。
///
/// 拆成两个窗口之后，抓屏的不变式收敛成一句：**抓帧那一刻，两个自有窗口都不能挡在
/// 待截桌面前面**。
///
/// - 覆盖层窗口永远要藏：它铺满整块虚拟桌面，一旦可见就整块盖住桌面。
/// - 配置面板窗口由 `capture_self` 决定去留。开启时**根本不用藏** —— 它现在只是
///   一块 820×560 的普通窗口，留在原位正好让用户把这块面板也拍进去，桌面其余部分
///   依旧干净。这正是「允许截取拾屏自身」如今能变干净的原因：不再需要「保持全屏
///   窗口 layered 透明、同时冻结穿透轮询」这套自相矛盾的时序。
/// - 关闭时只需藏一块 820×560 的小面板，合成面积比原来小一个量级。
///
/// 显隐不交还给本命令：抓完之后面板该关、覆盖层该开，都由前端 `hasContent` 分别驱动
/// 两个窗口，本命令只保证「抓的那一瞬间画面是干净的」。
#[tauri::command]
async fn grab_screen(
    app: tauri::AppHandle,
    capture_self: bool,
) -> Result<tauri::ipc::Response, String> {
    let panel = panel_window(&app)?;
    let panel_hwnd = hwnd_of(&panel)?;
    let st = app.state::<SharedState>();
    // 抓屏期间把「面板是否在场」告诉等待循环：Rust 不自己 show 面板（那只会得到
    // 一片空白），而是等前端 setShowMain(true) → set_window_visible 走完。
    let panel_visible = Arc::new(AtomicBool::new(panel.is_visible().unwrap_or(false)));

    // **不再 hide 覆盖层。**
    //
    // 靠「全透明 layered 窗口不参与桌面合成」让 BitBlt 穿透它：前端先把覆盖层窗口
    // 以**空内容**显示出来（`preparing`），等 WebView2 提交完那帧空白后调本命令，
    // 此刻它是一块 alpha=0 的分层窗口，抓到的直接是它后面的桌面。窗口全程可见，
    // 也就没有「整块全屏层先藏后显」的那一下闪烁。
    //
    // `self_capture` 在抓帧期间冻结轮询的样式计算：否则 60Hz 线程可能把窗口切成
    // 不透明，就等于拿自己的窗口盖住待截的桌面。
    let st_self = st.self_capture.clone();
    st_self.store(true, Ordering::Relaxed);

    let bytes = if capture_self {
        st.overlay.store(true, Ordering::Relaxed);

        // **面板必须在场**，不能指望前端恰好开着它。
        //
        // 托盘常驻意味着面板绝大多数时间是隐藏的；从托盘/热键触发的截图时它并不在屏幕
        // 上，这里若只是「保持可见」，抓到的画面里根本没有它 —— 覆盖层升起来后底下
        // 空空如也，用户看到的就是「主界面消失」。
        //
        // 注意**不能**在这里自己调 `set_window_visible(main, true)`：那只 show HWND，
        // 面板窗口的 React 仍停在 showMain=false，会显示成一片空白。让前端负责
        // 打开（它才能把 UI 渲染出来），这里只**等**它真的可见。
        //
        // State<'_, T> 借用了 app，不能进 spawn_blocking 的 'static 闭包；
        // 把真正拥有所有权的 Arc 克隆出来。
        // 「允许截取拾屏自身」= **面板此刻开着就一起拍进去**，而不是「为了拍它而先把
        // 面板叫出来」。前端不再主动弹面板（托盘常驻下大多数时候用户并不想要那个），
        // 所以这里也不该为等它出现而阻塞：面板可见就等它稳定，不可见就直接抓。
        //
        // State<'_, T> 借用了 app，不能进 spawn_blocking 的 'static 闭包；
        // 把真正拥有所有权的 Arc 克隆出来。
        let painted_slot = st.panel_painted.clone();
        let r = tauri::async_runtime::spawn_blocking(move || {
            // 面板**已经在屏上**时才等它把首帧交完，否则立刻抓到「还没画好」的中间态
            // （用户描述的自身截图发虚）。`DwmFlush` 只等 DWM 的合成队列，等不到
            // WebView2 提交自己的 DirectComposition 表面 —— 那是另一次异步提交。
            const SETTLE: std::time::Duration = std::time::Duration::from_millis(250);
            const DEADLINE: std::time::Duration = std::time::Duration::from_millis(1500);
            if panel_visible.load(Ordering::Relaxed) {
                let started = std::time::Instant::now();
                loop {
                    let painted = painted_slot
                        .lock()
                        .ok()
                        .and_then(|s| *s)
                        .map(|t| t.elapsed() >= SETTLE)
                        .unwrap_or(false);
                    if painted || started.elapsed() >= DEADLINE {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(16));
                }
            }
            winapi::flush_composition();
            capture::grab_virtual()
        })
        .await
        .map_err(|e| e.to_string())?;
        r?
    } else {
        st.overlay.store(true, Ordering::Relaxed);

        // 隱藏必須「當場生效」：tao 的 hide() 只是 PostMessage 到事件循環線程，
        // 直接在 HWND 上再 ShowWindow 一次，保證抓幀那一刻這塊面板已經不在屏幕上。
        // 這裡刻意**不恢復**：前端 startOverlay 已經把面板收起來，恢復反而會讓它
        // 在覆蓋層弹出時又冒出來。
        let _ = panel.hide();
        winapi::set_shown(panel_hwnd, false);

        let r = tauri::async_runtime::spawn_blocking(|| {
            // 等 DWM 把這一幀合成完再抓。少了這一步：剛打斷上一次截圖（Esc/右鍵）就再按熱鍵，
            // 屏幕上還留著上一幀的 45% 黑遮罩，BitBlt 把它一起拍進來 → 整屏發灰。
            winapi::flush_composition();
            // 兜底：等 WebView2 的 DirectComposition 表面徹底交還
            std::thread::sleep(std::time::Duration::from_millis(40));
            winapi::flush_composition();
            capture::grab_virtual()
        })
        .await
        .map_err(|e| e.to_string())??;
        r
    };

    // 解冻穿透控制。显示时机完全由前端 `hasContent` 独占（`preparing` / `frameReady`
    // 翻转会各自驱动一次 `set_window_visible`），本命令不抢。
    st_self.store(false, Ordering::Relaxed);
    Ok(tauri::ipc::Response::new(bytes))
}

/// 屏幕几何诊断：把「画布像素尺寸 ↔ 抓屏帧尺寸 ↔ 屏幕布局」一次性摆出来。
///
/// 覆盖层把抓到的整屏帧画到 canvas 上，画面是否变形 / 跳变，取决于
/// **canvas 的 backing store 像素尺寸**与**帧的物理像素尺寸**是否一致。
/// 两者只要不等，`drawImage` 就会拉伸 —— 窗口尺寸一变就重新算，视觉上就是
/// 「画面突然缩放了一下」。这个命令把三方的真值都读出来，一眼可判。
#[tauri::command]
fn screen_geometry() -> String {
    use windows::Win32::UI::HiDpi::GetDpiForSystem;

    let (x, y, w, h) = capture::virtual_desktop_bounds();
    let dpi = unsafe { GetDpiForSystem() }.max(96) as f64 / 96.0;
    format!(
        "虚拟桌面物理=({x},{y}) {w}x{h} | 系统DPI={dpi:.2} | 若窗口CSS尺寸={}x{}",
        w as f64 / dpi,
        h as f64 / dpi
    )
}

/// 窗口样式诊断：把 `GWL_EXSTYLE` 的关键位回报给前端显示。
///
/// 存在的意义：面板半透明这件事已经反复修了几轮，每次都在「猜哪个样式位没生效」。
/// `transparent: false`、`harden_panel` 清 `WS_EX_LAYERED` 都做过，用户仍看到半透明。
/// 与其继续猜，不如把**运行时真实的位**摆到界面上 —— 一次就能定性。
#[tauri::command]
fn window_diagnostics(app: tauri::AppHandle, label: String) -> String {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, GWL_EXSTYLE, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
        WS_EX_TRANSPARENT,
    };
    let Some(win) = app.get_webview_window(&label) else {
        return format!("{label}: 窗口不存在");
    };
    let Ok(h) = hwnd_of(&win) else {
        return format!("{label}: 取 HWND 失败");
    };
    let ex = unsafe { GetWindowLongPtrW(h, GWL_EXSTYLE) };
    let bit = |m: windows::Win32::UI::WindowsAndMessaging::WINDOW_EX_STYLE| {
        (ex & m.0 as isize) != 0
    };
    format!(
        "{label} EX=0x{:X} | LAYERED={} TRANSPARENT={} NOACTIVATE={} TOOLWINDOW={}",
        ex,
        bit(WS_EX_LAYERED),
        bit(WS_EX_TRANSPARENT),
        bit(WS_EX_NOACTIVATE),
        bit(WS_EX_TOOLWINDOW),
    )
}

/// 面板 webview 首帧绘制完成（前端双 rAF 后上报），供抓屏做条件等待。
#[tauri::command]
fn mark_panel_painted(app: tauri::AppHandle) {
    let st = app.state::<SharedState>();
    if let Ok(mut slot) = st.panel_painted.lock() {
        *slot = Some(std::time::Instant::now());
    }
}

/// 枚举真实可见窗口（Z 序，物理像素，前端负责换算 CSS）
#[tauri::command]
fn list_windows(app: tauri::AppHandle) -> Result<Vec<winapi::WindowRect>, String> {
    // 只把**配置面板**当作可识别的自有窗口。覆盖层窗口不能算：grab_screen 收尾时
    // 刚把它 show 出来，而前端这会儿还没把抓到的帧画上去（setScreenImage 在
    // grabScreen 之后才 await），列进候选等于给用户一个空白窗口。留 null 让它照常
    // 走 WS_EX_TOOLWINDOW 过滤被跳过。
    let panel = app
        .get_webview_window("main")
        .and_then(|w| w.hwnd().ok())
        .map(|raw| HWND(raw.0))
        .unwrap_or(HWND(std::ptr::null_mut()));
    Ok(winapi::list_windows([panel, HWND(std::ptr::null_mut())]))
}

/// 同步「参与穿透切换」的矩形（贴图 / 设置面板 / 托盘菜单）
#[tauri::command]
fn sync_pin_regions(app: tauri::AppHandle, regions: Vec<winapi::Region>) {
    let st = app.state::<SharedState>();
    *st.regions.lock().unwrap() = regions;
}

/// 覆盖层结束：交还穿透控制 + 把键盘焦点还给下层窗口
#[tauri::command]
fn end_overlay(app: tauri::AppHandle) {
    app.state::<SharedState>()
        .overlay
        .store(false, Ordering::Relaxed);
    winapi::focus_next_window(self_hwnds(&app));
}

/// 窗口整体显隐，由前端按各自的内容分别驱动：
/// - `label = "main"`：配置面板。无面板时藏，托盘常驻期间不占顶层窗口位。
/// - `label = "overlay"`：覆盖层。无覆盖层 / 无贴图 / 无提示条 / 无托盘菜单时藏，
///   60Hz 穿透轮询也随之休眠。
///
/// show 之前必须先把该窗口的样式钉好：tao 用的是 SW_SHOW，会顺手激活窗口，而
/// 样式必须在 `ShowWindow` 之前写好，事后补写已经来不及。
#[tauri::command]
fn set_window_visible(app: tauri::AppHandle, label: String, visible: bool) {
    let Some(win) = app.get_webview_window(&label) else { return };
    let in_overlay = app.state::<SharedState>().overlay.load(Ordering::Relaxed);
    let res = if visible {
        // **样式必须在 show 之前就是对的。**
        //
        // tao 的 `show()` 内部是 `dispatcher.send_message(...)`（PostMessage），它真正
        // 执行 `set_visible` 时会重置 exstyle —— 所以「show 之后再补写」是**无效**的
        // （补写会落在 tao 前面，照样被覆盖）。以前这里还额外挂了个 20ms 延迟补钉，
        // 那是在治「先坏后修」的标，掩盖不了首次 show 那一帧。
        //
        // 真正的保证在 `start_passthrough_thread`：**隐藏期也以 1Hz 钉住样式**，所以
        // 首次 show 之前 overlay 已经是「穿透 + NOACTIVATE」的身份，不会整块盖住屏幕。
        // 这里 show 之前再按当前模式写一次，覆盖「刚切换模式就立刻 show」的情况。
        if let Ok(h) = hwnd_of(&win) {
            if label == "main" {
                // 面板是普通窗口：整块可命中、点它该获得焦点去录快捷键。
                winapi::harden_panel(h);
            } else {
                if in_overlay {
                    // 覆盖层已进入框选态：可命中、可聚焦
                    winapi::set_interactive(h, true);
                } else {
                    // 空闲态：穿透 + NOACTIVATE，抢到前台后用户的按键不会落进透明窗口
                    // （例如截图后的「已复制」提示停留的 2.6s）。
                    winapi::set_interactive(h, false);
                }
            }
        }
        win.show()
    } else {
        win.hide()
    };
    if let Err(e) = res {
        eprintln!("[window] 设置显隐失败 ({label}, visible={visible}): {e}");
    }
}

/// 同步全局热键与总开关（委托给 tauri-plugin-global-shortcut 重新注册）
#[tauri::command]
fn sync_hotkeys(
    app: tauri::AppHandle,
    shot: String,
    long: String,
    pin: String,
    enabled: bool,
) -> Result<(), String> {
    hotkey::sync(&app, shot, long, pin, enabled)
}

/// 录制快捷键时挂起系统级热键（插件 unregister_all 语义）
#[tauri::command]
fn set_hotkey_paused(app: tauri::AppHandle, paused: bool) -> Result<(), String> {
    hotkey::set_paused(&app, paused)
}

#[tauri::command]
fn copy_png(app: tauri::AppHandle, req: CopyReq) -> Result<(), String> {
    clipboard::copy_png(&app, &req.data_url)
}

#[tauri::command]
fn save_png(req: SaveReq) -> Result<String, String> {
    clipboard::save_png(&req.data_url, &req.path)
}

/// 把滚轮代理给选区下方的真实窗口，返回实际滚动距离（物理像素；0 = 下方无目标）
#[tauri::command]
fn scroll_region(app: tauri::AppHandle, x: i32, y: i32, dy: i32) -> i32 {
    winapi::scroll_at(x, y, dy, self_hwnds(&app))
}

/// 前端检测到布局口径异常时调用：按「物理窗口/真实DPI」重下 WebView2 bounds。
/// Rust 侧自算目标 CSS 尺寸（GetWindowRect 物理 ÷ GetDpiForWindow 真实缩放），
/// wry 再乘真实 DPI 得 controller = 物理窗口尺寸，布局视口随之回到
/// 物理/缩放 的健康值；幂等，可重复调用。
#[tauri::command]
fn renudge(app: tauri::AppHandle, label: String) {
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;

    let Some(win) = app.get_webview_window(&label) else { return };
    let Some(h) = hwnd_of(&win).ok() else { return };
    let (pw, ph, scale) = unsafe {
        let mut r = windows::Win32::Foundation::RECT::default();
        if GetWindowRect(h, &mut r).is_err() {
            return;
        }
        let dpi = GetDpiForWindow(h).max(96);
        ((r.right - r.left) as f64, (r.bottom - r.top) as f64, dpi as f64 / 96.0)
    };
    // 只改尺寸，不动位置：拆窗之前这块 webview 铺满整个 HWND，把 bounds 归到 (0,0)
    // 是安全的；现在 `main` 是独立的居中窗口，沿用 set_bounds 会把它甩到屏幕左上角。
    let _ = win.set_size(tauri::Size::Logical(tauri::LogicalSize::new(pw / scale, ph / scale)));
}


/* ---------------- 入口 ---------------- */

fn main() {
    // PerMonitorV2 必须在任何窗口创建前声明，否则 GetSystemMetrics 返回被虚拟化的坐标
    unsafe {
        use windows::Win32::UI::HiDpi::{
            SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
        };
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }

    tauri::Builder::default()
        .manage(SharedState::new())
        // 每次页面加载完成时给面板窗口注入不透明标记。
        //
        // 为什么必须挂在 on_page_load 上而不是 setup 里：setup 执行时 webview 往往还在
        // 加载 index.html，此刻 eval 的话 `document.documentElement` 尚不存在，脚本
        // 直接失效——面板就一直是透明的。「加载完成」才是能安全改 DOM 的时刻。
        //
        // 另有两条互不依赖的兜底：index.html 的内联脚本（React 之前）与 App.tsx 的
        // useEffect（React 挂载后）。三者任一生效即可，不必指望另外两个。
        .on_page_load(|webview, _payload| {
            if webview.label() == "main" {
                let _ = webview.eval(
                    "document.documentElement.setAttribute('data-win','main');\
                     try{document.body.style.background='var(--bg)'}catch(e){}",
                );
            }
        })
        // 单例：必须注册在所有其它插件之前。
        // 本应用常驻托盘并占着全局热键，第二个实例会抢不到热键
        // （hotkey.rs 里注册失败是静默忽略的），用户却毫无提示。
        // 这里把第二次启动转成「唤起已有实例的配置面板」。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Emitter;
            set_window_visible(app.clone(), "main".to_string(), true);
            let _ = app.emit("action", "show");
        }))
        // 官方插件（前端 JS 也使用 store / dialog）
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    hotkey::on_event(app, shortcut, event.state);
                })
                .build(),
        )
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        // 开机自启动：写 HKCU\...\CurrentVersion\Run，无需管理员。
        // MacosLauncher 仅 macOS 生效，Windows 下不参与行为，这里只为保持跨平台签名一致。
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let handle = app.handle().clone();
            let shared = app.state::<SharedState>().inner().clone();

            // 面板窗口：正常尺寸（820×560），整块可点、点它能获得焦点。
            let panel = app
                .get_webview_window("main")
                .ok_or_else(|| "配置面板窗口不存在".to_string())?;
            let panel_hwnd = hwnd_of(&panel)?;
            winapi::harden_panel(panel_hwnd);
            // 面板必须**不透明**，而它承载的页面里 body 恒为 transparent（overlay 窗口
            // 铺满用户真实桌面，全靠它）。这里由 Rust 直接往 webview 注入标记，让
            // index.html 的 `html[data-win="main"]` 规则给整页铺实色。
            //
            // 为什么不用前端读窗口 label：那条路要么依赖 Tauri 的内部对象
            // （`__TAURI_INTERNALS__` 路径随版本变，赌它读不到就退化成透明，
            // 正是之前面板一直是半透明的原因），要么受 React 挂载时机限制。
            // 由 Rust 在窗口就绪后主动注入最稳。页面自身的内联脚本与
            // App.tsx 的 useEffect 各再兜一次底，三条路互不依赖。
            let _ = panel.as_ref().eval(
                "document.documentElement.setAttribute('data-win','main');\
                 try{document.body.style.background='var(--bg)'}catch(e){}",
            );

            // 覆盖层窗口：铺满整块虚拟桌面（物理像素），并加固样式。
            // 60Hz 穿透轮询只服务它 —— 贴图 / 托盘菜单需要「哪里可点、哪里穿过」，
            // 面板窗口是普通可交互窗口，不参与这套逻辑。
            let overlay = app
                .get_webview_window("overlay")
                .ok_or_else(|| "覆盖层窗口不存在".to_string())?;
            let overlay_hwnd = hwnd_of(&overlay)?;
            winapi::cover_virtual_desktop(overlay_hwnd);
            winapi::harden(overlay_hwnd);
            winapi::start_passthrough_thread(
                overlay_hwnd,
                panel_hwnd,
                shared.overlay.clone(),
                shared.self_capture.clone(),
                winapi::PassthroughRegions(shared.regions.clone()),
            );

            tray::build(app)?;
            // 默认热键先注册上（前端加载完配置后会 syncHotkeys 覆盖）
            hotkey::apply(&handle)?;

            // 两个窗口都保持隐藏，托盘常驻。
            // 前端按各自的内容分别调 set_window_visible：面板出「有面板」，
            // 覆盖层出「有覆盖层 / 贴图 / 提示条 / 托盘菜单」。
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            grab_screen,
            list_windows,
            screen_geometry,
            window_diagnostics,
            mark_panel_painted,
            sync_pin_regions,
            end_overlay,
            set_window_visible,
            sync_hotkeys,
            set_hotkey_paused,
            copy_png,
            save_png,
            scroll_region,
            renudge,
            stitch::long_begin,
            stitch::long_push,
            stitch::long_preview,
            stitch::long_finish,
            stitch::long_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
