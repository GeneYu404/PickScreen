//! 长截图拼接器（从 src/utils/stitch.ts 逐行移植）
//! 思路：每帧压成「每行 32 个灰度桶」的签名，搜索使重叠区差异最小的垂直偏移 s，
//! 把新帧底部新出现的 s 行追加到长图末尾。
//!
//! 与前端方案的差异：长图全分辨率数据只存在于 Rust 侧，
//! 过 IPC 的只有降采样预览 PNG 和最终成图 PNG。

use rayon::prelude::*;
use serde::Serialize;
use tauri::Manager;

use crate::state::SharedState;

const BUCKETS: usize = 32;
pub const MAX_HEIGHT: usize = 32000;
const PREVIEW_MAX_W: usize = 400;
const PREVIEW_MAX_H: usize = 3000;

#[derive(Debug, Clone, Serialize)]
pub struct LongState {
    pub frames: u32,
    pub width: u32,
    pub height: u32,
    pub status: &'static str,
}

pub struct LongShot {
    region: Option<(i32, i32, u32, u32)>,
    canvas: Vec<u8>, // BGRA，行数 cap
    fw: usize,
    fh: usize,
    cap: usize,
    used: usize,
    prev: Vec<f32>,
    frames: u32,
}

impl LongShot {
    pub fn new() -> Self {
        Self {
            region: None,
            canvas: Vec::new(),
            fw: 0,
            fh: 0,
            cap: 0,
            used: 0,
            prev: Vec::new(),
            frames: 0,
        }
    }

    pub fn region(&self) -> Option<(i32, i32, u32, u32)> {
        self.region
    }

    pub fn is_full(&self) -> bool {
        self.used >= MAX_HEIGHT
    }

    fn state(&self, status: &'static str) -> LongState {
        LongState {
            frames: self.frames,
            width: self.fw as u32,
            height: self.used as u32,
            status,
        }
    }

    pub fn full_state(&self) -> LongState {
        self.state("full")
    }

    pub fn begin(&mut self, region: (i32, i32, u32, u32), frame: Vec<u8>) -> Result<LongState, String> {
        let w = region.2 as usize;
        let h = region.3 as usize;
        if w == 0 || h == 0 {
            return Err("选区为空".into());
        }
        if frame.len() != w * h * 4 {
            return Err("首帧尺寸与选区不符".into());
        }
        let sig = signature(&frame, w, h);
        self.region = Some(region);
        self.fw = w;
        self.fh = h;
        self.cap = h;
        self.used = h;
        self.canvas = frame;
        self.prev = sig;
        self.frames = 1;
        Ok(self.state("init"))
    }

    pub fn push(&mut self, frame: Vec<u8>, hint: usize) -> Result<LongState, String> {
        let (w, h) = (self.fw, self.fh);
        if w == 0 || h == 0 {
            return Err("长截图尚未开始".into());
        }
        // 选区尺寸变化（理论上不会发生）→ 重新初始化
        if frame.len() != w * h * 4 {
            if let Some(r) = self.region {
                return self.begin(r, frame);
            }
            return Err("帧尺寸与选区不符".into());
        }
        if self.used >= MAX_HEIGHT {
            return Ok(self.state("full"));
        }
        let sig = signature(&frame, w, h);
        let s = find_shift(&self.prev, &sig, h, hint);
        if s == 0 {
            return Ok(self.state("nochange"));
        }
        self.prev = sig;
        self.frames += 1;
        if s < 0 {
            self.blit(&frame, 0, h);
            Ok(self.state("seam"))
        } else {
            self.blit(&frame, h - (s as usize), s as usize);
            Ok(self.state("appended"))
        }
    }

    fn blit(&mut self, _frame: &[u8], sy: usize, sh: usize) {
        if sh == 0 {
            return;
        }
        let stride = self.fw * 4;
        let need = self.used + sh;
        if need > self.cap {
            let new_cap = std::cmp::max(self.cap * 2, need);
            self.canvas.resize(new_cap * stride, 0);
            self.cap = new_cap;
        }
        for i in 0..sh {
            let src = (sy + i) * stride;
            let dst = (self.used + i) * stride;
            self.canvas.copy_within(src..src + stride, dst);
        }
        self.used += sh;
    }

    pub fn cancel(&mut self) {
        self.region = None;
        self.canvas = Vec::new();
        self.fw = 0;
        self.fh = 0;
        self.cap = 0;
        self.used = 0;
        self.prev = Vec::new();
        self.frames = 0;
    }

