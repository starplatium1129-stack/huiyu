use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager, WebviewWindowBuilder};

use crate::paths::DesktopPaths;
use crate::state::AppState;
use crate::window_state::{
    clamp_window_bounds, load_window_bounds, load_window_presentation, physical_to_logical_bounds,
    save_window_bounds, save_window_presentation, WindowBounds,
};

/// 规范化 Atelier 目标路径（与 deepLink.ts normalizeAtelierPath 同规则，容忍尾斜杠）
pub fn normalize_atelier_path(value: Option<&str>) -> String {
    match value {
        Some(v) => {
            let v = v.trim_end_matches('/');
            if v.starts_with('/') && v.len() > 1 && v[1..].chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
                v.to_string()
            } else {
                "/".to_string()
            }
        }
        _ => "/".to_string(),
    }
}

pub fn companion_bounds(state: &AppState) -> WindowBounds {
    let saved = load_window_bounds(&state.paths.companion_window_file, None);
    // 2818x2188 is the known companion file produced while the old implementation
    // persisted physical pixels. Reset only this companion file; Atelier may be a
    // legitimately large window and must retain its Electron-compatible state.
    let saved = if saved.width == 2818 && saved.height == 2188 {
        let fallback = WindowBounds { x: 24, y: 80, width: 540, height: 760 };
        save_window_bounds(&state.paths.companion_window_file, &fallback);
        fallback
    } else {
        saved
    };
    let area = primary_work_area_logical();
    clamp_window_bounds(&saved, area, None)
}

pub fn atelier_bounds(state: &AppState) -> WindowBounds {
    let fallback = WindowBounds { x: 120, y: 72, width: 1440, height: 960 };
    let saved = load_window_bounds(&state.paths.atelier_window_file, Some(&fallback));
    let area = primary_work_area_logical();
    clamp_window_bounds(&saved, area, Some((1024, 720)))
}

/// 聊天窗默认位于角色窗右侧（560×720），超出工作区时左移收进屏幕。
/// 首次/坏文件时以该位置为兜底；之后记忆到 companion-chat-window.json。
pub fn companion_chat_bounds(state: &AppState) -> WindowBounds {
    let area = primary_work_area_logical();
    let companion = companion_bounds(&state);
    let fallback = WindowBounds {
        x: companion.x + companion.width + 12,
        y: companion.y.saturating_sub(20),
        width: 560,
        height: 720,
    };
    let saved = load_window_bounds(&state.paths.companion_chat_window_file, Some(&fallback));
    clamp_window_bounds(&saved, area, Some((380, 460)))
}

pub fn primary_work_area() -> (i64, i64, i64, i64) {
    unsafe {
        let x = windows_sys::Win32::UI::WindowsAndMessaging::GetSystemMetrics(76) as i64;
        let y = windows_sys::Win32::UI::WindowsAndMessaging::GetSystemMetrics(77) as i64;
        let w = windows_sys::Win32::UI::WindowsAndMessaging::GetSystemMetrics(78) as i64;
        let h = windows_sys::Win32::UI::WindowsAndMessaging::GetSystemMetrics(79) as i64;
        (x, y, w, h)
    }
}

pub fn show_companion(app: &AppHandle, focus: bool) {
    let Some(w) = app.get_webview_window("companion") else { return };
    let was_visible = w.is_visible().unwrap_or(false);
    // 最小化状态下 show() 不解除最小化（2026-08-15 实机：窗口被最小化后
    // 托盘"显示 Companion"无效，窗口留在屏幕外）。先 unminimize 再 show。
    let _ = w.unminimize();
    if focus {
        let _ = w.show();
        let _ = w.set_focus();
    } else {
        let _ = w.show();
    }
    if !was_visible {
        let _ = w.emit("aics:shown", ());
        let _ = w.emit("aics:visibility", true);
    }
}

pub fn hide_companion(app: &AppHandle) {
    let Some(w) = app.get_webview_window("companion") else { return };
    let was_visible = w.is_visible().unwrap_or(false);
    let _ = w.hide();
    if was_visible {
        let _ = w.emit("aics:visibility", false);
    }
}

pub fn toggle_companion_visibility(app: &AppHandle) {
    let Some(w) = app.get_webview_window("companion") else { return };
    if w.is_visible().unwrap_or(false) {
        hide_companion(app);
    } else {
        show_companion(app, true);
    }
}

