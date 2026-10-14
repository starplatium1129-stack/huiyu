use tauri::{AppHandle, Emitter, Manager, PhysicalPosition};
use crate::state::AppState;
use std::sync::atomic::{AtomicBool, Ordering};

static PREFER_RIGHT: AtomicBool = AtomicBool::new(true);

/// Coordinates stay in physical pixels from monitor work area to window placement.
pub fn dock_position(pet: (i32, i32, i32, i32), chat: (i32, i32), area: (i32, i32, i32, i32), gap: i32, prefer_right: bool) -> (i32, i32, bool) {
    let (px, py, pw, ph) = pet;
    let (cw, ch) = chat;
    let (ax, ay, aw, ah) = area;
    let right = px + pw + gap;
    let left = px - cw - gap;
    let fits_right = right + cw <= ax + aw;
    let fits_left = left >= ax;
    let use_right = if prefer_right { fits_right || !fits_left } else { !fits_left && fits_right };
    let x = if use_right { right } else { left };
    (x.clamp(ax, ax + (aw - cw).max(0)), (py + (ph - ch) / 2).clamp(ay, ay + (ah - ch).max(0)), use_right)
}

pub fn follow(app: &AppHandle) {
    if !app.state::<AppState>().preferences.lock().unwrap().chat_docked { return; }
    let (Some(pet), Some(chat)) = (app.get_webview_window("companion"), app.get_webview_window("companion-chat")) else { return };
    if !chat.is_visible().unwrap_or(false) || chat.is_maximized().unwrap_or(false) { return; }
    let (Ok(pos), Ok(size), Ok(chat_size), Ok(Some(monitor))) = (pet.outer_position(), pet.outer_size(), chat.outer_size(), pet.current_monitor()) else { return };
    let area = monitor.work_area();
    let gap = (12.0 * monitor.scale_factor()).round() as i32;
    let (x, y, right) = dock_position((pos.x, pos.y, size.width as i32, size.height as i32), (chat_size.width as i32, chat_size.height as i32), (area.position.x, area.position.y, area.size.width as i32, area.size.height as i32), gap, PREFER_RIGHT.load(Ordering::Relaxed));
    PREFER_RIGHT.store(right, Ordering::Relaxed);
    let _ = chat.emit("aics:chat-dock-side", if right { "right" } else { "left" });
    if let Ok(pinned) = pet.is_always_on_top() {
        if chat.is_always_on_top().ok() != Some(pinned) { let _ = chat.set_always_on_top(pinned); }
    }
    if chat.outer_position().ok() != Some(PhysicalPosition::new(x, y)) { let _ = chat.set_position(PhysicalPosition::new(x, y)); }
}

/// CSS pixels include the saved WebView zoom; the monitor's work area remains physical.
#[tauri::command]
pub fn resize_companion_dialogue(app: AppHandle, window: tauri::WebviewWindow, width: f64, height: f64) -> Result<f64, String> {
    if window.label() != "companion-chat" { return Err("Only the companion dialogue can resize itself".into()); }
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return Err("Dialogue dimensions must be finite positive numbers".into());
    }
    let state = app.state::<AppState>();
    let zoom = crate::window_state::load_window_presentation(&state.paths.companion_chat_window_file).zoom;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let monitor = window.current_monitor().map_err(|error| error.to_string())?
        .or(window.primary_monitor().map_err(|error| error.to_string())?)
        .ok_or("No monitor is available for the dialogue")?;
    let area = monitor.work_area();
    let width = (width.clamp(320.0, 520.0) * zoom).min(area.size.width as f64 / scale);
    let max_height = 680.0_f64.min(area.size.height as f64 / scale / zoom);
    let height = height.clamp(120.0, 680.0).min(max_height) * zoom;
    let size = tauri::LogicalSize::new(width, height);
    let current = window.inner_size().map_err(|error| error.to_string())?.to_logical::<f64>(scale);
    if (current.width - width).abs() >= 1.0 || (current.height - height).abs() >= 1.0 {
        window.set_size(size).map_err(|error| error.to_string())?;
    }
    let docked = state.preferences.lock().unwrap().chat_docked;
    if docked {
        follow(&app);
    } else {
        let pos = window.outer_position().map_err(|error| error.to_string())?;
        let size = window.outer_size().map_err(|error| error.to_string())?;
        let x = pos.x.clamp(area.position.x, area.position.x + area.size.width.saturating_sub(size.width) as i32);
        let y = pos.y.clamp(area.position.y, area.position.y + area.size.height.saturating_sub(size.height) as i32);
        if x != pos.x || y != pos.y {
            window.set_position(PhysicalPosition::new(x, y)).map_err(|error| error.to_string())?;
        }
    }
    Ok(max_height)
}

#[tauri::command]
pub fn set_chat_docked(app: AppHandle, docked: bool) -> bool {
    let state = app.state::<AppState>();
    state.preferences.lock().unwrap().chat_docked = docked;
    state.save_preferences();
    if docked { follow(&app); }
    docked
}

#[tauri::command]
pub fn get_chat_docked(app: AppHandle) -> bool { app.state::<AppState>().preferences.lock().unwrap().chat_docked }
