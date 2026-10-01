//! 手写 Win32：覆盖层窗口的穿透/激活管理、真实窗口枚举、滚轮代理、焦点交还
//!
//! 空闲态规则（60Hz 轮询，每帧「读-比-写」钉住样式位）：
//! - 鼠标不在任何交互矩形上 -> WS_EX_TRANSPARENT | WS_EX_LAYERED（点击/滚轮穿透到真实桌面）
//!   两者必须成对：只有 TRANSPARENT 时 WindowFromPoint 会跳过本窗，但真实鼠标消息仍会被
//!   WebView2 子窗口吃掉，右键会弹出 WebView2 的默认菜单
//! - 鼠标在贴图上           -> 可命中，但保持 WS_EX_NOACTIVATE（不抢焦点，键盘还给下方窗口）
//! - 鼠标在设置面板/托盘菜单 -> 可命中 + 可聚焦
//! - 截图覆盖层模式         -> 强制可命中 + 可聚焦
//! - 常驻 WS_EX_TOOLWINDOW（不占任务栏/Alt-Tab）、清掉冲突的 WS_EX_APPWINDOW：
//!   tao 在 show()/位置变更等操作时会按自身标志位整体重建 exstyle，把手动写入的位冲掉，
//!   所以不能只在状态变化时写一次，必须每帧校正（写入被改动时才真正调用 Set）

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Deserialize;
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{
    DwmFlush, DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
};
use windows::Win32::UI::WindowsAndMessaging::{
    ChildWindowFromPointEx, EnumWindows, GetCursorPos, GetWindow, GetWindowTextLengthW,
    GetWindowTextW, GetWindowLongPtrW, IsIconic, IsWindowVisible,
    PostMessageW, SetForegroundWindow, SetWindowLongPtrW, SetWindowPos, ShowWindow, GW_HWNDNEXT,
    GWL_EXSTYLE, HWND_TOP, WM_MOUSEWHEEL, CWP_SKIPDISABLED, CWP_SKIPINVISIBLE,
    CWP_SKIPTRANSPARENT, SW_HIDE, SW_SHOW, SWP_NOACTIVATE, SWP_NOZORDER, WS_EX_APPWINDOW,
    WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
};

/// 参与穿透切换的交互矩形（物理像素），由前端每 250ms 同步
#[derive(Debug, Clone, Deserialize)]
pub struct Region {
    #[allow(dead_code)]
    pub id: String,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    #[serde(default)]
    pub focus: bool,
}

/// 枚举到的真实窗口（物理像素）
#[derive(Debug, Clone, serde::Serialize)]
pub struct WindowRect {
    pub title: String,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

#[inline]
fn contains(r: &Region, p: POINT) -> bool {
    p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h
}

/// 窗口把整块虚拟桌面完全罩住（必须在窗口创建后、显示前完成，坐标为物理像素）
pub fn cover_virtual_desktop(hwnd: HWND) {
    let (x, y, w, h) = crate::capture::virtual_desktop_bounds();
    unsafe {
        let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOP),
            x,
            y,
            w,
            h,
            SWP_NOACTIVATE | SWP_NOZORDER,
        );
    }
}

/// 窗口样式加固：初始为穿透态（show 前调用一次，此后由轮询线程每帧钉住）
pub fn harden(hwnd: HWND) {
    ensure_styles(hwnd, true, true);
}

/// 同步设置整块窗口的显隐。
///
/// tao 的 `hide()/show()` 只是给事件循环线程 `PostMessage`（`execute_in_thread`），
/// 调用返回时 `ShowWindow` 往往还没执行，窗口此刻仍留在屏幕上。
/// 抓屏这种「必须保证自己不在画面里」的路径要直接操作 HWND 才算数；
/// 仍保留 tao 那一次调用，让它的 `WindowFlags::VISIBLE` 状态保持一致。
pub fn set_shown(hwnd: HWND, shown: bool) {
    unsafe {
        let _ = ShowWindow(hwnd, if shown { SW_SHOW } else { SW_HIDE });
    }
}

/// 阻塞直到 DWM 处理完全部待决合成命令。
///
/// `ShowWindow(SW_HIDE)` 只是把窗口标记为待摘除，屏幕上真正少一块要等下一帧合成；
/// 不等这一帧就 BitBlt，拍到的还是旧画面 —— 本应用上一帧通常盖着覆盖层的黑遮罩，
/// 于是新截图整屏蒙一层灰（用户描述的「雾蒙蒙」）。抓屏前调用它把这条时序钉死。
pub fn flush_composition() {
    unsafe {
        let _ = DwmFlush();
    }
}