pub fn open_atelier(app: &AppHandle, gateway_url: &str, target: Option<&str>) {
    let pathname = normalize_atelier_path(target);
    if gateway_url.is_empty() && !crate::ui_entry::bundled(app) { return; }
    let base = gateway_url.to_string();
    if let Some(w) = app.get_webview_window("atelier") {
        if !crate::ui_entry::isolated_hidden() { let _ = w.show(); let _ = w.set_focus(); }
        let _ = w.emit("aics:navigate", pathname);
        return;
    }
    let state = app.state::<AppState>();
    let bounds = atelier_bounds(&state);
    let source = match crate::ui_entry::source(app, &base, &pathname) { Ok(source) => source, Err(_) => return };
    // 窗口创建不能发生在主线程的 IPC 回调内：WebView2 环境创建需要消息泵，
    // 同步等待会阻塞主线程消息循环，导致后续所有 invoke 超时。
    // 放到 tokio 线程执行（wry 在 Windows 允许非主线程创建窗口）。
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let presentation = load_window_presentation(&state.paths.atelier_window_file);
        save_window_bounds(&state.paths.atelier_window_file, &bounds);
        let mut builder = WebviewWindowBuilder::new(&app, "atelier", source);
        if let Some(profile) = crate::ui_entry::isolated_profile() { builder = builder.data_directory(profile); }
        match builder
            .title("绘遇 · HUIYU")
            // The controlled bridge clamps and persists Ctrl±/0 and Ctrl+wheel.
            .zoom_hotkeys_enabled(false)
            .inner_size(bounds.width as f64, bounds.height as f64)
            .position(bounds.x as f64, bounds.y as f64)
            .min_inner_size(1024.0, 720.0)
            .maximized(presentation.maximized)
            .decorations(false)
            .visible(false)
            .on_navigation({ let app = app.clone(); move |url| is_gateway_navigation(&app, url) })
            .build()
        {
            Ok(win) => {
                state.info("open atelier: window built");
                crate::window_presentation::restore_zoom(&win);
                let show_result = if crate::ui_entry::isolated_hidden() { Ok(()) } else { win.show() };
                let focus_result = if crate::ui_entry::isolated_hidden() { Ok(()) } else { win.set_focus() };
                state.info(&format!(
                    "open atelier: show={show_result:?} focus={focus_result:?} visible={}",
                    win.is_visible().unwrap_or(false)
                ));
            }
            Err(e) => state.error(&format!("open atelier: window build failed: {e}")),
        }
    });
}

pub fn create_companion_window(app: &AppHandle, gateway_url: &str, show_on_start: bool) -> tauri::Result<()> {
    let state = app.state::<AppState>();
    let bounds = companion_bounds(&state);
    let source = crate::ui_entry::source(app, gateway_url, "/companion").map_err(|error| tauri::Error::Io(std::io::Error::other(error)))?;
    let mut builder = WebviewWindowBuilder::new(app, "companion", source);
    if let Some(profile) = crate::ui_entry::isolated_profile() { builder = builder.data_directory(profile); }
    let win = builder
        .title("绘遇 Companion")
        .inner_size(bounds.width as f64, bounds.height as f64)
        .position(bounds.x as f64, bounds.y as f64)
        .min_inner_size(360.0, 480.0)
        .transparent(true)
        .decorations(false)
        .always_on_top(state.preferences.lock().unwrap().always_on_top)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false)
        .on_navigation({ let app = app.clone(); move |url| is_gateway_navigation(&app, url) })
        .build()?;
    let ignore_mouse_events = state.ignore_mouse_events.load(Ordering::Relaxed);
    if let Err(error) = win.set_ignore_cursor_events(ignore_mouse_events) {
        state.ignore_mouse_events.store(false, Ordering::Relaxed);
        state.warn(&format!("restore mouse passthrough failed: {error}"));
    }
    if show_on_start {
        let _ = win.show();
        let _ = win.emit("aics:shown", ());
        let _ = win.emit("aics:visibility", true);
    }
    if let Some(bounds) = webview_bounds(&win) {
        let _ = win.emit("aics:window-bounds", bounds);
    }
    Ok(())
}

