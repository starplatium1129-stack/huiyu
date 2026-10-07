use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager, WebviewWindowBuilder};

use crate::paths::DesktopPaths;
use crate::state::AppState;
use crate::window_state::{
    load_window_bounds, load_window_presentation, normalize_companion_bounds, physical_to_logical_bounds,
    restore_window_placement, save_window_bounds, save_window_presentation, DisplayWorkArea,
    WindowBounds, WindowPlacement,
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

pub fn companion_bounds(app: &AppHandle, state: &AppState) -> WindowPlacement {
    let (saved, physical) = load_window_bounds(&state.paths.companion_window_file, None);
    restore_window_placement(&normalize_companion_bounds(&saved), physical.as_ref(), &display_work_areas(app), None)
}

pub fn atelier_bounds(app: &AppHandle, state: &AppState) -> WindowPlacement {
    let fallback = WindowBounds { x: 120, y: 72, width: 1440, height: 960 };
    let (saved, physical) = load_window_bounds(&state.paths.atelier_window_file, Some(&fallback));
    restore_window_placement(&saved, physical.as_ref(), &display_work_areas(app), Some((1024, 720)))
}

/// 聊天窗默认位于角色窗右侧（560×720），超出工作区时左移收进屏幕。
/// 首次/坏文件时以该位置为兜底；之后记忆到 companion-chat-window.json。
pub fn companion_chat_bounds(app: &AppHandle, state: &AppState) -> WindowPlacement {
    let companion = companion_bounds(app, state).logical;
    let fallback = WindowBounds {
        x: companion.x + companion.width + 12,
        y: companion.y.saturating_sub(20),
        width: 560,
        height: 720,
    };
    let (saved, physical) = load_window_bounds(&state.paths.companion_chat_window_file, Some(&fallback));
    restore_window_placement(&saved, physical.as_ref(), &display_work_areas(app), Some((380, 460)))
}

pub fn display_work_areas(app: &AppHandle) -> Vec<DisplayWorkArea> {
    let mut areas: Vec<_> = app.available_monitors().unwrap_or_default().iter().map(|monitor| {
        let area = monitor.work_area();
        DisplayWorkArea { bounds: (area.position.x as i64, area.position.y as i64,
            area.size.width as i64, area.size.height as i64), scale_factor: monitor.scale_factor() }
    }).collect();
    areas.sort_by_key(|area| area.bounds);
    areas
}

fn apply_window_placement(window: &tauri::WebviewWindow, placement: &WindowPlacement) -> tauri::Result<()> {
    // A logical origin can refer to more than one display at mixed DPI. Apply
    // the selected physical rectangle while hidden, before restoring maximize.
    let bounds = &placement.physical;
    position_window_client_area(window, tauri::PhysicalPosition::new(bounds.x as i32, bounds.y as i32))?;
    window.set_size(tauri::PhysicalSize::new(bounds.width as u32, bounds.height as u32))
}

pub fn position_window_client_area(window: &tauri::WebviewWindow, target: tauri::PhysicalPosition<i32>) -> tauri::Result<()> {
    // Frameless reading windows can still have invisible native shadow borders.
    // Persistence measures the client origin; set_position places the outer one.
    let inner = window.inner_position()?;
    if inner == target { return Ok(()); }
    let outer = window.outer_position()?;
    window.set_position(tauri::PhysicalPosition::new(outer.x + target.x - inner.x, outer.y + target.y - inner.y))?;
    // Moving to a different DPI can change border thickness during SetWindowPos.
    let inner = window.inner_position()?;
    if inner != target {
        let outer = window.outer_position()?;
        window.set_position(tauri::PhysicalPosition::new(outer.x + target.x - inner.x, outer.y + target.y - inner.y))?;
    }
    Ok(())
}

pub fn show_companion(app: &AppHandle, focus: bool) {
    if crate::maintenance::active(app) { return; }
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
    if crate::maintenance::active(app) { return; }
    let pathname = normalize_atelier_path(target);
    if gateway_url.is_empty() && !crate::ui_entry::bundled(app) { return; }
    let base = gateway_url.to_string();
    if let Some(w) = app.get_webview_window("atelier") {
        if !crate::ui_entry::isolated_hidden() { let _ = w.show(); let _ = w.set_focus(); }
        let _ = w.emit("aics:navigate", pathname);
        return;
    }
    let state = app.state::<AppState>();
    let placement = atelier_bounds(app, &state);
    let source = match crate::ui_entry::source(app, &base, &pathname) { Ok(source) => source, Err(_) => return };
    // 窗口创建不能发生在主线程的 IPC 回调内：WebView2 环境创建需要消息泵，
    // 同步等待会阻塞主线程消息循环，导致后续所有 invoke 超时。
    // 放到 tokio 线程执行（wry 在 Windows 允许非主线程创建窗口）。
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let bounds = &placement.logical;
        let presentation = load_window_presentation(&state.paths.atelier_window_file);
        save_window_bounds(&state.paths.atelier_window_file, bounds, Some(&placement.physical));
        let mut builder = WebviewWindowBuilder::new(&app, "atelier", source);
        if let Some(profile) = crate::ui_entry::isolated_profile() { builder = builder.data_directory(profile); }
        match builder
            .title("绘遇 · HUIYU")
            // The controlled bridge clamps and persists Ctrl±/0 and Ctrl+wheel.
            .zoom_hotkeys_enabled(false)
            .inner_size(bounds.width as f64, bounds.height as f64)
            .position(bounds.x as f64, bounds.y as f64)
            .min_inner_size(1024.0_f64.min(bounds.width as f64), 720.0_f64.min(bounds.height as f64))
            .decorations(false)
            .visible(false)
            .on_navigation({ let app = app.clone(); move |url| is_gateway_navigation(&app, url) })
            .build()
        {
            Ok(win) => {
                state.info("open atelier: window built");
                #[cfg(windows)]
                crate::window_presentation::set_taskbar_icon(&win);
                if let Err(error) = apply_window_placement(&win, &placement) { state.warn(&format!("restore atelier bounds failed: {error}")); }
                if presentation.maximized { let _ = win.maximize(); }
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
    if crate::maintenance::active(app) { return Ok(()); }
    let state = app.state::<AppState>();
    let placement = companion_bounds(app, &state);
    let bounds = &placement.logical;
    let source = crate::ui_entry::source(app, gateway_url, "/companion").map_err(|error| tauri::Error::Io(std::io::Error::other(error)))?;
    let mut builder = WebviewWindowBuilder::new(app, "companion", source);
    if let Some(profile) = crate::ui_entry::isolated_profile() { builder = builder.data_directory(profile); }
    let win = builder
        .title("绘遇 Companion")
        .inner_size(bounds.width as f64, bounds.height as f64)
        .position(bounds.x as f64, bounds.y as f64)
        .min_inner_size(360.0_f64.min(bounds.width as f64), 480.0_f64.min(bounds.height as f64))
        .transparent(true)
        .decorations(false)
        .always_on_top(state.preferences.lock().unwrap().always_on_top)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false)
        .on_navigation({ let app = app.clone(); move |url| is_gateway_navigation(&app, url) })
        .build()?;
    apply_window_placement(&win, &placement)?;
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
    if crate::maintenance::active(app) { return; }
    if let Some(w) = app.get_webview_window("companion-chat") {
        if !crate::ui_entry::isolated_hidden() { let _ = w.unminimize(); let _ = w.show(); }
        crate::chat_dock::follow(app);
        if !crate::ui_entry::isolated_hidden() { let _ = w.set_focus(); }
        // Hiding preserves the WebView, its draft, and the reader's scroll position.
        return;
    }
    let state = app.state::<AppState>();
    let placement = companion_chat_bounds(app, &state);
    if gateway_url.is_empty() && !crate::ui_entry::bundled(app) { return; }
    let source = match crate::ui_entry::source(app, gateway_url, "/companion-chat") { Ok(source) => source, Err(_) => return };
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let bounds = &placement.logical;
        let presentation = load_window_presentation(&state.paths.companion_chat_window_file);
        save_window_bounds(&state.paths.companion_chat_window_file, bounds, Some(&placement.physical));
        let mut builder = WebviewWindowBuilder::new(&app, "companion-chat", source);
        if let Some(profile) = crate::ui_entry::isolated_profile() { builder = builder.data_directory(profile); }
        match builder
            .title("绘遇聊天")
            .zoom_hotkeys_enabled(false)
            .inner_size(bounds.width as f64, bounds.height as f64)
            .position(bounds.x as f64, bounds.y as f64)
            .min_inner_size(380.0_f64.min(bounds.width as f64), 460.0_f64.min(bounds.height as f64))
            .decorations(false)
            .skip_taskbar(true)
            .shadow(true)
            .visible(false)
            .on_navigation({ let app = app.clone(); move |url| is_gateway_navigation(&app, url) })
            .build()
        {
            Ok(win) => {
                state.info("open companion-chat: window built");
                if let Err(error) = apply_window_placement(&win, &placement) { state.warn(&format!("restore companion-chat bounds failed: {error}")); }
                if presentation.maximized { let _ = win.maximize(); }
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

fn persisted_webview_bounds(w: &tauri::WebviewWindow) -> Option<(WindowBounds, WindowBounds)> {
    let physical = webview_bounds(w)?;
    let scale_factor = w.scale_factor().ok()?;
    Some((physical_to_logical_bounds(&physical, scale_factor), physical))
}

pub fn companion_window_bounds(app: &AppHandle) -> Option<WindowBounds> {
    app.get_webview_window("companion").and_then(|w| webview_bounds(&w))
}

pub fn persist_window_bounds(app: &AppHandle) {
    let state = app.state::<AppState>();
    if let Some(w) = app.get_webview_window("companion") {
        if let Some(bounds) = webview_bounds(&w) {
            if let Some((logical_bounds, physical)) = persisted_webview_bounds(&w) {
                save_window_bounds(&state.paths.companion_window_file, &logical_bounds, Some(&physical));
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
                if let Some((bounds, physical)) = persisted_webview_bounds(&w) { save_window_bounds(file, &bounds, Some(&physical)); }
            }
            save_window_presentation(file, None, Some(maximized));
        }
    }
}

pub fn gateway_env(paths: &DesktopPaths, is_packaged: bool, workspace_root: Option<&str>) -> Vec<(String, String)> {
    let ai_workspace = workspace_root.filter(|value| !value.trim().is_empty()).map(String::from)
        .or_else(|| std::env::var("AI_WORKSPACE_ROOT").ok().filter(|value| !value.trim().is_empty()))
        .unwrap_or_else(|| paths.app_root.parent().unwrap_or(&paths.app_root).join("AI").to_string_lossy().to_string());
    let mut env = vec![
        ("AICS_APP_ROOT".into(), paths.app_root.to_string_lossy().to_string()),
        ("AICS_ASSETS_ROOT".into(), paths.assets_root.to_string_lossy().to_string()),
        ("AICS_TOOLS_ROOT".into(), paths.tools_root.to_string_lossy().to_string()),
        ("AICS_RUNTIME_ROOT".into(), paths.runtime_root.to_string_lossy().to_string()),
        ("AICS_DESKTOP_CONFIG_ROOT".into(), paths.config_root.to_string_lossy().to_string()),
        ("AICS_DESKTOP_SOURCE_PROFILE_ID".into(), paths.source_profile_id.clone()),
        ("AICS_SCRIPTS_ROOT".into(), paths.app_root.join("scripts").to_string_lossy().to_string()),
        ("AI_WORKSPACE_ROOT".into(), ai_workspace),
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
    use super::{gateway_env, normalize_atelier_path};

    #[test]
    fn empty_workspace_selection_preserves_inherited_or_default_model_root() {
        let paths = crate::paths::DesktopPaths {
            is_packaged: true, app_root: "C:/Huiyu/gateway".into(), resource_root: "".into(),
            gateway_executable: "".into(), gateway_cwd: "".into(), assets_root: "".into(),
            tools_root: "".into(), runtime_root: "".into(), config_root: "".into(), source_profile_id: String::new(),
            ai_workspace_file: "".into(), desktop_log: "".into(), gateway_port_file: "".into(),
            companion_window_file: "".into(), companion_chat_window_file: "".into(),
            atelier_window_file: "".into(), preferences_file: "".into(),
        };
        let workspace = |value| gateway_env(&paths, true, value).into_iter()
            .find(|(key, _)| key == "AI_WORKSPACE_ROOT").unwrap().1;
        assert_eq!(workspace(Some("")), workspace(None));
        assert_eq!(workspace(Some("  ")), workspace(None));
        assert!(!workspace(Some("")).trim().is_empty());
        assert_eq!(workspace(Some("D:/HuiyuAI")), "D:/HuiyuAI");
    }

    // 由已退役 Electron 版 desktop/deepLink.ts 的 test-deep-link.js 移植：
    // 归一化是 aics:// 深链的核心契约（main.rs 深链回调先剥 aics:// 再归一化）。

    #[test]
    fn normalizes_single_segment_routes() {
        assert_eq!(normalize_atelier_path(Some("/gallery")), "/gallery");
        assert_eq!(normalize_atelier_path(Some("/training")), "/training");
        assert_eq!(normalize_atelier_path(Some("/chat")), "/chat");
        assert_eq!(normalize_atelier_path(Some("/scene-explorer")), "/scene-explorer");
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
pub use gateway_origin::{same_gateway_origin, registered_desktop_origin};

pub fn is_gateway_navigation(app: &AppHandle, url: &tauri::Url) -> bool {
    if crate::ui_entry::bundled(app) && crate::ui_entry::native_origin(url) { return true; }
    if !is_gateway_origin(app, url) { return false; }
    // A navigation fetches new executable content, so re-prove the live server.
    app.try_state::<crate::gateway::GatewaySupervisor>().map(|gateway| gateway.is_healthy()).unwrap_or(false)
}

pub fn is_gateway_origin(app: &AppHandle, url: &tauri::Url) -> bool {
    let Some(state) = app.try_state::<AppState>() else { return false; };
    // Retain capabilities for an already loaded trusted document while the
    // runtime reconnects. Every new navigation still verifies fresh identity.
    let expected = state.gateway_url.lock().unwrap().clone();
    registered_desktop_origin(&expected, crate::ui_entry::bundled(app), url)
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
