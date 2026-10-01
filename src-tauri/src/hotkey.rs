//! B 方案：tauri-plugin-global-shortcut 全局热键
//!
//! - 注册 / 注销 / 暂停全部委托给官方插件的 Rust API
//! - 组合键字符串由我们解析为 Modifiers + Code 后交给 Shortcut
//! - 触发后与托盘共用同一条 "action" 事件通道

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::Emitter;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// 动作 id（与方案 A 一致）
pub const ACT_SHOT: u8 = 1;
pub const ACT_LONG: u8 = 2;
pub const ACT_PIN: u8 = 3;

/// 三组热键的当前配置 + 已注册清单
pub struct HotkeyCtl {
    /// (动作 id, 组合键字符串, 该动作是否启用)
    combos: Mutex<Vec<(u8, String, bool)>>,
    /// 总开关：关掉时三组热键全部注销（设置面板 / 托盘菜单仍可用）
    enabled: AtomicBool,
    paused: AtomicBool,
    registered: Mutex<Vec<(Shortcut, u8)>>,
}

impl HotkeyCtl {
    pub fn new() -> Self {
        Self {
            // 与前端 DEFAULT_SETTINGS 保持一致，前端加载配置后会覆盖
            combos: Mutex::new(vec![
                (ACT_SHOT, "Ctrl+1".into(), true),
                (ACT_LONG, "Ctrl+3".into(), true),
                (ACT_PIN, "Ctrl+2".into(), true),
            ]),
            enabled: AtomicBool::new(true),
            paused: AtomicBool::new(false),
            registered: Mutex::new(Vec::new()),
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    pub(super) fn set_enabled_flag(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::Relaxed)
    }

    pub(super) fn set_paused_flag(&self, paused: bool) {
        self.paused.store(paused, Ordering::Relaxed);
    }

    pub(super) fn take_registered(&self) -> Vec<(Shortcut, u8)> {
        std::mem::take(&mut *self.registered.lock().unwrap())
    }

    pub(super) fn push_registered(&self, sc: Shortcut, id: u8) {
        self.registered.lock().unwrap().push((sc, id));
    }

    pub(super) fn combos(&self) -> Vec<(u8, String, bool)> {
        self.combos.lock().unwrap().clone()
    }

    pub(super) fn set_combos(&self, combos: Vec<(u8, String, bool)>) {
        *self.combos.lock().unwrap() = combos;
    }

    pub(super) fn find_action(&self, sc: &Shortcut) -> Option<u8> {
        self.registered
            .lock()
            .unwrap()
            .iter()
            .find(|(s, _)| s == sc)
            .map(|(_, id)| *id)
    }
}

impl Default for HotkeyCtl {
    fn default() -> Self {
        Self::new()
    }
}

fn action_of(id: u8) -> Option<&'static str> {
    match id {
        ACT_SHOT => Some("shot"),
        ACT_LONG => Some("long"),
        ACT_PIN => Some("pin"),
        _ => None,
    }
}

/// "Ctrl+Shift+1" -> Shortcut
pub fn parse_combo(combo: &str) -> Option<Shortcut> {
    let mut mods = Modifiers::empty();
    let mut code: Option<Code> = None;
    for part in combo.split('+') {
        let p = part.trim();
        if p.is_empty() {
            continue;
        }
        match p.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => mods |= Modifiers::CONTROL,
            "alt" => mods |= Modifiers::ALT,
            "shift" => mods |= Modifiers::SHIFT,
            "win" | "super" => return None, // 前端 hotkey.ts 不支持 Win 键
            key => code = Some(key_code(key)?),
        }
    }
    Some(Shortcut::new(Some(mods), code?))
}

