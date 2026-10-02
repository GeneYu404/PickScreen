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
    DwmFlush, DwmGetWindowAttribute, DwmSetWindowAttribute, DWMWA_CLOAKED,
    DWMWA_EXTENDED_FRAME_BOUNDS, DWMWA_WINDOW_CORNER_PREFERENCE,
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
///
/// 三个位彼此独立，因为它们服务的窗口已经拆开：
/// - `passthrough`：`WS_EX_TRANSPARENT`，鼠标穿透（空闲态 / 贴图区）
/// - `layered`：`WS_EX_LAYERED`，per-pixel alpha 合成（WebView2 透明背景必需）
/// - `noactivate`：`WS_EX_NOACTIVATE`，不抢前台
///
/// 恒常补 `WS_EX_TOOLWINDOW`、清 `WS_EX_APPWINDOW`，抵御 tao 样式重建对手动位的冲刷。
fn ensure_styles_ex(hwnd: HWND, passthrough: bool, layered: bool, noactivate: bool) {
    unsafe {
        let cur = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let mut ex = (cur | (WS_EX_TOOLWINDOW.0 as isize)) & !(WS_EX_APPWINDOW.0 as isize);
        if passthrough {
            ex |= WS_EX_TRANSPARENT.0 as isize;
        } else {
            ex &= !(WS_EX_TRANSPARENT.0 as isize);
        }
        if layered {
            ex |= WS_EX_LAYERED.0 as isize;
        } else {
            ex &= !(WS_EX_LAYERED.0 as isize);
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

/// 穿透 + 保留 LAYERED + 不抢前台：覆盖层窗口的空闲态（贴图 / 托盘菜单）。
pub fn harden(hwnd: HWND) {
    ensure_styles_ex(hwnd, true, true, true);
}

/// 面板窗口：正常尺寸的标准不透明窗口，整块区域都要能点、也能激活。
///
/// **刻意不保留 `WS_EX_LAYERED`**。它是一块铺满自身内容的不透明面板，走 alpha 合成
/// 只会让整窗连同 `body` 的 transparent 被 DWM 混合出一层「蒙了纱」的观感 —— 实色
/// 底色反而比预期更透。关掉 layered 后它是标准窗口（`tauri.conf.json` 里
/// `transparent: false`），不再需要任何 alpha 配合。
pub fn harden_panel(hwnd: HWND) {
    ensure_styles_ex(hwnd, false, false, false);
    // 圆角交给 DWM：窗口改成不透明后，CSS 的 rounded-lg 已经无法裁到窗口边缘
    //（没有 alpha 就没有「圆角外透明」这回事）。DWMWA_WINDOW_CORNER_PREFERENCE
    // 让 DWM 自己在物理窗口上切圆角，Win11 原生观感，且不受 tao 样式重建影响。
    // 取不到（非 Win11 / 旧 build）就静默跳过，矩形窗口仍可用。
    unsafe {
        let pref: i32 = 2; // DWMWCP_ROUND
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            (&pref as *const i32) as *const std::ffi::c_void,
            size_of::<i32>() as u32,
        );
    }
}

/// 覆盖层模式开关：true = 强制可命中可聚焦；false = 交还给空闲态样式
/// （穿透 + 不抢焦点，等价于 `harden`，写出来是为了让两个方向都不留静默 no-op）
pub fn set_interactive(hwnd: HWND, interactive: bool) {
    ensure_styles_ex(hwnd, !interactive, !interactive, !interactive);
}

/// 启动 60Hz 穿透状态轮询线程（同时维护两个自有窗口的样式）
///
/// ## 为什么隐藏时也要维护样式
///
/// 早期实现是「窗口不可见就整段 `continue`」，理由是隐藏时 webview 不渲染、样式没有
/// 作用对象。这个前提是错的：**tao 会在窗口创建 / 首次显示时重置 exstyle**，而隐藏期
/// 没人写回，于是样式就停留在 tao 的默认态。
///
/// 运行时诊断实测到 overlay 隐藏态 `GWL_EXSTYLE = 0x40118`
/// （`LAYERED` / `TRANSPARENT` / `NOACTIVATE` 全 false、还带 `APPWINDOW`）——
/// 就是一个**不透明的顶层窗口**。于是：
///   第一次 show → 以不透明身份整块盖住屏幕 → **闪一下**；
///   之后轮询在「可见」期间把样式写对了，hide 时样式保持正确，
///   第二次 show 自然就不闪了。
/// 用户描述的现象正是「第一次会，第二次不会」——完全对上。
///
/// 现在隐藏期也以 1Hz 钉住样式（`ensure_styles_ex` 内部有 `ex != cur` 判断，
/// 实际不会产生多余的 `SetWindowLongPtrW`），保证**首次 show 之前样式就已经正确**。
/// 启动后的前 3 秒频率更高一些，覆盖 tao 建窗初期的几次样式重建。
///
/// `self_capture`（截取本软件自身）期间冻结可见态的样式计算：这一路径要保持
/// `WS_EX_LAYERED` 让透明区域不参与合成，被本线程切成不透明就等于拿自己的窗口
/// 盖住待截的桌面。隐藏期的维护不受影响。
pub fn start_passthrough_thread(
    hwnd: HWND,
    panel: HWND,
    overlay: std::sync::Arc<AtomicBool>,
    self_capture: std::sync::Arc<AtomicBool>,
    regions: PassthroughRegions,
) {
    // HWND 内部是裸指针（非 Send），以 isize 携带进线程
    let hwnd_raw = hwnd.0 as isize;
    let panel_raw = panel.0 as isize;
    std::thread::spawn(move || {
        let hwnd = HWND(hwnd_raw as *mut std::ffi::c_void);
        let panel = HWND(panel_raw as *mut std::ffi::c_void);
        let mut tick: u32 = 0;
        loop {
            std::thread::sleep(Duration::from_millis(16));
            tick = tick.wrapping_add(1);
            // 建窗初期（~3s）tao 可能连续重建几次样式，频率拉高；之后回到 1Hz。
            let idle_every: u32 = if tick < 180 { 3 } else { 60 };

            // 面板样式维护：1Hz，同样要放在下面那些 `continue` **之前** ——
            // 覆盖层不可见时整段会 continue 掉，那时恰恰也该顺带校正面板。
            if tick % idle_every == 0 && !panel.0.is_null() {
                harden_panel(panel);
            }

            if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
                // 隐藏期同样钉住覆盖层的样式，否则首次 show 会闪一帧不透明。
                // 隐藏时不会有贴图要跟随鼠标穿透，按当前模式给一个静态正确值即可。
                if tick % idle_every == 0 {
                    let in_overlay = overlay.load(Ordering::Relaxed);
                    ensure_styles_ex(hwnd, !in_overlay, !in_overlay, !in_overlay);
                }
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
            ensure_styles_ex(hwnd, want_t, want_t, want_n);
        }
    });
}

/// regions 的 Arc 别名，方便线程持有
#[derive(Clone)]
pub struct PassthroughRegions(pub std::sync::Arc<std::sync::Mutex<Vec<Region>>>);

/* ---------------- 真实窗口枚举 ---------------- */

struct ListData {
    /// 自有窗口（配置面板 + 覆盖层）。
    ///
    /// 它们**不再被排除**，否则「自动识别」永远列不出拾屏自己 —— 而开着面板截一张
    /// 含拾屏界面的图正是 `capture_self` 的用途。这里的语义与 `scroll_at` /
    /// `focus_next_window` 里的 `excludes` 相反：那两处必须排除自己（不能把滚轮
    /// 滚给自己、不能把焦点交还给自己）。
    self_windows: [HWND; 2],
    out: Vec<WindowRect>,
}

unsafe extern "system" fn enum_list_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    unsafe {
        let data = &mut *(lparam.0 as *mut ListData);
        if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
            return BOOL(1);
        }
        // 工具窗口（任务栏、悬浮层、别的应用的工具窗）通常不是截图目标。
        // 但**我们自己的两个窗口是例外**：`ensure_styles_ex` 恒常给它们写
        // WS_EX_TOOLWINDOW，照常过滤就会让拾屏自己永远识别不到。
        // 至于「该不该出现」交给可见性判断：capture_self 关闭时 Rust 已把面板藏了，
        // IsWindowVisible 为 false 自动跳过；开启时它就该作为候选浮在列表里。
        let is_self = data.self_windows.contains(&hwnd);
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        if !is_self && ex & (WS_EX_TOOLWINDOW.0 as isize) != 0 {
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

/// 枚举真实可见窗口（Z 序从上到下），**包含拾屏自己的窗口**（见 `ListData` 注释）
pub fn list_windows(self_windows: [HWND; 2]) -> Vec<WindowRect> {
    let mut data = ListData {
        self_windows,
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
    excludes: [HWND; 2],
    point: POINT,
    found: HWND,
}

unsafe extern "system" fn enum_point_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    unsafe {
        let data = &mut *(lparam.0 as *mut PointData);
        if data.excludes.contains(&hwnd) {
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
pub fn scroll_at(x: i32, y: i32, dy: i32, excludes: [HWND; 2]) -> i32 {
    // 前端只下发向下滚动；负数/零直接忽略
    if dy <= 0 {
        return 0;
    }
    let mut data = PointData {
        excludes,
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

/// 覆盖层结束时把键盘焦点交还给下层窗口，避免继续吞按键。
///
/// 从 Z 序顶端往下找，跳过两个自有窗口（配置面板 + 覆盖层）——原来的实现是从
/// 「当前这个窗口的下一个」起算，现在窗口有两个，起点不再是可靠的参照物，
/// 直接从 HWND_TOP 遍历更稳，也天然覆盖「面板在覆盖层之上」这种次序。
pub fn focus_next_window(excludes: [HWND; 2]) {
    unsafe {
        let mut cur = GetWindow(HWND_TOP, GW_HWNDNEXT).unwrap_or(HWND(std::ptr::null_mut()));
        let mut guard = 0;
        while !cur.0.is_null() && guard < 64 {
            guard += 1;
            if !excludes.contains(&cur) && IsWindowVisible(cur).as_bool() {
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
