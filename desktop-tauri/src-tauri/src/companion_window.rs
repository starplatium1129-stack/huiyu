use crate::mutex::RecoverMutex;
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use windows_sys::Win32::Foundation::{HWND, POINT, RECT};
use windows_sys::Win32::Graphics::Gdi::ClientToScreen;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, GetKeyState, ReleaseCapture, VK_ESCAPE, VK_LBUTTON, VK_RBUTTON};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetClientRect, GetCursorPos, GetForegroundWindow, GetSystemMetrics, GetWindowLongW, GetWindowRect, IsWindowVisible,
    SendMessageW, SetForegroundWindow, SetWindowLongW, SetWindowPos, GWL_EXSTYLE, HTCAPTION,
    SC_MOVE, SM_SWAPBUTTON, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
    WM_NCLBUTTONDOWN, WM_SYSCOMMAND, WS_EX_LAYERED, WS_EX_TRANSPARENT,
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
}

#[derive(Default)]
pub struct InputRegions {
    pub panels: Vec<OverlayRect>,
    pub locked: bool,
    pub moving: bool,
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
    let gateway = app.state::<AppState>().gateway_url.recover_lock().clone();
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

        let mut presentation = state.companion_presentation.recover_lock();
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
                        let mut presentation = state.companion_presentation.recover_lock();
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
                    let mut presentation = state.companion_presentation.recover_lock();
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
        app.state::<AppState>().companion_presentation.recover_lock().configured = true;
        reveal_if_ready(app);
    });
}

pub fn mark_ready(app: &AppHandle, ready: ReadyKind) {
    dispatch(app, move |app| {
        let state = app.state::<AppState>();
        let mut presentation = state.companion_presentation.recover_lock();
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
    let mut presentation = state.companion_presentation.recover_lock();
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

    // Tao must know the input window is visible. Showing only its HWND leaves
    // Tao's hidden flag set and its next style change hides the pet's input.
    let foreground = unsafe { GetForegroundWindow() };
    if request.focus { let _ = window.unminimize(); }
    if let Err(error) = window.show() {
        state.companion_presentation.recover_lock().shown = false;
        state.warn(&format!("show companion failed: {error}"));
        crate::tray::refresh_tray_menu(app);
        return;
    }
    if let Ok(hwnd) = window.hwnd() {
        set_mouse_passthrough(hwnd.0, true);
        if !request.focus && !foreground.is_null() && foreground != hwnd.0 && unsafe { GetForegroundWindow() } == hwnd.0 {
            unsafe { SetForegroundWindow(foreground); }
        }
    }
    if request.focus { let _ = window.set_focus(); }
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
        let mut presentation = state.companion_presentation.recover_lock();
        presentation.pending = None;
        presentation.shown = false;
        presentation.ready = None;
        presentation.startup_failed = false;
        drop(presentation);
        {
            let mut input = state.companion_input.recover_lock();
            input.panels.clear();
            input.locked = false;
            input.process_frame = None;
        }
        live2d_overlay::set_revealed(app, false);
        if let Some(window) = app.get_webview_window("companion") {
            let was_visible = window.is_visible().unwrap_or(false);
            if was_visible { crate::window_persistence::closing(app, "companion"); }
            let _ = window.hide();
            let _ = window.emit("aics:visibility", false);
        }
        let chat_docked = state.preferences.recover_lock().chat_docked;
        if chat_docked { crate::main_shared::hide_companion_chat(app); }
        crate::tray::refresh_tray_menu(app);
    });
}

// Own only the two Win32 input flags. Tao's general style setter also shows
// and activates visible windows, which makes cursor movement steal focus.
const PASSTHROUGH: u32 = WS_EX_LAYERED | WS_EX_TRANSPARENT;

pub fn mouse_passthrough(hwnd: HWND) -> bool {
    (unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) } as u32 & PASSTHROUGH) == PASSTHROUGH
}

pub fn set_mouse_passthrough(hwnd: HWND, ignore: bool) {
    let style = unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) } as u32;
    let next = if ignore { style | PASSTHROUGH } else { style & !PASSTHROUGH };
    if next != style {
        unsafe {
            SetWindowLongW(hwnd, GWL_EXSTYLE, next as i32);
            SetWindowPos(hwnd, std::ptr::null_mut(), 0, 0, 0, 0,
                SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER);
        }
    }
}

pub fn primary_button_down() -> bool {
    // GetAsyncKeyState reports physical buttons, even with left-handed mouse settings.
    let button = if unsafe { GetSystemMetrics(SM_SWAPBUTTON) } == 0 { VK_LBUTTON } else { VK_RBUTTON };
    unsafe { GetAsyncKeyState(button as i32) < 0 }
}

#[tauri::command]
pub async fn start_companion_move(window: WebviewWindow, request: WindowMove) -> Result<bool, String> {
    if !matches!(window.label(), "companion" | "companion-chat") {
        return Err("只有桌宠和陪伴聊天窗可以移动自身".into());
    }
    // Start outside WebView2's IPC callback. Windows runs its own nested move loop
    // on this thread until release, Enter or Escape, including across monitors.
    let (done, completion) = tokio::sync::oneshot::channel();
    let app = window.app_handle().clone();
    app.run_on_main_thread(move || { let _ = done.send(move_window(&window, request)); })
        .map_err(|error| error.to_string())?;
    completion.await.map_err(|_| "窗口已关闭".to_owned())?
}

#[derive(Clone, Copy, Deserialize)]
pub struct ViewportPoint { x: f64, y: f64 }