/// 归一化为 DOM KeyboardEvent.code 字符串，再用 Code::from_str 解析
/// （keyboard-types 的 FromStr 接受 "Digit1" / "KeyA" / "F4" 等 DOM 命名）
fn key_code(key: &str) -> Option<Code> {
    let name = if key.chars().count() == 1 {
        let c = key.chars().next()?;
        if c.is_ascii_digit() {
            format!("Digit{c}")
        } else if c.is_ascii_alphabetic() {
            format!("Key{}", c.to_ascii_uppercase())
        } else {
            return None;
        }
    } else {
        match key.to_ascii_lowercase().as_str() {
            "space" => "Space".to_string(),
            "esc" | "escape" => "Escape".to_string(),
            "enter" | "return" => "Enter".to_string(),
            "tab" => "Tab".to_string(),
            "backspace" => "Backspace".to_string(),
            "up" => "ArrowUp".to_string(),
            "down" => "ArrowDown".to_string(),
            "left" => "ArrowLeft".to_string(),
            "right" => "ArrowRight".to_string(),
            "home" => "Home".to_string(),
            "end" => "End".to_string(),
            "pageup" => "PageUp".to_string(),
            "pagedown" => "PageDown".to_string(),
            "insert" => "Insert".to_string(),
            "delete" => "Delete".to_string(),
            other => {
                if other.starts_with('f') && other[1..].parse::<u8>().is_ok() {
                    format!("F{}", &other[1..]) // F1..F24（other 已是小写，这里重建标准大小写）
                } else {
                    return None;
                }
            }
        }
    };
    name.parse::<Code>().ok()
}

/// 按当前状态重新注册全部热键（先注销再注册）
pub fn apply(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let st = app.state::<crate::state::SharedState>();
    let gs = app.global_shortcut();

    for (sc, _) in st.hotkey.take_registered() {
        let _ = gs.unregister(sc);
    }
    // 总开关关闭 / 录制快捷键挂起时，一律只注销不注册
    if st.hotkey.is_paused() || !st.hotkey.is_enabled() {
        return Ok(());
    }
    for (id, combo, action_on) in st.hotkey.combos() {
        // 单个动作的独立开关：关掉则该组不注册，其余两组不受影响
        if !action_on {
            continue;
        }
        if let Some(sc) = parse_combo(&combo) {
            // 失败 = 组合键被其它程序占用，忽略（与常见截图工具行为一致）
            if gs.register(sc).is_ok() {
                st.hotkey.push_registered(sc, id);
            }
        }
    }
    Ok(())
}

/// 同步新的热键配置 + 总开关 + 三个动作的独立开关
pub fn sync(
    app: &tauri::AppHandle,
    shot: String,
    long: String,
    pin: String,
    shot_enabled: bool,
    long_enabled: bool,
    pin_enabled: bool,
    enabled: bool,
) -> Result<(), String> {
    use tauri::Manager;
    let st = app.state::<crate::state::SharedState>();
    st.hotkey.set_combos(vec![
        (ACT_SHOT, shot, shot_enabled),
        (ACT_LONG, long, long_enabled),
        (ACT_PIN, pin, pin_enabled),
    ]);
    st.hotkey.set_enabled_flag(enabled);
    apply(app)
}

/// 录制快捷键时挂起 / 恢复系统级热键
pub fn set_paused(app: &tauri::AppHandle, paused: bool) -> Result<(), String> {
    use tauri::Manager;
    let st = app.state::<crate::state::SharedState>();
    st.hotkey.set_paused_flag(paused);
    if paused {
        let gs = app.global_shortcut();
        for (sc, _) in st.hotkey.take_registered() {
            let _ = gs.unregister(sc);
        }
        Ok(())
    } else {
        apply(app)
    }
}

/// 插件回调：命中已注册热键时向前端 emit "action"
pub fn on_event(app: &tauri::AppHandle, shortcut: &Shortcut, state: ShortcutState) {
    use tauri::Manager;
    if state != ShortcutState::Pressed {
        return;
    }
    let st = app.state::<crate::state::SharedState>();
    if let Some(id) = st.hotkey.find_action(shortcut)
        && let Some(action) = action_of(id)
    {
        let _ = app.emit("action", action);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_default_combos() {
        assert!(parse_combo("Ctrl+1").is_some());
        assert!(parse_combo("Ctrl+3").is_some());
        assert!(parse_combo("Ctrl+Shift+S").is_some());
        assert!(parse_combo("Alt+F4").is_some());
        assert!(parse_combo("Ctrl+Win+X").is_none());
        assert!(parse_combo("Ctrl+!").is_none());
    }
}
