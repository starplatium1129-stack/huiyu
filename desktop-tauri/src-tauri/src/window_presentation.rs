//! Native WebView zoom belongs to reading windows only. The Companion's separate
//! Live2D overlay has a different coordinate contract and cannot use this bridge.
use std::path::PathBuf;
use tauri::{Manager, WebviewWindow};

use crate::state::AppState;
use crate::window_state::{bounded_window_zoom, load_window_presentation, save_window_presentation};

fn presentation_file(window: &WebviewWindow) -> Result<PathBuf, String> {
    let state = window.state::<AppState>();
    match window.label() {
        "atelier" => Ok(state.paths.atelier_window_file.clone()),
        "companion-chat" => Ok(state.paths.companion_chat_window_file.clone()),
        _ => Err("WINDOW_ZOOM_UNSUPPORTED: only atelier and companion-chat support page zoom".into()),
    }
}

pub fn restore_zoom(window: &WebviewWindow) {
    let Ok(file) = presentation_file(window) else { return };
    let zoom = load_window_presentation(&file).zoom;
    if let Err(error) = window.set_zoom(zoom) {
        window.state::<AppState>().warn(&format!("restore {} zoom failed: {error}", window.label()));
    }
}

#[tauri::command]
pub fn window_zoom_get(window: WebviewWindow) -> Result<f64, String> {
    let file = presentation_file(&window)?;
    Ok(load_window_presentation(&file).zoom)
}

#[tauri::command]
pub fn window_zoom_set(window: WebviewWindow, value: f64) -> Result<f64, String> {
    let file = presentation_file(&window)?;
    if !value.is_finite() { return Err("WINDOW_ZOOM_INVALID: expected a finite scale".into()); }
    let zoom = bounded_window_zoom(value);
    let previous = load_window_presentation(&file).zoom;
    window.set_zoom(zoom).map_err(|error| format!("WINDOW_ZOOM_FAILED: {error}"))?;
    if !save_window_presentation(&file, Some(zoom), None) {
        let _ = window.set_zoom(previous);
        return Err("WINDOW_ZOOM_PERSIST_FAILED: could not save the window preference".into());
    }
    Ok(zoom)
}
