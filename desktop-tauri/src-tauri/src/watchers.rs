use std::sync::{atomic::{AtomicBool, Ordering}, Arc};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget, Manager, State, WebviewWindow};
use windows_sys::Win32::Foundation::{POINT, RECT};
use windows_sys::Win32::Graphics::Gdi::ClientToScreen;
use windows_sys::Win32::System::Power::GetSystemPowerStatus;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
use windows_sys::Win32::UI::WindowsAndMessaging::{GetClientRect, GetCursorPos, IsWindowVisible};
use crate::{live2d_renderer::{Live2DOverlayState, OverlayRect}, state::AppState};

mod clipboard;
mod system;
pub use system::start_system_watch;

#[tauri::command]
pub fn desktop_get_clipboard_awareness(window: WebviewWindow, state: State<AppState>) -> Result<bool, String> {
    clipboard::authorize(&window)?;
    state.preferences.lock().map(|prefs| prefs.clipboard_awareness)
        .map_err(|_| "暂时无法读取剪贴板设置".into())
}

#[tauri::command]
pub fn desktop_set_clipboard_awareness(window: WebviewWindow, state: State<AppState>, enabled: bool) -> Result<(), String> {
    clipboard::authorize(&window)?;
    let mut preferences = state.preferences.lock().map_err(|_| "暂时无法修改剪贴板设置")?;
    if preferences.clipboard_awareness == enabled { return Ok(()); }
    let mut next = preferences.clone();
    next.clipboard_awareness = enabled;
    if !crate::window_state::save_companion_preferences(&state.paths.preferences_file, &next) {
        return Err("保存剪贴板设置失败，请重试".into());
    }
    *preferences = next;
    Ok(())
}

