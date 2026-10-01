//! B 方案：剪贴板写入委托给 tauri-plugin-clipboard-manager，落盘路径由
//! tauri-plugin-dialog 的「另存为」对话框决定（Rust 只负责写字节）。

use tauri_plugin_clipboard_manager::ClipboardExt;

fn data_url_bytes(data_url: &str) -> Result<Vec<u8>, String> {
    let b64 = data_url.split_once(',').map(|(_, b)| b).unwrap_or(data_url);
    crate::util::b64_decode(b64)
}

/// 把 dataURL 形式的 PNG 交给剪贴板插件
pub fn copy_png(app: &tauri::AppHandle, data_url: &str) -> Result<(), String> {
    let png = data_url_bytes(data_url)?;
    let (w, h, rgba) = crate::png_util::decode_rgba(&png)?;
    let image = tauri::image::Image::new_owned(rgba, w, h);
    app.clipboard()
        .write_image(&image)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 写入前端已选定的路径
pub fn save_png(data_url: &str, path: &str) -> Result<String, String> {
    let bytes = data_url_bytes(data_url)?;
    if bytes.len() < 8 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
        return Err("不是有效的 PNG 数据".into());
    }
    std::fs::write(path, bytes).map_err(|e| format!("写入文件失败: {e}"))?;
    Ok(path.to_string())
}
