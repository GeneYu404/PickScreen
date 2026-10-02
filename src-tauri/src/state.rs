//! 应用共享状态（A 方案：std::sync::Mutex，不做额外依赖）

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use crate::hotkey::HotkeyCtl;
use crate::stitch::LongShot;
use crate::winapi::Region;

#[derive(Clone)]
pub struct SharedState {
    /// 长截图拼接器（Rust 侧持有全分辨率长图，只把缩略图/最终 PNG 送过 IPC）
    pub stitcher: Arc<LongShotSlot>,
    /// 参与「鼠标穿透动态切换」的矩形（贴图 / 面板 / 托盘菜单，物理像素）
    pub regions: Arc<RegionSlot>,
    /// 是否处于截图覆盖层模式（此模式强制窗口可命中、可聚焦）
    pub overlay: Arc<AtomicBool>,
    /// 「截取本软件自身」进行中：此时必须冻结窗口样式，
    /// 否则 60Hz 轮询线程会把窗口切成不透明，整块窗口就盖住了待截的桌面。
    pub self_capture: Arc<AtomicBool>,
    /// 配置面板 webview **首帧真正绘制完成**的时刻（None = 还没绘制过）。
    ///
    /// 抓屏时 BitBlt 读的是 DWM 合成后的屏幕像素，而 WebView2 提交自己的
    /// DirectComposition 表面是另一次异步流程。应用**首次启动**时这一步包含
    /// WebView2 冷启动，可能几百毫秒到数秒；期间抓屏会拿到「还没画好」的中间态
    /// （用户看到的是虚化 / 半渲染）。固定 sleep 猜不准这个时长，改为记下真实时刻
    /// 做条件等待。
    pub panel_painted: Arc<PaintedSlot>,
    /// 全局热键控制（A：手写 RegisterHotKey 消息线程）
    pub hotkey: Arc<HotkeyCtl>,
}

pub type LongShotSlot = std::sync::Mutex<LongShot>;
pub type RegionSlot = std::sync::Mutex<Vec<Region>>;
/// 面板首帧绘制时刻；`None` 表示 webview 还没绘制过。
pub type PaintedSlot = std::sync::Mutex<Option<std::time::Instant>>;

impl SharedState {
    pub fn new() -> Self {
        Self {
            stitcher: Arc::new(std::sync::Mutex::new(LongShot::new())),
            regions: Arc::new(std::sync::Mutex::new(Vec::new())),
            overlay: Arc::new(AtomicBool::new(false)),
            self_capture: Arc::new(AtomicBool::new(false)),
            panel_painted: Arc::new(std::sync::Mutex::new(None)),
            hotkey: Arc::new(HotkeyCtl::new()),
        }
    }
}

impl Default for SharedState {
    fn default() -> Self {
        Self::new()
    }
}
