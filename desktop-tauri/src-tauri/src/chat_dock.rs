use tauri::{AppHandle, Manager, PhysicalPosition};
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
    if chat.outer_position().ok() != Some(PhysicalPosition::new(x, y)) { let _ = chat.set_position(PhysicalPosition::new(x, y)); }
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dock_avoids_edges_and_keeps_side_when_possible() {
        assert_eq!(dock_position((1400, 600, 400, 700), (500, 600), (0, 0, 1920, 1040), 12, true), (888, 440, false));
        assert_eq!(dock_position((700, 100, 400, 700), (500, 600), (0, 0, 1920, 1040), 12, false), (188, 150, false));
        assert_eq!(dock_position((-1500, 100, 500, 800), (500, 600), (-1920, 0, 1920, 1040), 18, true), (-982, 200, true));
    }
}