    /// 降采样预览 PNG（只在 IPC 上传输缩略图）
    pub fn preview_png(&self) -> Result<Vec<u8>, String> {
        if self.used == 0 || self.fw == 0 {
            return Err("长截图尚未开始".into());
        }
        let vstep = self.used.div_ceil(PREVIEW_MAX_H).max(1);
        let hstep = self.fw.div_ceil(PREVIEW_MAX_W).max(1);
        let ow = self.fw.div_ceil(hstep);
        let oh = self.used.div_ceil(vstep);
        let mut rgba = Vec::with_capacity(ow * oh * 4);
        for oy in 0..oh {
            let row = (oy * vstep) * self.fw;
            for ox in 0..ow {
                let i = (row + ox * hstep) * 4;
                let px = &self.canvas[i..i + 4];
                rgba.extend_from_slice(&[px[2], px[1], px[0], 255]);
            }
        }
        crate::png_util::encode_rgba(&rgba, ow as u32, oh as u32)
    }

    /// 全分辨率长图 PNG
    pub fn output_png(&self) -> Result<Vec<u8>, String> {
        if self.used == 0 || self.fw == 0 {
            return Err("长截图尚未开始".into());
        }
        let stride = self.fw * 4;
        let rows = &self.canvas[..self.used * stride];
        let mut rgba = Vec::with_capacity(rows.len());
        for px in rows.as_chunks::<4>().0 {
            rgba.extend_from_slice(&[px[2], px[1], px[0], 255]);
        }
        crate::png_util::encode_rgba(&rgba, self.fw as u32, self.used as u32)
    }
}

impl Default for LongShot {
    fn default() -> Self {
        Self::new()
    }
}

/* ---------------- 签名与位移搜索 ---------------- */

/// 每行 BUCKETS 个灰度桶的行均值签名
fn signature(frame: &[u8], w: usize, h: usize) -> Vec<f32> {
    let mut sig = vec![0f32; h * BUCKETS];
    sig.par_chunks_mut(BUCKETS)
        .enumerate()
        .for_each(|(y, row_out)| {
            let row = y * w * 4;
            let bw = w as f32 / BUCKETS as f32;
            let step = (bw / 6.0).floor().max(1.0) as usize;
            for (b, out) in row_out.iter_mut().enumerate() {
                let x0 = (b as f32 * bw).floor() as usize;
                let x1 = ((b as f32 + 1.0) * bw).floor() as usize;
                let x1 = std::cmp::max(x0 + 1, x1);
                let mut sum = 0f32;
                let mut n = 0usize;
                let mut x = x0;
                while x < x1 && x < w {
                    let i = row + x * 4;
                    // frame 是 BGRA：R = i+2, G = i+1, B = i
                    sum += frame[i + 2] as f32 * 0.299
                        + frame[i + 1] as f32 * 0.587
                        + frame[i] as f32 * 0.114;
                    n += 1;
                    x += step;
                }
                *out = if n > 0 { sum / n as f32 } else { 0.0 };
            }
        });
    sig
}

/// prev 的第 (y+s) 行与 next 的第 y 行之差的桶均值
#[inline]
fn row_cost(prev: &[f32], next: &[f32], s: usize, y: usize) -> f32 {
    let pi = (y + s) * BUCKETS;
    let ni = y * BUCKETS;
    let mut d = 0f32;
    for b in 0..BUCKETS {
        d += (prev[pi + b] - next[ni + b]).abs();
    }
    d / BUCKETS as f32
}

fn mean_cost(prev: &[f32], next: &[f32], s: usize, h: usize, row_step: usize) -> f32 {
    let overlap = h.saturating_sub(s);
    let mut sum = 0f32;
    let mut n = 0usize;
    let mut y = 0;
    while y < overlap {
        sum += row_cost(prev, next, s, y);
        n += 1;
        y += row_step;
    }
    if n > 0 { sum / n as f32 } else { f32::INFINITY }
}

/// 截尾均值：忽略差异最大的 30% 行（吸顶元素、闪烁光标等）
fn trimmed_cost(prev: &[f32], next: &[f32], s: usize, h: usize) -> f32 {
    let overlap = h.saturating_sub(s);
    if overlap == 0 {
        return f32::INFINITY;
    }
    let mut arr: Vec<f32> = (0..overlap).map(|y| row_cost(prev, next, s, y)).collect();
    arr.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let keep = std::cmp::max(1, (overlap as f32 * 0.7) as usize);
    let sum: f32 = arr[..keep].iter().sum();
    sum / keep as f32
}

