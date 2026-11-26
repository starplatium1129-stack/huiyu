use std::ptr::null_mut;
use std::sync::atomic::{AtomicU32, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::DataExchange::{
    AddClipboardFormatListener, GetClipboardSequenceNumber, RemoveClipboardFormatListener,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Power::{RegisterPowerSettingNotification, UnregisterPowerSettingNotification};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, MsgWaitForMultipleObjectsEx,
    PeekMessageW, RegisterClassW, TranslateMessage, DBT_DEVNODES_CHANGED, DEVICE_NOTIFY_WINDOW_HANDLE,
    MSG, MWMO_INPUTAVAILABLE, PBT_APMPOWERSTATUSCHANGE, PBT_APMRESUMEAUTOMATIC, PBT_POWERSETTINGCHANGE,
    PM_REMOVE, QS_ALLINPUT, SPI_SETWORKAREA, WM_CLIPBOARDUPDATE, WM_DEVICECHANGE, WM_DISPLAYCHANGE,
    WM_POWERBROADCAST, WM_QUIT, WM_SETTINGCHANGE, WNDCLASSW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    WS_POPUP,
};

use crate::state::AppState;

const POWER: u32 = 1;
const RESUME: u32 = 2;
const DISPLAY: u32 = 4;
const CLIPBOARD: u32 = 8;
const ACDC_POWER_SOURCE: windows_sys::core::GUID =
    windows_sys::core::GUID::from_u128(0x5d3e9a59_e9d5_4b00_a6bd_ff34ff516548);
static PENDING: AtomicU32 = AtomicU32::new(0);

extern "system" fn watch_window_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let flag = match (message, wparam as u32) {
        (WM_CLIPBOARDUPDATE, _) => CLIPBOARD,
        (WM_POWERBROADCAST, PBT_APMRESUMEAUTOMATIC) => RESUME | POWER | DISPLAY,
        (WM_POWERBROADCAST, PBT_APMPOWERSTATUSCHANGE | PBT_POWERSETTINGCHANGE) => POWER,
        (WM_DISPLAYCHANGE, _) | (WM_DEVICECHANGE, DBT_DEVNODES_CHANGED)
        | (WM_SETTINGCHANGE, SPI_SETWORKAREA | 0) => DISPLAY,
        _ => 0,
    };
    if flag != 0 {
        PENDING.fetch_or(flag, Ordering::Release);
        return if message == WM_POWERBROADCAST { 1 } else { 0 };
    }
    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

fn create_event_window() -> HWND {
    let class_name: Vec<_> = "aics_desktop_system_events".encode_utf16().chain([0]).collect();
    unsafe {
        let instance = GetModuleHandleW(std::ptr::null());
        let window_class = WNDCLASSW {
            lpfnWndProc: Some(watch_window_proc),
            hInstance: instance,
            lpszClassName: class_name.as_ptr(),
            ..std::mem::zeroed()
        };
        if RegisterClassW(&window_class) == 0
            && windows_sys::Win32::Foundation::GetLastError() != windows_sys::Win32::Foundation::ERROR_CLASS_ALREADY_EXISTS
        {
            return null_mut();
        }
        // WM_POWERBROADCAST and WM_DISPLAYCHANGE go to top-level windows.
        // A hidden top-level window receives them without adding taskbar UI.
        CreateWindowExW(
            WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW, class_name.as_ptr(), class_name.as_ptr(),
            WS_POPUP, 0, 0, 0, 0, null_mut(), null_mut(), instance, std::ptr::null(),
        )
    }
}

pub fn start_system_watch(app: AppHandle, watch_clipboard: bool) {
    thread::spawn(move || {
        let state = app.state::<AppState>();
        let hwnd = create_event_window();
        let clipboard = watch_clipboard.then(|| super::clipboard::start(app.clone()));
        let listening_clipboard = clipboard.is_some() && !hwnd.is_null()
            && unsafe { AddClipboardFormatListener(hwnd) } != 0;
        let power_notification = if hwnd.is_null() {
            0
        } else {
            unsafe { RegisterPowerSettingNotification(hwnd, &ACDC_POWER_SOURCE, DEVICE_NOTIFY_WINDOW_HANDLE) }
        };

        let mut last_battery = super::on_battery_power();
        let mut last_areas = crate::main_shared::display_work_areas(&app);
        let mut display_at = None;
        let mut last_sequence = unsafe { GetClipboardSequenceNumber() };
        let mut last_poll = Instant::now();
        let mut poll_at = last_poll + Duration::from_secs(3);
        'watch: while !state.quitting.load(Ordering::Acquire) {
            unsafe {
                let mut message: MSG = std::mem::zeroed();
                while PeekMessageW(&mut message, null_mut(), 0, 0, PM_REMOVE) != 0 {
                    if message.message == WM_QUIT { break 'watch; }
                    TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
            let now = Instant::now();
            let mut changes = PENDING.swap(0, Ordering::AcqRel);
            if (clipboard.is_some() && !listening_clipboard || hwnd.is_null()) && now >= poll_at {
                if clipboard.is_some() && !listening_clipboard {
                    let sequence = unsafe { GetClipboardSequenceNumber() };
                    if sequence != 0 && sequence != last_sequence {
                        changes |= CLIPBOARD;
                        last_sequence = sequence;
                    }
                }
                if hwnd.is_null() {
                    changes |= DISPLAY | POWER;
                    if now.duration_since(last_poll) > Duration::from_secs(15) { changes |= RESUME; }
                }
                last_poll = now;
                poll_at = now + Duration::from_secs(3);
            }
            if changes & DISPLAY != 0 {
                display_at = Some(now + Duration::from_millis(150));
            }
            if display_at.is_some_and(|deadline| now >= deadline) {
                display_at = None;
                let areas = crate::main_shared::display_work_areas(&app);
                if areas != last_areas {
                    last_areas = areas;
                    super::clamp_windows(&app, &last_areas);
                }
            }
            if changes & POWER != 0 {
                let battery = super::on_battery_power();
                if battery != last_battery {
                    last_battery = battery;
                    let _ = app.emit("aics:power-mode", battery);
                }
            }
            if changes & RESUME != 0 {
                let _ = app.emit("aics:resume", ());
            }
            if changes & CLIPBOARD != 0 {
                if let Some(clipboard) = &clipboard { let _ = clipboard.try_send(()); }
            }
            // Timeout checks app shutdown and the pending display debounce.
            // Polling for changes is only a fallback if registration failed.
            unsafe { MsgWaitForMultipleObjectsEx(0, std::ptr::null(), 250, QS_ALLINPUT, MWMO_INPUTAVAILABLE); }
        }
        unsafe {
            if listening_clipboard { RemoveClipboardFormatListener(hwnd); }
            if power_notification != 0 { UnregisterPowerSettingNotification(power_notification); }
            if !hwnd.is_null() { DestroyWindow(hwnd); }
        }
    });
}
