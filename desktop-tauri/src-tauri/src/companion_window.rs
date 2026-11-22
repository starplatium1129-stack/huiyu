use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    SetWindowPos, HWND_TOP, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW,
};

use crate::{live2d_overlay, live2d_renderer::{AlphaMaskSnapshot, OverlayRect}, state::AppState};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReadyKind {
    Native,
    Static,
    Failed,
}

#[derive(Default)]
pub struct Presentation {
    configured: bool,
    pub shown: bool,
    generation: u64,
    pending: Option<ShowRequest>,
    ready: Option<ReadyKind>,
    pub startup_failed: bool,
}

struct ShowRequest {
    generation: u64,
    focus: bool,
    menu: bool,
    timed_out: bool,
}

impl Presentation {
    pub fn preparing(&self) -> bool { self.pending.is_some() }
    pub fn generation(&self) -> u64 { self.generation }
}

#[derive(Default)]
pub struct InputRegions {
    pub panels: Vec<OverlayRect>,
    pub locked: bool,
    pub static_mask: Option<AlphaMaskSnapshot>,
    pub process_frame: Option<OverlayRect>,
}

fn dispatch(app: &AppHandle, action: impl FnOnce(&AppHandle) + Send + 'static) {
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || action(&handle)) {
        app.state::<AppState>().warn(&format!("companion window dispatch failed: {error}"));
    }
}

pub fn show(app: &AppHandle, focus: bool, menu: bool) {
    let gateway = app.state::<AppState>().gateway_url.lock().unwrap().clone();
    if gateway.is_empty() && !crate::ui_entry::bundled(app) { return; }
    dispatch(app, move |app| {
        if crate::maintenance::active(app) { return; }
        let state = app.state::<AppState>();
        let window = app.get_webview_window("companion");
        if let Some(window) = window.as_ref().filter(|window| window.is_visible().unwrap_or(false)) {
            let _ = window.unminimize();
            if focus { let _ = window.set_focus(); }
            if menu { let _ = window.emit("aics:companion-menu", ()); }
            return;
        }

        let mut presentation = state.companion_presentation.lock().unwrap();
        if let Some(request) = &mut presentation.pending {
            request.focus |= focus;
            request.menu |= menu;
            return;
        }
        presentation.generation = presentation.generation.wrapping_add(1);
        let generation = presentation.generation;
        presentation.pending = Some(ShowRequest { generation, focus, menu, timed_out: false });
        presentation.startup_failed = false;
        drop(presentation);
        crate::tray::refresh_tray_menu(app);

        if let Some(window) = window {
            let _ = window.emit("aics:companion-prepare", ());
            reveal_if_ready(app);
        } else {
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(error) = crate::main_shared::create_companion_window(&app, &gateway) {
                    app.state::<AppState>().error(&format!("open companion: {error}"));
                    dispatch(&app, move |app| {
                        let state = app.state::<AppState>();
                        let mut presentation = state.companion_presentation.lock().unwrap();
                        if presentation.pending.as_ref().is_some_and(|r| r.generation == generation) {
                            presentation.pending = None;
                            drop(presentation);
                            crate::tray::refresh_tray_menu(app);
                            crate::bridge::notify(app.clone(), "绘遇 · 桌宠暂未就绪".into(), "请从系统托盘重新打开桌宠。".into());
                        }
                    });
                }
            });
        }

        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(8)).await;
            dispatch(&app, move |app| {
                let state = app.state::<AppState>();
                {
                    let mut presentation = state.companion_presentation.lock().unwrap();
                    let Some(request) = presentation.pending.as_mut().filter(|r| r.generation == generation) else { return; };
                    request.timed_out = true;
                }
                reveal_if_ready(app);
            });
        });
    });
}

pub fn configured(app: &AppHandle) {
    dispatch(app, |app| {
        app.state::<AppState>().companion_presentation.lock().unwrap().configured = true;
        reveal_if_ready(app);
    });
}

pub fn mark_ready(app: &AppHandle, ready: ReadyKind) {
    dispatch(app, move |app| {
        let state = app.state::<AppState>();
        let mut presentation = state.companion_presentation.lock().unwrap();
        presentation.ready = Some(ready);
        drop(presentation);
        reveal_if_ready(app);
    });
}

pub fn native_frame(app: &AppHandle) {
    dispatch(app, |app| reveal_if_ready(app));
}