/// 0 = 画面没变；-1 = 找不到可靠重叠；>0 = 内容向上移动的像素行数
/// hint：调用方已知的大致滚动量，仅用于在多个等价候选中取舍
fn find_shift(prev: &[f32], next: &[f32], h: usize, hint: usize) -> isize {
    if mean_cost(prev, next, 0, h, 2) < 1.2 {
        return 0;
    }
    let min_overlap = std::cmp::max(24, (h as f32 * 0.08) as usize);
    if h <= min_overlap {
        return -1;
    }
    let max_shift = h - min_overlap;
    let coarse_step = if h > 900 { 2 } else { 1 };

    let costs: Vec<(usize, f32)> = (0..((max_shift - 1) / coarse_step + 1))
        .into_par_iter()
        .map(|k| {
            let s = 1 + k * coarse_step;
            let overlap = h - s;
            let row_step = std::cmp::max(1, overlap / 240);
            (s, mean_cost(prev, next, s, h, row_step))
        })
        .collect();

    let best_cost = costs.iter().map(|k| k.1).fold(f32::INFINITY, f32::min);
    // 近似并列的候选（大片空白）：优先取最接近 hint 的，否则取重叠最大的（即最小 s）
    let ties: Vec<usize> = costs
        .iter()
        .filter(|k| k.1 <= best_cost + 0.8)
        .map(|k| k.0)
        .collect();
    if ties.is_empty() {
        return -1;
    }
    let mut best = ties[0];
    if ties.len() > 1 && hint > 0 {
        for &s in &ties[1..] {
            if (s as i64 - hint as i64).abs() < (best as i64 - hint as i64).abs() {
                best = s;
            }
        }
    }

    // ±2 行内用截尾均值精细化
    let lo = best.saturating_sub(2).max(1);
    let hi = std::cmp::min(max_shift, best + 2);
    let mut fine = best;
    let mut fine_cost = f32::INFINITY;
    for s in lo..=hi {
        let c = trimmed_cost(prev, next, s, h);
        if c < fine_cost {
            fine_cost = c;
            fine = s;
        }
    }
    if fine_cost < 10.0 {
        fine as isize
    } else {
        -1
    }
}

/* ---------------- Tauri 命令 ---------------- */

type JoinResult<T> = Result<T, String>;

#[tauri::command]
pub async fn long_begin(
    app: tauri::AppHandle,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
) -> JoinResult<LongState> {
    let stitcher = { app.state::<SharedState>().stitcher.clone() };
    tauri::async_runtime::spawn_blocking(move || -> JoinResult<LongState> {
        let frame = crate::capture::grab_rect(x, y, w as i32, h as i32)?;
        let mut g = stitcher.lock().map_err(|_| "拼接器状态丢失".to_string())?;
        g.begin((x, y, w, h), frame)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn long_push(app: tauri::AppHandle, hint: i32) -> JoinResult<LongState> {
    let stitcher = { app.state::<SharedState>().stitcher.clone() };
    tauri::async_runtime::spawn_blocking(move || -> JoinResult<LongState> {
        let mut g = stitcher.lock().map_err(|_| "拼接器状态丢失".to_string())?;
        if g.is_full() {
            return Ok(g.full_state());
        }
        let (x, y, w, h) = g.region().ok_or_else(|| "长截图尚未开始".to_string())?;
        let frame = crate::capture::grab_rect(x, y, w as i32, h as i32)?;
        g.push(frame, hint.max(0) as usize)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn long_preview(app: tauri::AppHandle) -> JoinResult<tauri::ipc::Response> {
    let stitcher = { app.state::<SharedState>().stitcher.clone() };
    tauri::async_runtime::spawn_blocking(move || -> JoinResult<tauri::ipc::Response> {
        let g = stitcher.lock().map_err(|_| "拼接器状态丢失".to_string())?;
        let png = g.preview_png()?;
        Ok(tauri::ipc::Response::new(png))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn long_finish(app: tauri::AppHandle) -> JoinResult<tauri::ipc::Response> {
    let stitcher = { app.state::<SharedState>().stitcher.clone() };
    tauri::async_runtime::spawn_blocking(move || -> JoinResult<tauri::ipc::Response> {
        let g = stitcher.lock().map_err(|_| "拼接器状态丢失".to_string())?;
        let png = g.output_png()?;
        Ok(tauri::ipc::Response::new(png))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn long_cancel(app: tauri::AppHandle) {
    if let Ok(mut g) = app.state::<SharedState>().stitcher.lock() {
        g.cancel();
    }
}
