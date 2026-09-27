use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use windows_sys::Win32::Foundation::POINT;
use windows_sys::Win32::Graphics::Gdi::{EnumDisplayMonitors, HDC};
use windows_sys::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use windows_sys::Win32::System::Power::GetSystemPowerStatus;
use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;

/// 全局鼠标轮询：约 30fps，坐标变化 >=2px 才发；仅可见桌宠需要凝视事件。
/// 事件名 aics:global-mouse，payload 与 Electron 版 desktop:global-mouse 同构。
pub fn start_global_mouse_watch(app: AppHandle) {
    thread::spawn(move || {
        let mut last_x = i32::MAX;
        let mut last_y = i32::MAX;
        loop {
            let Some(window) = app.get_webview_window("companion").filter(|window| window.is_visible().unwrap_or(false)) else {
                thread::sleep(Duration::from_millis(500));
                continue;
            };
            thread::sleep(Duration::from_millis(33));
            let mut pt = POINT { x: 0, y: 0 };
            unsafe {
                if GetCursorPos(&mut pt) == 0 {
                    continue;
                }
            }
            if (pt.x - last_x).abs() < 2 && (pt.y - last_y).abs() < 2 {
                continue;
            }
            last_x = pt.x;
            last_y = pt.y;
            let state = Some(window).and_then(|w| {
                match (w.outer_position().ok(), w.outer_size().ok()) {
                    (Some(p), Some(s)) => Some(GlobalMouse {
                        x: pt.x,
                        y: pt.y,
                        in_window: pt.x >= p.x
                            && pt.x <= p.x + s.width as i32
                            && pt.y >= p.y
                            && pt.y <= p.y + s.height as i32,
                        bounds: Bounds {
                            x: p.x,
                            y: p.y,
                            width: s.width,
                            height: s.height,
                        },
                    }),
                    _ => None,
                }
            });
            if let Some(state) = state {
                let _ = app.emit("aics:global-mouse", state);
            }
        }
    });
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Bounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GlobalMouse {
    x: i32,
    y: i32,
    in_window: bool,
    bounds: Bounds,
}

/// 剪贴板轮询：图片（CF_DIB→PNG）或文本（4-400 字）变化时通知 Companion。
/// 事件：aics:clipboard-image（Uint8Array PNG）/ aics:clipboard-text（String）。
pub fn start_clipboard_watch(app: AppHandle) {
    thread::spawn(move || {
        let mut text_signature = String::new();
        let mut image_signature = 0u32;
        loop {
            thread::sleep(Duration::from_millis(1500));
            if app.get_webview_window("companion").map(|w| w.is_visible().unwrap_or(false)).unwrap_or(false) == false {
                continue;
            }
            if let Some((png, signature)) = read_clipboard_image() {
                if signature != image_signature && !png.is_empty() {
                    image_signature = signature;
                    let _ = app.emit("aics:clipboard-image", png);
                }
                continue;
            }
            if let Some(text) = read_clipboard_text() {
                let trimmed = text.trim().to_string();
                if (4..=400).contains(&trimmed.chars().count()) {
                    let signature = hash_string(&trimmed);
                    if signature != text_signature {
                        text_signature = signature;
                        let _ = app.emit("aics:clipboard-text", trimmed);
                    }
                } else if trimmed.is_empty() {
                    text_signature.clear();
                }
            }
        }
    });
}

fn read_clipboard_text() -> Option<String> {
    unsafe {
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return None;
        }
        let handle = GetClipboardData(13); // CF_UNICODETEXT
        if handle.is_null() {
            CloseClipboard();
            return None;
        }
        let ptr = GlobalLock(handle) as *const u16;
        if ptr.is_null() {
            CloseClipboard();
            return None;
        }
        let mut len = 0;
        while *ptr.add(len) != 0 {
            len += 1;
        }
        let text = String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len));
        GlobalUnlock(handle);
        CloseClipboard();
        Some(text)
    }
}

fn read_clipboard_image() -> Option<(Vec<u8>, u32)> {
    unsafe {
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return None;
        }
        let handle = GetClipboardData(8); // CF_DIB
        if handle.is_null() {
            CloseClipboard();
            return None;
        }
        let ptr = GlobalLock(handle) as *const u8;
        if ptr.is_null() {
            CloseClipboard();
            return None;
        }
        let size = GlobalSize(handle);
        let data = std::slice::from_raw_parts(ptr, size);
        let png = dib_to_png(data);
        let signature = data.iter().fold(5381u32, |h, b| h.wrapping_mul(33).wrapping_add(*b as u32));
        GlobalUnlock(handle);
        CloseClipboard();
        png.map(|p| (p, signature))
    }
}