/// 聊天窗（/companion-chat）：懒创建、轻量无 Live2D（严格 CSP）、独立普通小窗。
/// 与 atelier 一样不能在主线程 IPC 回调内同步创建（WebView2 需要消息泵），
/// 放 tokio 线程执行。
pub fn open_companion_chat(app: &AppHandle, gateway_url: &str) {
    if let Some(w) = app.get_webview_window("companion-chat") {
        if !crate::ui_entry::isolated_hidden() { let _ = w.unminimize(); let _ = w.show(); }
        crate::chat_dock::follow(app);
        if !crate::ui_entry::isolated_hidden() { let _ = w.set_focus(); }
        // Hiding preserves the WebView, its draft, and the reader's scroll position.
        return;
    }
    let state = app.state::<AppState>();
    let bounds = companion_chat_bounds(&state);
    if gateway_url.is_empty() && !crate::ui_entry::bundled(app) { return; }
    let source = match crate::ui_entry::source(app, gateway_url, "/companion-chat") { Ok(source) => source, Err(_) => return };
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let presentation = load_window_presentation(&state.paths.companion_chat_window_file);
        save_window_bounds(&state.paths.companion_chat_window_file, &bounds);
        let mut builder = WebviewWindowBuilder::new(&app, "companion-chat", source);
        if let Some(profile) = crate::ui_entry::isolated_profile() { builder = builder.data_directory(profile); }
        match builder
            .title("绘遇聊天")
            .zoom_hotkeys_enabled(false)
            .inner_size(bounds.width as f64, bounds.height as f64)
            .position(bounds.x as f64, bounds.y as f64)
            .min_inner_size(380.0, 460.0)
            .maximized(presentation.maximized)
            .decorations(false)
            .skip_taskbar(true)
            .shadow(true)
            .visible(false)
            .on_navigation({ let app = app.clone(); move |url| is_gateway_navigation(&app, url) })
            .build()
        {
            Ok(win) => {
                state.info("open companion-chat: window built");
                crate::window_presentation::restore_zoom(&win);
                if !crate::ui_entry::isolated_hidden() { let _ = win.show(); }
                crate::chat_dock::follow(&app);
                if !crate::ui_entry::isolated_hidden() { let _ = win.set_focus(); }
            }
            Err(e) => state.error(&format!("open companion-chat: window build failed: {e}")),
        }
    });
}

pub fn toggle_companion_chat(app: &AppHandle, gateway_url: &str) {
    if let Some(w) = app.get_webview_window("companion-chat") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            open_companion_chat(app, gateway_url);
        }
        return;
    }
    open_companion_chat(app, gateway_url);
}

/// 聊天窗 ×：直接 hide（不走 window.close → CloseRequested → prevent/hide
/// 链路），保证 WebView2 内容不被卸载，再次打开不会空白。
pub fn hide_companion_chat(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("companion-chat") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        }
    }
}

fn webview_bounds(w: &tauri::WebviewWindow) -> Option<WindowBounds> {
    let p = w.inner_position().ok()?;
    let s = w.inner_size().ok()?;
    Some(WindowBounds { x: p.x as i64, y: p.y as i64, width: s.width as i64, height: s.height as i64 })
}

fn persisted_webview_bounds(w: &tauri::WebviewWindow) -> Option<WindowBounds> {
    let physical = webview_bounds(w)?;
    let scale_factor = w.scale_factor().ok()?;
    Some(physical_to_logical_bounds(&physical, scale_factor))
}

pub fn companion_window_bounds(app: &AppHandle) -> Option<WindowBounds> {
    app.get_webview_window("companion").and_then(|w| webview_bounds(&w))
}

pub fn persist_window_bounds(app: &AppHandle) {
    let state = app.state::<AppState>();
    if let Some(w) = app.get_webview_window("companion") {
        if let Some(bounds) = webview_bounds(&w) {
            if let Some(logical_bounds) = persisted_webview_bounds(&w) {
                save_window_bounds(&state.paths.companion_window_file, &logical_bounds);
            }
            let _ = w.emit("aics:window-bounds", bounds);
        }
    }
    for (label, file) in [
        ("atelier", &state.paths.atelier_window_file),
        ("companion-chat", &state.paths.companion_chat_window_file),
    ] {
        if let Some(w) = app.get_webview_window(label) {
            // Keep the last normal geometry; maximized/fullscreen/minimized sizes
            // would otherwise replace the rectangle used by the restore button.
            if w.is_minimized().unwrap_or(true) || w.is_fullscreen().unwrap_or(true) { continue; }
            let Ok(maximized) = w.is_maximized() else { continue };
            if !maximized {
                if let Some(bounds) = persisted_webview_bounds(&w) { save_window_bounds(file, &bounds); }
            }
            save_window_presentation(file, None, Some(maximized));
        }
    }
}

pub fn primary_work_area_logical() -> (i64, i64, i64, i64) {
    let physical = primary_work_area();
    let dpi = unsafe { windows_sys::Win32::UI::HiDpi::GetDpiForSystem() } as f64;
    let scale_factor = if dpi > 0.0 { dpi / 96.0 } else { 1.0 };
    let logical = physical_to_logical_bounds(
        &WindowBounds {
            x: physical.0,
            y: physical.1,
            width: physical.2,
            height: physical.3,
        },
        scale_factor,
    );
    (logical.x, logical.y, logical.width, logical.height)
}

