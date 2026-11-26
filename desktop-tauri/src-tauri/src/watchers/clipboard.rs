use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::sync::atomic::Ordering;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, EventTarget, Manager, WebviewWindow};
use windows_sys::Win32::Foundation::HGLOBAL;
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, GetClipboardData, GetClipboardSequenceNumber, IsClipboardFormatAvailable,
    OpenClipboard, RegisterClipboardFormatW,
};
use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

use crate::state::AppState;

const CLIPBOARD_WINDOWS: [&str; 2] = ["companion", "companion-chat"];
const CF_DIB: u32 = 8;
const CF_UNICODETEXT: u32 = 13;
const MAX_DIB_BYTES: usize = 32 * 1024 * 1024;
const MAX_IMAGE_PIXELS: u32 = 8_500_000;
const MAX_PNG_BYTES: usize = 3 * 1024 * 1024;
const MAX_TEXT_CHARS: usize = 400;
const CAPTURE_INTERVAL: Duration = Duration::from_millis(1250);

fn trusted(window: &WebviewWindow) -> bool {
    window.url().ok().is_some_and(|url| crate::main_shared::is_gateway_origin(window.app_handle(), &url))
}

pub(super) fn authorize(window: &WebviewWindow) -> Result<(), String> {
    if matches!(window.label(), "atelier" | "companion") && trusted(window) {
        Ok(())
    } else {
        Err("此窗口不能管理剪贴板感知".into())
    }
}

fn enabled(state: &AppState) -> bool {
    state.preferences.lock().is_ok_and(|prefs| prefs.clipboard_awareness)
}

fn can_receive(app: &AppHandle, label: &str) -> bool {
    app.get_webview_window(label)
        .is_some_and(|window| window.is_visible().unwrap_or(false) && trusted(&window))
}

pub(super) fn start(app: AppHandle) -> SyncSender<()> {
    let (send, receive) = mpsc::sync_channel(1);
    let initial_sequence = unsafe { GetClipboardSequenceNumber() };
    thread::spawn(move || {
        let state = app.state::<AppState>();
        let formats = PrivateFormats::register();
        let mut observed_sequence = initial_sequence;
        let mut last_content = None;
        let mut next_capture = Instant::now();
        while !state.quitting.load(Ordering::Acquire) {
            match receive.recv_timeout(Duration::from_millis(250)) {
                Ok(()) => {}
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => break,
            }
            if !enabled(&state) || !CLIPBOARD_WINDOWS.iter().any(|label| can_receive(&app, label)) {
                observed_sequence = unsafe { GetClipboardSequenceNumber() };
                continue;
            }
            // Keep the newest change while the previous image conversion cools down.
            while Instant::now() < next_capture && !state.quitting.load(Ordering::Acquire) {
                thread::sleep(next_capture.saturating_duration_since(Instant::now()).min(Duration::from_millis(100)));
            }
            let sequence = unsafe { GetClipboardSequenceNumber() };
            if state.quitting.load(Ordering::Acquire) || !enabled(&state)
                || !CLIPBOARD_WINDOWS.iter().any(|label| can_receive(&app, label))
                || (sequence != 0 && sequence == observed_sequence)
            {
                continue;
            }
            let mut clipboard = Clipboard::open();
            for _ in 0..2 {
                if clipboard.is_some() || state.quitting.load(Ordering::Acquire) || !enabled(&state) { break; }
                thread::sleep(Duration::from_millis(50));
                clipboard = Clipboard::open();
            }
            let Some(clipboard) = clipboard else { continue; };
            observed_sequence = sequence;
            next_capture = Instant::now() + CAPTURE_INTERVAL;
            if formats.excludes_current_item() { continue; }

            let content = clipboard.read();
            // Never hold the Windows clipboard while decoding or encoding a screenshot.
            drop(clipboard);
            let Some(content) = content else { continue; };
            let signature = content.signature();
            if last_content == Some(signature) { continue; }
            let event = match content {
                Content::Image(dib) => {
                    let Some(png) = dib_to_png(&dib) else { continue; };
                    ClipboardEvent::Image(STANDARD.encode(png))
                }
                Content::Text(text) => ClipboardEvent::Text(text),
            };
            // A clipboard change or switch-off while encoding invalidates the pending delivery.
            if state.quitting.load(Ordering::Acquire) || !enabled(&state)
                || (sequence != 0 && unsafe { GetClipboardSequenceNumber() } != sequence)
            {
                continue;
            }
            for label in CLIPBOARD_WINDOWS {
                if can_receive(&app, label) {
                    let target = EventTarget::webview_window(label);
                    match &event {
                        ClipboardEvent::Image(png) => { let _ = app.emit_to(target, "aics:clipboard-image", png); }
                        ClipboardEvent::Text(text) => { let _ = app.emit_to(target, "aics:clipboard-text", text); }
                    }
                }
            }
            last_content = Some(signature);
        }
    });
    send
}

