//! 托盘图标与托盘菜单（与全局热键共用 "action" 事件通道）

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::Emitter;

pub fn build(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "打开配置", true, None::<&str>)?;
    let shot = MenuItem::with_id(app, "shot", "截图", true, None::<&str>)?;
    let long = MenuItem::with_id(app, "long", "长截图", true, None::<&str>)?;
    let pin = MenuItem::with_id(app, "pin", "贴图", true, None::<&str>)?;
    // 状态权威在设置里（随 settings.json 持久化），这里只发事件让前端翻转后回灌
    let hotkeys = MenuItem::with_id(app, "toggle_hotkeys", "启用 / 禁用全局快捷键", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &shot, &long, &pin, &hotkeys, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("拾屏 A · Ctrl+1 截图")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "quit" => app.exit(0),
            id => {
                let _ = app.emit("action", id);
            }
        })
        .on_tray_icon_event(|tray, event| {
            // 左键点击托盘 = 唤起配置窗口（右键 = 菜单）
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                ..
            } = event
            {
                let app = tray.app_handle();
                let _ = app.emit("action", "show");
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}