/// 物理坐标用于透明穿透。原生渲染直接采样光标，WebView 只接收交互区、
/// 展开面板或浏览器渲染所需的坐标。
pub fn start_global_mouse_watch(app: AppHandle) {
    thread::spawn(move || {
        let state = app.state::<AppState>();
        let mut last_mouse: Option<GlobalMouse> = None;
        let applying_input = Arc::new(AtomicBool::new(false));
        let mut last_buttons = (false, false);
        let mut last_cursor = None;
        let mut refresh_at = Instant::now();
        loop {
            if state.quitting.load(Ordering::Acquire) { break; }
            if !state.companion_presentation.lock().is_ok_and(|state| state.shown) {
                last_mouse = None;
                last_buttons = (false, false);
                last_cursor = None;
                thread::sleep(Duration::from_millis(200));
                continue;
            }
            thread::sleep(Duration::from_millis(33));
            let mut pt = POINT { x: 0, y: 0 };
            let buttons = unsafe {
                if GetCursorPos(&mut pt) == 0 { continue; }
                (GetAsyncKeyState(VK_LBUTTON as i32) < 0, GetAsyncKeyState(VK_RBUTTON as i32) < 0)
            };
            let cursor = Some((pt.x, pt.y));
            let now = Instant::now();
            if last_cursor == cursor && last_buttons == buttons && now < refresh_at { continue; }
            let Some(window) = app.get_webview_window("companion") else { continue; };
            let Ok(hwnd) = window.hwnd() else { continue; };
            if unsafe { IsWindowVisible(hwnd.0) } == 0 {
                last_mouse = None;
                last_buttons = (false, false);
                last_cursor = None;
                continue;
            }

            let mut origin = POINT { x: 0, y: 0 };
            let mut client = RECT { left: 0, top: 0, right: 0, bottom: 0 };
            unsafe {
                if ClientToScreen(hwnd.0, &mut origin) == 0 || GetClientRect(hwnd.0, &mut client) == 0 {
                    continue;
                }
            }
            let bounds = OverlayRect {
                x: origin.x, y: origin.y,
                width: (client.right - client.left).max(0) as u32,
                height: (client.bottom - client.top).max(0) as u32,
            };
            let inside = bounds.contains(pt.x, pt.y);
            let local = (pt.x - origin.x, pt.y - origin.y);
            let (locked, in_panel, in_portrait, has_panels, process_frame) = {
                let Ok(mut input) = state.companion_input.lock() else { continue; };
                if input.moving {
                    last_mouse = None;
                    last_buttons = buttons;
                    last_cursor = None;
                    continue;
                }
                if input.locked && !crate::companion_window::primary_button_down() { input.locked = false; }
                let in_panel = inside && input.panels.iter().any(|rect| rect.contains(local.0, local.1));
                let in_portrait = inside && input.static_mask.as_ref().is_some_and(|mask| mask.hit(local.0, local.1));
                (input.locked, in_panel, in_portrait, !input.panels.is_empty(), input.process_frame)
            };
            let pressed = buttons.0 && !last_buttons.0 || buttons.1 && !last_buttons.1;
            last_buttons = buttons;
            last_cursor = cursor;
            // Hit pixels, panels and window bounds can change under a still
            // pointer. Refresh those edges without redoing shell/IPC work at 30 Hz.
            refresh_at = now + Duration::from_millis(if inside || locked || has_panels { 250 } else { 500 });
            let overlay = app.try_state::<Arc<Live2DOverlayState>>();
            let renderer_process = process_frame.and_then(|_| crate::live2d_process::current());
            let process_ready = renderer_process.is_some();
            let native_ready = process_ready || overlay.as_ref().is_some_and(|overlay|
                overlay.visible.load(Ordering::Acquire) && overlay.model_ready.load(Ordering::Acquire));
            let in_model = inside && (overlay.is_some_and(|overlay| overlay.hit_opaque_pixel(pt.x, pt.y))
                || renderer_process.zip(process_frame).is_some_and(|(renderer, rect)| {
                    let screen_frame = OverlayRect { x: rect.x + origin.x, y: rect.y + origin.y, ..rect };
                    renderer.pointer_hit(screen_frame, pt.x, pt.y)
                }));
            let ignore = state.ignore_mouse_events.load(Ordering::Relaxed);
            let passthrough = ignore || !(locked || in_panel || in_portrait || in_model);
            if crate::companion_window::mouse_passthrough(hwnd.0) != passthrough {
                if !applying_input.swap(true, Ordering::AcqRel) {
                    let applying = applying_input.clone();
                    let window = window.clone();
                    if app.run_on_main_thread(move || {
                        if let Ok(hwnd) = window.hwnd() {
                            let can_apply = window.state::<AppState>().companion_input.lock().is_ok_and(|input| !input.moving);
                            if can_apply && unsafe { IsWindowVisible(hwnd.0) } != 0 {
                                crate::companion_window::set_mouse_passthrough(hwnd.0, passthrough);
                            }
                        }
                        applying.store(false, Ordering::Release);
                    }).is_err() {
                        applying_input.store(false, Ordering::Release);
                        last_cursor = None;
                        refresh_at = now;
                    }
                } else {
                    // Retry on the next 33ms tick instead of deferring 250ms while a prior update is in flight.
                    last_cursor = None;
                    refresh_at = now;
                }
            }
            let target = EventTarget::webview_window("companion");
            if pressed && has_panels && passthrough { let _ = app.emit_to(target.clone(), "aics:companion-dismiss", ()); }
            let mouse = GlobalMouse {
                x: pt.x, y: pt.y, in_window: !passthrough && inside, bounds,
            };
            let moved = last_mouse.as_ref().is_none_or(|last| {
                pt.x.abs_diff(last.x) >= 2 || pt.y.abs_diff(last.y) >= 2 || mouse.bounds != last.bounds || mouse.in_window != last.in_window
            });
            if !native_ready || has_panels || locked || mouse.in_window {
                if moved {
                    let _ = app.emit_to(target, "aics:global-mouse", &mouse);
                    last_mouse = Some(mouse);
                }
            } else if last_mouse.take().is_some_and(|last| last.in_window) {
                // Interactive overlays still need the exit edge.
                let _ = app.emit_to(target, "aics:global-mouse", &mouse);
            }
        }
    });
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GlobalMouse {
    x: i32,
    y: i32,
    in_window: bool,
    bounds: OverlayRect,
}

/// 当前电源状态，供初次桌宠会话和 Windows 电源通知使用。
pub fn on_battery_power() -> bool {
    unsafe {
        let mut status = std::mem::zeroed::<windows_sys::Win32::System::Power::SYSTEM_POWER_STATUS>();
        GetSystemPowerStatus(&mut status) != 0 && status.ACLineStatus == 0
    }
}

fn clamp_windows(app: &AppHandle, monitors: &[crate::window_state::DisplayWorkArea]) {
    let areas: Vec<_> = monitors.iter().map(|monitor| monitor.bounds).collect();
    if areas.is_empty() { return; }
    for label in ["companion", "companion-chat", "atelier"] {
        if let Some(w) = app.get_webview_window(label) {
            if w.is_minimized().unwrap_or(true) || w.is_maximized().unwrap_or(true) || w.is_fullscreen().unwrap_or(true) { continue; }
            let Ok(pos) = w.inner_position() else { continue };
            let Ok(size) = w.inner_size() else { continue };
            let bounds = crate::window_state::clamp_bounds_to_work_areas(
                &crate::window_state::WindowBounds {
                    x: pos.x as i64,
                    y: pos.y as i64,
                    width: size.width as i64,
                    height: size.height as i64,
                },
                &areas,
                Some((1, 1)),
            );
            if bounds.x != pos.x as i64 || bounds.y != pos.y as i64 {
                let _ = crate::main_shared::position_window_client_area(&w, tauri::PhysicalPosition::new(bounds.x as i32, bounds.y as i32));
            }
            if bounds.width != size.width as i64 || bounds.height != size.height as i64 {
                let scale = w.scale_factor().unwrap_or(1.0);
                let minimum = match label { "atelier" => crate::main_shared::ATELIER_MIN_SIZE, "companion-chat" => (320, 120), _ => (360, 480) };
                let _ = w.set_min_size(Some(tauri::LogicalSize::new((minimum.0 as f64).min(bounds.width as f64 / scale), (minimum.1 as f64).min(bounds.height as f64 / scale))));
                let _ = w.set_size(tauri::PhysicalSize::new(bounds.width as u32, bounds.height as u32));
            }
        }
    }
}