struct Clipboard;
impl Clipboard {
    fn open() -> Option<Self> {
        (unsafe { OpenClipboard(std::ptr::null_mut()) } != 0).then_some(Self)
    }

    fn read(&self) -> Option<Content> {
        if let Some(dib) = read_format(CF_DIB, MAX_DIB_BYTES, |bytes| {
            checked_dib_size(bytes).map(|_| bytes.to_vec())
        }) {
            return Some(Content::Image(dib));
        }
        read_format(CF_UNICODETEXT, (MAX_TEXT_CHARS * 2 + 1) * 2, |bytes| {
            let units = bytes.chunks_exact(2)
                .map(|unit| u16::from_le_bytes([unit[0], unit[1]]));
            let mut text_units = Vec::new();
            let mut terminated = false;
            for unit in units {
                if unit == 0 {
                    terminated = true;
                    break;
                }
                text_units.push(unit);
            }
            if !terminated { return None; }
            let value = String::from_utf16_lossy(&text_units);
            let text = value.trim();
            ((4..=MAX_TEXT_CHARS).contains(&text.chars().count()) && !sensitive_text(text))
                .then(|| Content::Text(text.to_owned()))
        })
    }
}
impl Drop for Clipboard {
    fn drop(&mut self) { unsafe { CloseClipboard(); } }
}

struct GlobalView(HGLOBAL);
impl Drop for GlobalView {
    fn drop(&mut self) { unsafe { GlobalUnlock(self.0); } }
}

fn read_format<T>(format: u32, max_bytes: usize, read: impl FnOnce(&[u8]) -> Option<T>) -> Option<T> {
    if format == 0 || unsafe { IsClipboardFormatAvailable(format) } == 0 { return None; }
    let handle = unsafe { GetClipboardData(format) };
    if handle.is_null() { return None; }
    let size = unsafe { GlobalSize(handle) };
    if size == 0 || size > max_bytes { return None; }
    let pointer = unsafe { GlobalLock(handle) }.cast::<u8>();
    if pointer.is_null() { return None; }
    let _locked = GlobalView(handle);
    read(unsafe { std::slice::from_raw_parts(pointer, size) })
}

struct PrivateFormats {
    excluded: u32,
    history: u32,
    cloud: u32,
    password_manager: u32,
}
impl PrivateFormats {
    fn register() -> Self {
        fn format(name: &str) -> u32 {
            let wide: Vec<_> = name.encode_utf16().chain([0]).collect();
            unsafe { RegisterClipboardFormatW(wide.as_ptr()) }
        }
        Self {
            excluded: format("ExcludeClipboardContentFromMonitorProcessing"),
            history: format("CanIncludeInClipboardHistory"),
            cloud: format("CanUploadToCloudClipboard"),
            password_manager: format("Clipboard Viewer Ignore"),
        }
    }

