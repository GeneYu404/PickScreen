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
    /// 全局热键控制（A：手写 RegisterHotKey 消息线程）
    pub hotkey: Arc<HotkeyCtl>,
}

pub type LongShotSlot = std::sync::Mutex<LongShot>;
pub type RegionSlot = std::sync::Mutex<Vec<Region>>;

impl SharedState {
    pub fn new() -> Self {
        Self {
            stitcher: Arc::new(std::sync::Mutex::new(LongShot::new())),
            regions: Arc::new(std::sync::Mutex::new(Vec::new())),
            overlay: Arc::new(AtomicBool::new(false)),
            hotkey: Arc::new(HotkeyCtl::new()),
        }
    }
}

impl Default for SharedState {
    fn default() -> Self {
        Self::new()
    }
}
