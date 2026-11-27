//! Model cadence is independent of overlay placement and monitor refresh.
use std::sync::mpsc::Receiver;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{HWND, RECT};
use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows_sys::Win32::Graphics::Gdi::{
    CombineRgn, CreateRectRgn, DeleteObject, EnumDisplaySettingsW, GetMonitorInfoW,
    GetWindowRgn, MonitorFromWindow, SetRectRgn, DEVMODEW, ENUM_CURRENT_SETTINGS,
    MONITORINFOEXW, MONITOR_DEFAULTTONEAREST, NULLREGION, RGN_DIFF,
};
use windows_sys::Win32::UI::Shell::{SHQueryUserNotificationState, QUNS_NOT_PRESENT, QUNS_RUNNING_D3D_FULL_SCREEN};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetShellWindow, GetWindow, GetWindowLongPtrW, IsIconic, IsWindowVisible, IsZoomed,
    GW_HWNDPREV, GWL_EXSTYLE, WS_EX_LAYERED, WS_EX_NOREDIRECTIONBITMAP, WS_EX_TRANSPARENT,
};

pub const FALLBACK_HZ: u32 = 60;
const IDLE_HZ: u32 = 30;

pub fn initial_fps(value: Option<&str>) -> u32 {
    value.and_then(|v| v.parse::<u32>().ok()).filter(|f| *f <= 1000).unwrap_or(0)
}

pub fn display_refresh_hz(hwnd: HWND) -> u32 {
    unsafe {
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info: MONITORINFOEXW = std::mem::zeroed();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        let mut mode: DEVMODEW = std::mem::zeroed();
        mode.dmSize = std::mem::size_of::<DEVMODEW>() as u16;
        if !monitor.is_null() && GetMonitorInfoW(monitor, (&mut info as *mut MONITORINFOEXW).cast()) != 0
            && EnumDisplaySettingsW(info.szDevice.as_ptr(), ENUM_CURRENT_SETTINGS, &mut mode) != 0
            && (2..=1000).contains(&mode.dmDisplayFrequency)
        { mode.dmDisplayFrequency } else { FALLBACK_HZ }
    }
}

pub fn model_fps(limit: u32, display_hz: u32, active: bool) -> u32 {
    let configured = if limit == 0 { display_hz } else { display_hz.min(limit) };
    if active { configured } else { configured.min(IDLE_HZ) }
}

pub fn interval(hz: u32) -> Duration {
    Duration::from_secs_f64(1.0 / f64::from(hz))
}

pub fn texture_dimensions(width: u32, height: u32, scale: u32) -> (u32, u32) {
    let divisor = if matches!(scale, 2 | 4) { scale } else { 1 };
    ((width / divisor).max(1), (height / divisor).max(1))
}

/// Hidden windows wake for commands immediately, or every 250 ms to pump Win32 messages.
/// Disconnection is handled by the owning loop's existing try_recv/stopped path.
pub fn wait<T>(commands: &Receiver<T>, next_tick: Option<Instant>) -> Option<T> {
    let timeout = next_tick.map_or(Duration::from_millis(250), |deadline| {
        deadline.saturating_duration_since(Instant::now())
    });
    commands.recv_timeout(timeout).ok()
}

pub fn desktop_blocks_present() -> bool {
    let mut status = 0;
    unsafe {
        SHQueryUserNotificationState(&mut status) >= 0
            && matches!(status, QUNS_NOT_PRESENT | QUNS_RUNNING_D3D_FULL_SCREEN)
    }
}

/// Only confirmed opaque rectangular windows can retire the visible area.
/// Omitting uncertain surfaces keeps transparent overlays from freezing the pet.
pub fn fully_covered(window: HWND, companion: HWND, rect: super::OverlayRect) -> bool {
    if rect.width == 0 || rect.height == 0 { return false; }
    unsafe {
        let region = CreateRectRgn(rect.x, rect.y, rect.x + rect.width as i32, rect.y + rect.height as i32);
        let cover = CreateRectRgn(0, 0, 0, 0);
        let covered = if region.is_null() || cover.is_null() {
            false
        } else {
            let shell = GetShellWindow();
            let mut candidate = GetWindow(window, GW_HWNDPREV);
            let mut fully_covered = false;
            for _ in 0..128 {
                if candidate.is_null() { break; }
                if candidate != companion && candidate != shell {
                    if let Some(bounds) = opaque_window_rect(candidate, cover) {
                        SetRectRgn(cover, bounds.left, bounds.top, bounds.right, bounds.bottom);
                        if CombineRgn(region, region, cover, RGN_DIFF) == NULLREGION as i32 {
                            fully_covered = true;
                            break;
                        }
                    }
                }
                candidate = GetWindow(candidate, GW_HWNDPREV);
            }
            fully_covered
        };
        if !region.is_null() { DeleteObject(region as _); }
        if !cover.is_null() { DeleteObject(cover as _); }
        covered
    }
}

unsafe fn opaque_window_rect(window: HWND, scratch: windows_sys::Win32::Graphics::Gdi::HRGN) -> Option<RECT> {
    if IsWindowVisible(window) == 0 || IsIconic(window) != 0
        || GetWindowLongPtrW(window, GWL_EXSTYLE) as u32
            & (WS_EX_LAYERED | WS_EX_NOREDIRECTIONBITMAP | WS_EX_TRANSPARENT) != 0
    {
        return None;
    }
    let mut cloaked = 0u32;
    if DwmGetWindowAttribute(window, DWMWA_CLOAKED as u32, (&mut cloaked as *mut u32).cast(), size_of::<u32>() as u32) < 0
        || cloaked != 0
        || GetWindowRgn(window, scratch) != 0
    {
        return None;
    }
    let mut bounds: RECT = std::mem::zeroed();
    if DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS as u32, (&mut bounds as *mut RECT).cast(), size_of::<RECT>() as u32) < 0 {
        return None;
    }
    // Restored windows can have rounded DWM corners. Use an inner rectangle
    // for those windows instead of assuming every edge pixel is opaque.
    if IsZoomed(window) == 0 {
        let dpi = windows_sys::Win32::UI::HiDpi::GetDpiForWindow(window).max(96);
        let inset = (8 * dpi).div_ceil(96) as i32;
        bounds.left += inset;
        bounds.top += inset;
        bounds.right -= inset;
        bounds.bottom -= inset;
    }
    (bounds.right > bounds.left && bounds.bottom > bounds.top).then_some(bounds)
}