    fn excludes_current_item(&self) -> bool {
        let present = |format| format != 0 && unsafe { IsClipboardFormatAvailable(format) } != 0;
        let restrict = |format| present(format) && read_format(format, 64, |bytes| {
            Some(bytes.get(..4)? != [0, 0, 0, 0])
        }) != Some(true);
        present(self.excluded) || present(self.password_manager) || restrict(self.history) || restrict(self.cloud)
    }
}

fn sensitive_text(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    let words = [
        "password", "passphrase", "authorization:", "bearer ", "cookie:", "api_key", "api-key",
        "api key", "access_token", "secret_key", "private key", "client_secret", "密码", "口令",
        "验证码", "访问令牌",
    ];
    let compact = value.is_ascii() && !value.bytes().any(|c| c.is_ascii_whitespace());
    words.iter().any(|word| lower.contains(word))
        || ["sk-", "ghp_", "github_pat_", "xoxb-", "xoxp-", "eyj"]
            .iter().any(|prefix| lower.starts_with(prefix))
        || value.bytes().all(|c| c.is_ascii_digit())
        || (compact && value.len() >= 12
            && value.bytes().any(|c| c.is_ascii_alphabetic())
            && value.bytes().any(|c| c.is_ascii_digit())
            && !value.contains("://"))
}

enum Content { Image(Vec<u8>), Text(String) }
enum ClipboardEvent { Image(String), Text(String) }
impl Content {
    fn signature(&self) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        std::mem::discriminant(self).hash(&mut hash);
        match self {
            Self::Image(dib) => dib.hash(&mut hash),
            Self::Text(text) => text.hash(&mut hash),
        }
        hash.finish()
    }
}

fn checked_dib_size(dib: &[u8]) -> Option<(u32, u32, usize)> {
    let header = u32::from_le_bytes(dib.get(..4)?.try_into().ok()?) as usize;
    if header < 40 || dib.len() < header { return None; }
    let width = u32::try_from(i32::from_le_bytes(dib[4..8].try_into().ok()?)).ok()?;
    let height = i32::from_le_bytes(dib[8..12].try_into().ok()?).unsigned_abs();
    let bit_count = u16::from_le_bytes(dib[14..16].try_into().ok()?);
    if width == 0 || height == 0 || width > 4096 || height > 4096
        || width.checked_mul(height)? > MAX_IMAGE_PIXELS || !matches!(bit_count, 1 | 4 | 8 | 16 | 24 | 32)
    {
        return None;
    }
    let compression = u32::from_le_bytes(dib[16..20].try_into().ok()?);
    let colors = u32::from_le_bytes(dib[32..36].try_into().ok()?) as usize;
    let palette = if colors > 0 { colors } else if bit_count <= 8 { 1 << bit_count } else { 0 };
    // For the 40-byte header, BI_BITFIELDS masks are outside the header.
    let masks = if header == 40 && compression == 3 { 12 } else { 0 };
    let pixels = header.checked_add(masks)?.checked_add(palette.checked_mul(4)?)?;
    (pixels <= dib.len()).then_some((width, height, pixels))
}

fn dib_to_png(dib: &[u8]) -> Option<Vec<u8>> {
    let (_, _, offset) = checked_dib_size(dib)?;
    let file_size = u32::try_from(14 + dib.len()).ok()?;
    let mut bmp = Vec::with_capacity(file_size as usize);
    bmp.extend_from_slice(b"BM");
    bmp.extend_from_slice(&file_size.to_le_bytes());
    bmp.extend_from_slice(&[0u8; 4]);
    bmp.extend_from_slice(&u32::try_from(14 + offset).ok()?.to_le_bytes());
    bmp.extend_from_slice(dib);
    let image = image::load_from_memory_with_format(&bmp, image::ImageFormat::Bmp).ok()?;
    let mut png = Vec::new();
    image.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).ok()?;
    (png.len() <= MAX_PNG_BYTES).then_some(png)
}