/// CF_DIB（BITMAPINFOHEADER + 像素）→ 补 BITMAPFILEHEADER 构造完整 BMP → 解码 → PNG。
fn dib_to_png(dib: &[u8]) -> Option<Vec<u8>> {
    if dib.len() < 40 {
        return None;
    }
    let bi_size = u32::from_le_bytes(dib[0..4].try_into().ok()?) as usize;
    if bi_size < 40 || dib.len() < bi_size {
        return None;
    }
    let width = i32::from_le_bytes(dib[4..8].try_into().ok()?);
    let height = i32::from_le_bytes(dib[8..12].try_into().ok()?);
    let bit_count = u16::from_le_bytes(dib[14..16].try_into().ok()?);
    if width <= 0 || height == 0 || !(1..=32).contains(&bit_count) {
        return None;
    }
    // 调色板：biClrUsed 或按位深推算（<=8bpp）
    let clr_used = u32::from_le_bytes(dib[32..36].try_into().ok()?) as usize;
    let palette_entries = if clr_used > 0 {
        clr_used
    } else if bit_count <= 8 {
        1usize << bit_count
    } else {
        0
    };
    let palette_bytes = palette_entries * 4;
    let header_size = bi_size + palette_bytes;
    if dib.len() < header_size {
        return None;
    }
    let file_size = 14 + header_size + dib.len().saturating_sub(bi_size).max(palette_bytes);
    let mut bmp = Vec::with_capacity(file_size);
    bmp.extend_from_slice(b"BM");
    bmp.extend_from_slice(&(file_size as u32).to_le_bytes());
    bmp.extend_from_slice(&[0u8; 4]);
    bmp.extend_from_slice(&((14 + header_size) as u32).to_le_bytes());
    bmp.extend_from_slice(dib);
    let image = image::load_from_memory(&bmp).ok()?;
    let mut out = Vec::new();
    image.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png).ok()?;
    Some(out)
}

fn hash_string(value: &str) -> String {
    let mut hash = 5381u32;
    for byte in value.bytes() {
        hash = hash.wrapping_mul(33).wrapping_add(byte as u32);
    }
    format!("{hash:x}")
}

/// 电源轮询：AC/电池变化时发 aics:power-mode（bool = 电池）。
pub fn on_battery_power() -> bool {
    unsafe {
        let mut status = std::mem::zeroed::<windows_sys::Win32::System::Power::SYSTEM_POWER_STATUS>();
        GetSystemPowerStatus(&mut status) != 0 && status.ACLineStatus == 0
    }
}

pub fn start_power_watch(app: AppHandle) {
    thread::spawn(move || {
        let mut last_battery: Option<bool> = None;
        let mut last_check = Instant::now();
        loop {
            thread::sleep(Duration::from_secs(5));
            let now = Instant::now();
            let on_battery = on_battery_power();
            if last_battery != Some(on_battery) {
                last_battery = Some(on_battery);
                let _ = app.emit("aics:power-mode", on_battery);
            }
            // A long polling gap indicates sleep/hibernation. Notify the
            // desktop bridge once after resume so Companion can re-sync room
            // state and Live2D visibility.
            if now.duration_since(last_check) > Duration::from_secs(15) {
                let _ = app.emit("aics:resume", ());
            }
            last_check = now;
        }
    });
}

/// 显示器轮询：监视器数量/工作区变化时把 Companion 与 Atelier 拉回屏内。
pub fn start_display_watch(app: AppHandle) {
    thread::spawn(move || {
        let mut last_count = monitor_count();
        let mut last_area = primary_work_area();
        loop {
            thread::sleep(Duration::from_secs(3));
            let count = monitor_count();
            let area = primary_work_area();
            if count != last_count || area != last_area {
                last_count = count;
                last_area = area;
                clamp_windows(&app);
            }
        }
    });
}

fn monitor_count() -> u32 {
    let mut count = 0u32;
    unsafe {
        EnumDisplayMonitors(
            HDC::default(),
            std::ptr::null(),
            Some(monitor_enum_proc),
            &mut count as *mut u32 as isize,
        );
    }
    count
}

unsafe extern "system" fn monitor_enum_proc(
    _monitor: windows_sys::Win32::Graphics::Gdi::HMONITOR,
    _dc: HDC,
    _rect: *mut windows_sys::Win32::Foundation::RECT,
    data: isize,
) -> windows_sys::Win32::Foundation::BOOL {
    let count = data as *mut u32;
    *count += 1;
    1
}

fn primary_work_area() -> (i32, i32, i32, i32) {
    unsafe {
        let x = windows_sys::Win32::UI::WindowsAndMessaging::GetSystemMetrics(76); // SM_XVIRTUALSCREEN
        let y = windows_sys::Win32::UI::WindowsAndMessaging::GetSystemMetrics(77);
        let w = windows_sys::Win32::UI::WindowsAndMessaging::GetSystemMetrics(78);
        let h = windows_sys::Win32::UI::WindowsAndMessaging::GetSystemMetrics(79);
        (x, y, w, h)
    }
}

fn clamp_windows(app: &AppHandle) {
    let area = primary_work_area();
    if area.2 <= 0 || area.3 <= 0 {
        return;
    }
    for label in ["companion", "companion-chat", "atelier"] {
        if let Some(w) = app.get_webview_window(label) {
            let Ok(pos) = w.outer_position() else { continue };
            let Ok(size) = w.outer_size() else { continue };
            let bounds = crate::window_state::clamp_window_bounds(
                &crate::window_state::WindowBounds {
                    x: pos.x as i64,
                    y: pos.y as i64,
                    width: size.width as i64,
                    height: size.height as i64,
                },
                (area.0 as i64, area.1 as i64, area.2 as i64, area.3 as i64),
                None,
            );
            let _ = w.set_position(tauri::PhysicalPosition::new(bounds.x as i32, bounds.y as i32));
        }
    }
}