pub fn gateway_env(paths: &DesktopPaths, is_packaged: bool, workspace_root: Option<&str>) -> Vec<(String, String)> {
    let mut env = vec![
        ("AICS_APP_ROOT".into(), paths.app_root.to_string_lossy().to_string()),
        ("AICS_ASSETS_ROOT".into(), paths.assets_root.to_string_lossy().to_string()),
        ("AICS_TOOLS_ROOT".into(), paths.tools_root.to_string_lossy().to_string()),
        ("AICS_RUNTIME_ROOT".into(), paths.runtime_root.to_string_lossy().to_string()),
        ("AICS_DESKTOP_CONFIG_ROOT".into(), paths.config_root.to_string_lossy().to_string()),
        ("AICS_DESKTOP_SOURCE_PROFILE_ID".into(), paths.source_profile_id.clone()),
        ("AICS_SCRIPTS_ROOT".into(), paths.app_root.join("scripts").to_string_lossy().to_string()),
        ("AI_WORKSPACE_ROOT".into(), workspace_root.map(String::from).or_else(|| std::env::var("AI_WORKSPACE_ROOT").ok()).unwrap_or_else(|| paths.app_root.parent().unwrap_or(&paths.app_root).join("AI").to_string_lossy().to_string())),
    ];
    if is_packaged {
        env.push(("AICS_DESKTOP_PACKAGED".into(), "1".into()));
    }
    if paths.gateway_port_file.exists() {
        env.push(("AICS_DESKTOP_PRESERVE_ORIGIN".into(), "1".into()));
    }
    env
}

#[cfg(test)]
mod tests {
    use super::normalize_atelier_path;

    // 由已退役 Electron 版 desktop/deepLink.ts 的 test-deep-link.js 移植：
    // 归一化是 aics:// 深链的核心契约（main.rs 深链回调先剥 aics:// 再归一化）。

    #[test]
    fn normalizes_single_segment_routes() {
        assert_eq!(normalize_atelier_path(Some("/gallery")), "/gallery");
        assert_eq!(normalize_atelier_path(Some("/training")), "/training");
        assert_eq!(normalize_atelier_path(Some("/chat")), "/chat");
        assert_eq!(normalize_atelier_path(Some("/scene-explorer")), "/scene-explorer");
    }

    #[test]
    fn tolerates_trailing_slash_and_keeps_case() {
        assert_eq!(normalize_atelier_path(Some("/gallery/")), "/gallery");
        assert_eq!(normalize_atelier_path(Some("/UPPER-1")), "/UPPER-1");
    }

    #[test]
    fn rejects_invalid_targets_with_root_fallback() {
        assert_eq!(normalize_atelier_path(Some("/")), "/");
        assert_eq!(normalize_atelier_path(Some("gallery")), "/");
        assert_eq!(normalize_atelier_path(Some("/a/b")), "/");
        assert_eq!(normalize_atelier_path(Some("/bad path")), "/");
        assert_eq!(normalize_atelier_path(None), "/");
    }
}
#[path = "gateway_origin.rs"]
mod gateway_origin;
pub use gateway_origin::same_gateway_origin;

pub fn is_gateway_navigation(app: &AppHandle, url: &tauri::Url) -> bool {
    if crate::ui_entry::bundled(app) && crate::ui_entry::native_origin(url) { return true; }
    if !is_gateway_origin(app, url) { return false; }
    // A navigation fetches new executable content, so re-prove the live server.
    app.try_state::<crate::gateway::GatewaySupervisor>().map(|gateway| gateway.is_healthy()).unwrap_or(false)
}

pub fn is_gateway_origin(app: &AppHandle, url: &tauri::Url) -> bool {
    let Some(state) = app.try_state::<AppState>() else { return false; };
    if crate::ui_entry::bundled(app) && crate::ui_entry::native_origin(url) { return true; }
    // Retain capabilities for an already loaded trusted document while the
    // runtime reconnects. Every new navigation still verifies fresh identity.
    let expected = state.gateway_url.lock().unwrap().clone();
    same_gateway_origin(&expected, url)
}

/// Static capabilities grant no remote origin. Add only the proven startup origin.
pub fn authorize_gateway_origin(app: &AppHandle, url: &str) -> Result<(), String> {
    let parsed = tauri::Url::parse(url).map_err(|e| e.to_string())?;
    if !same_gateway_origin(url, &parsed) { return Err("Untrusted gateway origin".into()); }
    let current = app.state::<AppState>().gateway_url.lock().unwrap().clone();
    if !current.is_empty() {
        if same_gateway_origin(&current, &parsed) { return Ok(()); }
        if !crate::ui_entry::bundled(app) { return Err("Gateway origin changed; restart the desktop before granting privileges".into()); }
    }
    for template in [include_str!("../capabilities/default.json"), include_str!("../capabilities/companion-live2d.json")] {
        let mut capability: serde_json::Value = serde_json::from_str(template).map_err(|e| e.to_string())?;
        capability["identifier"] = serde_json::json!(format!("{}-{}", capability["identifier"].as_str().unwrap(), parsed.port_or_known_default().unwrap()));
        capability["remote"] = serde_json::json!({ "urls": [format!("{}/*", parsed.origin().ascii_serialization())] });
        app.add_capability(serde_json::to_string(&capability).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    }
    Ok(())
}