/// 读-比-写地修正「由我们负责」的样式位，其余位原样保留。
/// 穿透态把 WS_EX_TRANSPARENT 与 WS_EX_LAYERED 成对写入（tao 官方
/// `set_ignore_cursor_events` 的同款组合）；恒常补 WS_EX_TOOLWINDOW、
/// 清 WS_EX_APPWINDOW，抵御 tao 样式重建对手动位的冲刷。
fn ensure_styles(hwnd: HWND, transparent: bool, noactivate: bool) {
    unsafe {
        let cur = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let mut ex = (cur | (WS_EX_TOOLWINDOW.0 as isize)) & !(WS_EX_APPWINDOW.0 as isize);
        if transparent {
            ex |= (WS_EX_TRANSPARENT.0 | WS_EX_LAYERED.0) as isize;
        } else {
            ex &= !((WS_EX_TRANSPARENT.0 | WS_EX_LAYERED.0) as isize);
        }
        if noactivate {
            ex |= WS_EX_NOACTIVATE.0 as isize;
        } else {
            ex &= !(WS_EX_NOACTIVATE.0 as isize);
        }
        if ex != cur {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex);
        }
    }
}

/// 覆盖层模式开关：true = 强制可命中可聚焦；false = 交还给空闲态样式
/// （穿透 + 不抢焦点，等价于 `harden`，写出来是为了让两个方向都不留静默 no-op）
pub fn set_interactive(hwnd: HWND, interactive: bool) {
    ensure_styles(hwnd, !interactive, !interactive);
}

/// 启动 60Hz 穿透状态轮询线程
///
/// 窗口隐藏时整段跳过：此时 webview 不渲染任何东西，穿透样式没有作用对象。
/// `self_capture`（截取本软件自身）期间同样冻结：这一路径要保持 WS_EX_LAYERED
/// 让透明区域不参与合成，被本线程切成不透明就等于拿自己的窗口盖住待截的桌面。
pub fn start_passthrough_thread(
    hwnd: HWND,
    overlay: std::sync::Arc<AtomicBool>,
    self_capture: std::sync::Arc<AtomicBool>,
    regions: PassthroughRegions,
) {
    // HWND 内部是裸指针（非 Send），以 isize 携带进线程
    let hwnd_raw = hwnd.0 as isize;
    std::thread::spawn(move || {
        let hwnd = HWND(hwnd_raw as *mut std::ffi::c_void);
        loop {
            std::thread::sleep(Duration::from_millis(16));
            if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
                continue;
            }
            if self_capture.load(Ordering::Relaxed) {
                continue;
            }
            let in_overlay = overlay.load(Ordering::Relaxed);
            let (want_t, want_n) = if in_overlay {
                (false, false)
            } else {
                let mut pt = POINT::default();
                let got = unsafe { GetCursorPos(&mut pt) }.is_ok();
                let list = regions.0.lock().unwrap_or_else(|e| e.into_inner());
                if !got || list.is_empty() {
                    (true, true)
                } else {
                    let over = list.iter().any(|r| contains(r, pt));
                    let focus = list.iter().any(|r| r.focus && contains(r, pt));
                    (!over, !focus)
                }
            };
            // 每帧都校正：tao 的样式重建会随时冲掉手动位，只在状态变化时写一次会丢
            ensure_styles(hwnd, want_t, want_n);
        }
    });
}

/// regions 的 Arc 别名，方便线程持有
#[derive(Clone)]
pub struct PassthroughRegions(pub std::sync::Arc<std::sync::Mutex<Vec<Region>>>);

/* ---------------- 真实窗口枚举 ---------------- */

struct ListData {
    exclude: HWND,
    out: Vec<WindowRect>,
}

unsafe extern "system" fn enum_list_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    unsafe {
        let data = &mut *(lparam.0 as *mut ListData);
        if hwnd == data.exclude {
            return BOOL(1);
        }
        if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
            return BOOL(1);
        }
        // 工具窗口（含我们自己、任务栏、悬浮面板）
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        if ex & (WS_EX_TOOLWINDOW.0 as isize) != 0 {
            return BOOL(1);
        }
        // 被 DWM 遮挡挂起的窗口（UWP 后台等）
        let mut cloaked: u32 = 0;
        let _ = DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut _,
            size_of::<u32>() as u32,
        );
        if cloaked != 0 {
            return BOOL(1);
        }
        let mut r = RECT_ZERO;
        if DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut r as *mut _ as *mut _,
            size_of::<windows::Win32::Foundation::RECT>() as u32,
        )
        .is_err()
        {
            return BOOL(1);
        }
        let w = r.right - r.left;
        let h = r.bottom - r.top;
        if w < 16 || h < 16 {
            return BOOL(1);
        }
        let title = window_title(hwnd);
        // 无标题的多为 Progman/WorkerW 等系统窗口，不作为截图目标
        if title.is_empty() {
            return BOOL(1);
        }
        data.out.push(WindowRect {
            title,
            x: r.left,
            y: r.top,
            w,
            h,
        });
        BOOL(1)
    }
}

