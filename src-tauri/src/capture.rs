//! 屏幕捕获：BitBlt 从虚拟桌面 DC 抓取（物理像素 1:1，含分层窗口）
//!
//! 返回的数据格式：
//! - `grab_rect`   -> 纯 BGRA 字节（w*h*4，自顶向下）
//! - `grab_virtual` -> [u32 width LE][u32 height LE][BGRA...]

use std::mem::size_of;

use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, HBITMAP,
    HGDIOBJ, HDC, SRCCOPY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

/// 虚拟桌面边界（物理像素，多屏合起来的包围盒，可能有负坐标）
pub fn virtual_desktop_bounds() -> (i32, i32, i32, i32) {
    unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    }
}

/// 抓取相对虚拟桌面原点的区域，返回 BGRA（自顶向下，alpha 已归 255）
pub fn grab_rect(x: i32, y: i32, w: i32, h: i32) -> Result<Vec<u8>, String> {
    if w <= 0 || h <= 0 {
        return Err("抓取区域为空".into());
    }
    unsafe {
        let hdc_screen: HDC = GetDC(None);
        if hdc_screen.0.is_null() {
            return Err("获取屏幕 DC 失败".into());
        }
        let hdc_mem = CreateCompatibleDC(Some(hdc_screen));
        if hdc_mem.0.is_null() {
            ReleaseDC(None, hdc_screen);
            return Err("创建内存 DC 失败".into());
        }
        let hbmp: HBITMAP = CreateCompatibleBitmap(hdc_screen, w, h);
        if hbmp.0.is_null() {
            let _ = DeleteDC(hdc_mem);
            ReleaseDC(None, hdc_screen);
            return Err("创建位图失败".into());
        }
        let old = SelectObject(hdc_mem, HGDIOBJ(hbmp.0));
        // CAPTUREBLT: 一并抓取分层（alpha 叠加）窗口；我们自己此刻是隐藏的，不会拍到自己
        let blitted = BitBlt(
            hdc_mem,
            0,
            0,
            w,
            h,
            Some(hdc_screen),
            x,
            y,
            SRCCOPY | CAPTUREBLT,
        );

        let mut buf: Vec<u8> = vec![0u8; (w * h * 4) as usize];
        if blitted.is_ok() {
            let mut bmi = BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                // 负高度 = 自顶向下（与前端 ImageData 行序一致）
                biHeight: -h,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            };
            let got = GetDIBits(
                hdc_mem,
                hbmp,
                0,
                h as u32,
                Some(buf.as_mut_ptr() as *mut std::ffi::c_void),
                &mut bmi as *mut BITMAPINFOHEADER as *mut _,
                DIB_RGB_COLORS,
            );
            if got == 0 {
                buf.clear();
            }
        }

        SelectObject(hdc_mem, old);
        let _ = DeleteObject(HGDIOBJ(hbmp.0));
        let _ = DeleteDC(hdc_mem);
        ReleaseDC(None, hdc_screen);

        if blitted.is_err() || buf.is_empty() {
            return Err("BitBlt 抓屏失败".into());
        }
        // BI_RGB 32 位的 alpha 通道未定义，统一填 255
        for px in buf.as_chunks_mut::<4>().0 {
            px[3] = 255;
        }
        Ok(buf)
    }
}

/// 抓取整块虚拟桌面，返回带 8 字节头的 IPC 二进制帧
pub fn grab_virtual() -> Result<Vec<u8>, String> {
    let (x, y, w, h) = virtual_desktop_bounds();
    let data = grab_rect(x, y, w, h)?;
    let mut out = Vec::with_capacity(8 + data.len());
    out.extend_from_slice(&(w as u32).to_le_bytes());
    out.extend_from_slice(&(h as u32).to_le_bytes());
    out.extend_from_slice(&data);
    Ok(out)
}