impl ViewportPoint {
    fn screen(self, hwnd: HWND) -> Result<POINT, String> {
        let mut size: RECT = unsafe { std::mem::zeroed() };
        if unsafe { GetClientRect(hwnd, &mut size) } == 0 { return Err(std::io::Error::last_os_error().to_string()); }
        let x = (self.x * f64::from(size.right)).round();
        let y = (self.y * f64::from(size.bottom)).round();
        let valid = f64::from(i32::MIN)..=f64::from(i32::MAX);
        if !valid.contains(&x) || !valid.contains(&y) { return Err("桌宠移动坐标无效".into()); }
        let mut point = POINT { x: x as i32, y: y as i32 };
        if unsafe { ClientToScreen(hwnd, &mut point) } == 0 { return Err(std::io::Error::last_os_error().to_string()); }
        Ok(point)
    }
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum WindowMove {
    Menu,
    Pointer { grab: Option<ViewportPoint> },
    Released { grab: ViewportPoint, end: ViewportPoint },
}

fn window_position(hwnd: HWND) -> Result<POINT, String> {
    let mut rect: RECT = unsafe { std::mem::zeroed() };
    if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 { return Err(std::io::Error::last_os_error().to_string()); }
    Ok(POINT { x: rect.left, y: rect.top })
}

fn place_window(hwnd: HWND, x: i32, y: i32) -> Result<(), String> {
    if unsafe { SetWindowPos(hwnd, std::ptr::null_mut(), x, y, 0, 0, SWP_NOACTIVATE | SWP_NOSIZE | SWP_NOZORDER) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

fn align_grab(hwnd: HWND, grab: ViewportPoint, target: POINT) -> Result<(), String> {
    if !(0.0..=1.0).contains(&grab.x) || !(0.0..=1.0).contains(&grab.y) { return Err("桌宠抓取点无效".into()); }
    // Crossing to another DPI can resize the window during SetWindowPos.
    // Resolve the same fractional grab point once more against that client area.
    for _ in 0..2 {
        let current = grab.screen(hwnd)?;
        if current.x == target.x && current.y == target.y { break; }
        let origin = window_position(hwnd)?;
        let x = i64::from(origin.x) + i64::from(target.x) - i64::from(current.x);
        let y = i64::from(origin.y) + i64::from(target.y) - i64::from(current.y);
        place_window(hwnd, i32::try_from(x).map_err(|_| "横坐标超出范围")?, i32::try_from(y).map_err(|_| "纵坐标超出范围")?)?;
    }
    Ok(())
}

fn move_window(window: &WebviewWindow, request: WindowMove) -> Result<bool, String> {
    let hwnd = window.hwnd().map_err(|error| error.to_string())?.0;
    if unsafe { IsWindowVisible(hwnd) } == 0 { return Ok(true); }
    let pet = window.label() == "companion";
    let state = window.state::<AppState>();
    if pet {
        {
            let mut input = state.companion_input.recover_lock();
            if input.moving { return Ok(true); }
            input.moving = true;
        }
    }
    let result = perform_move(hwnd, request, pet);
    if pet {
        state.companion_input.recover_lock().moving = false;
        if matches!(result, Ok(true)) { crate::window_persistence::changed(window.app_handle(), "companion"); }
    }
    result
}

fn perform_move(hwnd: HWND, request: WindowMove, pet: bool) -> Result<bool, String> {
    let original = window_position(hwnd)?;
    let (message, action, position) = match request {
        WindowMove::Released { grab, end } => {
            align_grab(hwnd, grab, end.screen(hwnd)?)?;
            return Ok(true);
        }
        WindowMove::Menu => (WM_SYSCOMMAND, SC_MOVE as usize, 0),
        WindowMove::Pointer { grab } => {
            if !primary_button_down() { return Ok(false); }
            let mut point = POINT { x: 0, y: 0 };
            if unsafe { GetCursorPos(&mut point) } == 0 { return Err(std::io::Error::last_os_error().to_string()); }
            if !primary_button_down() { return Ok(false); }
            if let Some(grab) = grab { align_grab(hwnd, grab, point)?; }
            // WM_NCLBUTTONDOWN takes packed signed screen coordinates, not a pointer to POINTS.
            let packed = (point.x as u16 as u32) | ((point.y as u16 as u32) << 16);
            (WM_NCLBUTTONDOWN, HTCAPTION as usize, packed as isize)
        }
    };
    if pet { set_mouse_passthrough(hwnd, false); }
    unsafe {
        ReleaseCapture();
        SendMessageW(hwnd, message, action, position);
    }
    // The system rolls back the modal move. Also roll back the distance covered
    // between the original press and the native handoff.
    if unsafe { GetKeyState(VK_ESCAPE as i32) } < 0 { place_window(hwnd, original.x, original.y)?; }
    Ok(true)
}

pub fn set_regions(window: &WebviewWindow, panels: Vec<OverlayRect>, locked: bool) -> Result<(), String> {
    if window.label() != "companion" || panels.len() > 32 || panels.iter().any(|rect| !rect.valid_local()) {
        return Err("invalid companion input regions".into());
    }
    let state = window.state::<AppState>();
    let mut input = state.companion_input.recover_lock();
    input.panels = panels;
    input.locked = locked;
    Ok(())
}

pub fn set_static_mask(window: &WebviewWindow, mask: Option<AlphaMaskSnapshot>) -> Result<(), String> {
    if window.label() != "companion" || mask.as_ref().is_some_and(|mask| !mask.valid_local()) {
        return Err("invalid companion portrait mask".into());
    }
    window.state::<AppState>().companion_input.recover_lock().static_mask = mask;
    Ok(())
}
