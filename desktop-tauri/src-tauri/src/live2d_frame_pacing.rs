//! The visible overlay and the model can run at different cadences on battery power.
use std::sync::mpsc::Receiver;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::Graphics::Gdi::{
    EnumDisplaySettingsW, GetMonitorInfoW, MonitorFromWindow, DEVMODEW, ENUM_CURRENT_SETTINGS,
    MONITORINFOEXW, MONITOR_DEFAULTTONEAREST,
};

pub const FALLBACK_HZ: u32 = 60;

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

pub fn model_fps(limit: u32, display_hz: u32) -> u32 {
    if limit == 0 { display_hz } else { display_hz.min(limit) }
}

pub fn interval(hz: u32) -> Duration {
    Duration::from_secs_f64(1.0 / f64::from(hz))
}

pub fn texture_dimensions(width: u32, height: u32, scale: u32) -> (u32, u32) {
    let divisor = if matches!(scale, 2 | 4) { scale } else { 1 };
    ((width / divisor).max(1), (height / divisor).max(1))
}

/// Hidden windows wake for commands immediately, or every 100 ms to pump Win32 messages.
/// Disconnection is handled by the owning loop's existing try_recv/stopped path.
pub fn wait<T>(commands: &Receiver<T>, next_tick: Option<Instant>) -> Option<T> {
    if let Some(deadline) = next_tick {
        std::thread::sleep(deadline.saturating_duration_since(Instant::now()));
        None
    } else {
        commands.recv_timeout(Duration::from_millis(100)).ok()
    }
}