fn reveal_if_ready(app: &AppHandle) {
    if crate::maintenance::active(app) { return; }
    let state = app.state::<AppState>();
    let Some(window) = app.get_webview_window("companion") else { return; };
    let mut presentation = state.companion_presentation.lock().unwrap();
    if !presentation.configured { return; }
    let native_ready = live2d_overlay::first_frame_ready(app);
    let ready = match presentation.ready {
        Some(ReadyKind::Static) => true,
        Some(ReadyKind::Native) => native_ready || crate::live2d_process::enabled(),
        _ => false,
    };
    let Some(request) = presentation.pending.as_ref() else {
        if presentation.shown && presentation.startup_failed && ready {
            presentation.startup_failed = false;
            drop(presentation);
            let _ = window.emit("aics:companion-startup-recovered", ());
        }
        return;
    };
    if !ready && !request.timed_out && !matches!(presentation.ready, Some(ReadyKind::Failed)) { return; }
    let request = presentation.pending.take().unwrap();
    presentation.shown = true;
    presentation.startup_failed = !ready;
    drop(presentation);

    // Place the already rendered DirectComposition window first, then reveal
    // the transparent input surface without taking focus on a normal launch.
    live2d_overlay::set_revealed(app, true);
    if request.focus {
        let _ = window.unminimize();
        if let Err(error) = window.show().and_then(|_| window.set_focus()) {
            state.warn(&format!("show companion failed: {error}"));
        }
    } else {
        let layer = if state.preferences.lock().unwrap().always_on_top { HWND_TOPMOST } else { HWND_TOP };
        match window.hwnd() {
            Ok(hwnd) => {
                let flags = SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW;
                if unsafe { SetWindowPos(hwnd.0, layer, 0, 0, 0, 0, flags) } == 0 {
                    state.warn(&format!("show companion failed: {}", std::io::Error::last_os_error()));
                }
            }
            Err(error) => state.warn(&format!("show companion failed: {error}")),
        }
    }
    // Match the final z-order after raising the transparent input window.
    live2d_overlay::set_revealed(app, true);
    if !ready {
        state.warn("companion first frame unavailable");
        crate::bridge::notify(app.clone(), "绘遇 · 桌宠暂未就绪".into(), "请在桌宠窗口重试，或从系统托盘打开画室。".into());
        let _ = window.emit("aics:companion-startup-timeout", ());
    }
    let _ = window.emit("aics:shown", ());
    let _ = window.emit("aics:visibility", true);
    if request.menu { let _ = window.emit("aics:companion-menu", ()); }
    crate::tray::refresh_tray_menu(app);
}

pub fn hide(app: &AppHandle) {
    dispatch(app, |app| {
        let state = app.state::<AppState>();
        let mut presentation = state.companion_presentation.lock().unwrap();
        presentation.pending = None;
        presentation.shown = false;
        presentation.ready = None;
        presentation.startup_failed = false;
        drop(presentation);
        {
            let mut input = state.companion_input.lock().unwrap();
            input.panels.clear();
            input.locked = false;
            input.process_frame = None;
        }
        live2d_overlay::set_revealed(app, false);
        if let Some(window) = app.get_webview_window("companion") {
            let was_visible = window.is_visible().unwrap_or(false);
            if was_visible { crate::window_persistence::closing(app, "companion"); }
            let _ = window.hide();
            let _ = window.set_ignore_cursor_events(true);
            let _ = window.emit("aics:visibility", false);
        }
        let chat_docked = state.preferences.lock().unwrap().chat_docked;
        if chat_docked { crate::main_shared::hide_companion_chat(app); }
        crate::tray::refresh_tray_menu(app);
    });
}

pub fn set_regions(window: &WebviewWindow, panels: Vec<OverlayRect>, locked: bool) -> Result<(), String> {
    if window.label() != "companion" || panels.len() > 32 || panels.iter().any(|rect| !rect.valid_local()) {
        return Err("invalid companion input regions".into());
    }
    let state = window.state::<AppState>();
    let mut input = state.companion_input.lock().unwrap();
    input.panels = panels;
    input.locked = locked;
    Ok(())
}

pub fn set_static_mask(window: &WebviewWindow, mask: Option<AlphaMaskSnapshot>) -> Result<(), String> {
    if window.label() != "companion" || mask.as_ref().is_some_and(|mask| !mask.valid_local()) {
        return Err("invalid companion portrait mask".into());
    }
    window.state::<AppState>().companion_input.lock().unwrap().static_mask = mask;
    Ok(())
}