const RECT_ZERO: RECT = RECT {
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
};

unsafe fn window_title(hwnd: HWND) -> String {
    unsafe {
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return String::new();
        }
        let mut buf = vec![0u16; len as usize + 1];
        let n = GetWindowTextW(hwnd, &mut buf);
        if n <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..n as usize])
    }
}

/// 枚举真实可见窗口（Z 序从上到下）
pub fn list_windows(exclude: HWND) -> Vec<WindowRect> {
    let mut data = ListData {
        exclude,
        out: Vec::new(),
    };
    unsafe {
        let _ = EnumWindows(
            Some(enum_list_proc),
            LPARAM(&mut data as *mut ListData as isize),
        );
    }
    data.out
}

/* ---------------- 滚轮代理 ---------------- */

struct PointData {
    exclude: HWND,
    point: POINT,
    found: HWND,
}

unsafe extern "system" fn enum_point_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    unsafe {
        let data = &mut *(lparam.0 as *mut PointData);
        if hwnd == data.exclude {
            return BOOL(1);
        }
        if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
            return BOOL(1);
        }
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        // WS_EX_TRANSPARENT = 提示条/悬浮层等瞬态窗口，不作为滚动目标
        if ex & (WS_EX_TRANSPARENT.0 as isize) != 0 || ex & (WS_EX_TOOLWINDOW.0 as isize) != 0 {
            return BOOL(1);
        }
        let mut r = RECT_ZERO;
        if DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut r as *mut _ as *mut _,
            size_of::<windows::Win32::Foundation::RECT>() as u32,
        )
        .is_err()
        {
            return BOOL(1);
        }
        if data.point.x < r.left
            || data.point.x >= r.right
            || data.point.y < r.top
            || data.point.y >= r.bottom
        {
            return BOOL(1);
        }
        data.found = hwnd;
        BOOL(0) // 找到最顶层的，停止枚举
    }
}

/// 把滚轮滚动代理给 (x, y) 之下的真实窗口。
/// 返回请求的滚动距离（物理像素）；返回 0 表示该点下方没有目标窗口。
pub fn scroll_at(x: i32, y: i32, dy: i32, exclude: HWND) -> i32 {
    // 前端只下发向下滚动；负数/零直接忽略
    if dy <= 0 {
        return 0;
    }
    let mut data = PointData {
        exclude,
        point: POINT { x, y },
        found: HWND(std::ptr::null_mut()),
    };
    unsafe {
        let _ = EnumWindows(
            Some(enum_point_proc),
            LPARAM(&mut data as *mut PointData as isize),
        );
    }
    if data.found.0.is_null() {
        return 0;
    }
    // 找到该顶层窗口下点所在的子窗口，把消息直接投给它
    let child = unsafe {
        ChildWindowFromPointEx(
            data.found,
            POINT { x, y },
            CWP_SKIPINVISIBLE | CWP_SKIPDISABLED | CWP_SKIPTRANSPARENT,
        )
    };
    let sink = if child.0.is_null() { data.found } else { child };

    // 约 48px / 120 单位（3 行），按需求距离换算
    let delta = (dy * 120 / 48).clamp(120, 1200);
    let lparam = ((x as u32 & 0xffff) | ((y as u32 & 0xffff) << 16)) as isize;
    let wparam = ((delta as u16 as u32) << 16) as usize;
    let posted = unsafe { PostMessageW(Some(sink), WM_MOUSEWHEEL, WPARAM(wparam), LPARAM(lparam)) };
    if posted.is_ok() {
        dy
    } else {
        0
    }
}

/// 覆盖层结束时把键盘焦点交还给下层窗口，避免继续吞按键
pub fn focus_next_window(exclude: HWND) {
    unsafe {
        let mut cur = GetWindow(exclude, GW_HWNDNEXT).unwrap_or(HWND(std::ptr::null_mut()));
        let mut guard = 0;
        while !cur.0.is_null() && guard < 64 {
            guard += 1;
            if IsWindowVisible(cur).as_bool() {
                let mut cloaked: u32 = 0;
                let _ = DwmGetWindowAttribute(
                    cur,
                    DWMWA_CLOAKED,
                    &mut cloaked as *mut u32 as *mut _,
                    size_of::<u32>() as u32,
                );
                if cloaked == 0 {
                    let _ = SetForegroundWindow(cur);
                    return;
                }
            }
            cur = GetWindow(cur, GW_HWNDNEXT).unwrap_or(HWND(std::ptr::null_mut()));
        }
    }
}
