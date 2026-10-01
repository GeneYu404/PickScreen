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

use std::sync::atomic::Ordering;

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

fn main_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    app.get_webview_window("main")
        .ok_or_else(|| "主窗口不存在".to_string())
}

fn hwnd_of(win: &tauri::WebviewWindow) -> Result<HWND, String> {
    let raw = win.hwnd().map_err(|e| e.to_string())?;
    Ok(HWND(raw.0))
}

/* ---------------- 命令 ---------------- */

/// 抓取整块虚拟桌面：先隐藏本窗口（避免把自己拍进去）→ 抓帧 → 显示并聚焦
#[tauri::command]
async fn grab_screen(app: tauri::AppHandle) -> Result<tauri::ipc::Response, String> {
    let win = main_window(&app)?;
    let hwnd = hwnd_of(&win)?;
    app.state::<SharedState>()
        .overlay
        .store(true, Ordering::Relaxed);
    winapi::set_interactive(hwnd, true);

    // 隐藏必须「当场生效」：tao 的 hide() 只是 PostMessage 到事件循环线程，
    // 直接在 HWND 上再 ShowWindow 一次，保证抓帧那一刻本窗口已经不在屏幕上。
    win.hide().map_err(|e| e.to_string())?;
    winapi::set_shown(hwnd, false);

    let bytes = tauri::async_runtime::spawn_blocking(|| {
        // 等 DWM 把这一帧合成完再抓。少了这一步：刚打断上一次截图（Esc/右键）就再按热键，
        // 屏幕上还留着上一帧的 45% 黑遮罩，BitBlt 把它一起拍进来 → 整屏发灰。
        winapi::flush_composition();
        // 兜底：等 WebView2 的 DirectComposition 表面彻底交还
        std::thread::sleep(std::time::Duration::from_millis(40));
        winapi::flush_composition();
        capture::grab_virtual()
    })
    .await
    .map_err(|e| e.to_string())??;

    win.show().map_err(|e| e.to_string())?;
    let _ = win.set_focus();
    Ok(tauri::ipc::Response::new(bytes))
}

/// 枚举真实可见窗口（Z 序，物理像素，前端负责换算 CSS）
#[tauri::command]
fn list_windows(app: tauri::AppHandle) -> Result<Vec<winapi::WindowRect>, String> {
    let win = main_window(&app)?;
    let hwnd = hwnd_of(&win)?;
    Ok(winapi::list_windows(hwnd))
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
    if let Ok(hwnd) = main_window(&app).and_then(|w| hwnd_of(&w)) {
        winapi::focus_next_window(hwnd);
    }
}

/// 窗口整体显隐：空闲（无面板 / 无覆盖层 / 无贴图 / 无提示条）时前端调 hide，
/// 让托盘常驻期间不占用顶层窗口位，穿透轮询线程也随之休眠。
#[tauri::command]
fn set_window_visible(app: tauri::AppHandle, visible: bool) {
    let Ok(win) = main_window(&app) else { return };
    let res = if visible {
        // 先把空闲态样式（穿透 + WS_EX_NOACTIVATE）钉好再 show：tao 用的是 SW_SHOW，
        // 会顺手激活窗口，而这块 webview 铺满整块虚拟桌面 —— 抢到前台后用户的按键
        // 会落进透明窗口（例如截图后的「已复制」提示停留的 2.6s）。
        // NOACTIVATE 必须在 ShowWindow 之前写好，事后补写已经来不及。
        if let Ok(h) = hwnd_of(&win) {
            winapi::set_interactive(h, false);
        }
        win.show()
    } else {
        win.hide()
    };
    if let Err(e) = res {
        eprintln!("[window] 设置显隐失败 (visible={visible}): {e}");
    }
}

/// 同步全局热键与总开关（委托给 tauri-plugin-global-shortcut 重新注册）
#[tauri::command]
fn sync_hotkeys(
    app: tauri::AppHandle,
    shot: String,
    long: String,
    pin: String,
    shot_enabled: bool,
    long_enabled: bool,
    pin_enabled: bool,
    enabled: bool,
) -> Result<(), String> {
    hotkey::sync(
        &app,
        shot,
        long,
        pin,
        shot_enabled,
        long_enabled,
        pin_enabled,
        enabled,
    )
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
    let Ok(hwnd) = main_window(&app).and_then(|w| hwnd_of(&w)) else {
        return 0;
    };
    winapi::scroll_at(x, y, dy, hwnd)
}

/// 前端检测到布局口径异常时调用：按「物理窗口/真实DPI」重下 WebView2 bounds。
/// Rust 侧自算目标 CSS 尺寸（GetWindowRect 物理 ÷ GetDpiForWindow 真实缩放），
/// wry 再乘真实 DPI 得 controller = 物理窗口尺寸，布局视口随之回到
/// 物理/缩放 的健康值；幂等，可重复调用。
#[tauri::command]
fn renudge(app: tauri::AppHandle) {
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;

    let Ok(win) = main_window(&app) else { return };
    let Some(h) = hwnd_of(&win).ok() else { return };
    let (pw, ph, scale) = unsafe {
        let mut r = windows::Win32::Foundation::RECT::default();
        if GetWindowRect(h, &mut r).is_err() {
            return;
        }
        let dpi = GetDpiForWindow(h).max(96);
        ((r.right - r.left) as f64, (r.bottom - r.top) as f64, dpi as f64 / 96.0)
    };
    let _ = win.as_ref().set_bounds(tauri::Rect {
        position: tauri::Position::Physical(tauri::PhysicalPosition::new(0, 0)),
        size: tauri::Size::Logical(tauri::LogicalSize::new(pw / scale, ph / scale)),
    });
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
            let win = app
                .get_webview_window("main")
                .ok_or_else(|| "主窗口不存在".to_string())?;
            let hwnd = hwnd_of(&win)?;

            // 把窗口铺满整块虚拟桌面（物理像素），并加固样式
            winapi::cover_virtual_desktop(hwnd);
            winapi::harden(hwnd);
            winapi::start_passthrough_thread(
                hwnd,
                shared.overlay.clone(),
                winapi::PassthroughRegions(shared.regions.clone()),
            );

            tray::build(app)?;
            // 默认热键先注册上（前端加载完配置后会 syncHotkeys 覆盖）
            hotkey::apply(&handle)?;

            // 不调用 win.show()：窗口保持隐藏，托盘常驻。
            // 前端在「有东西要渲染」（配置面板 / 截图覆盖层 / 贴图）时才调 set_window_visible。
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            grab_screen,
            list_windows,
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
