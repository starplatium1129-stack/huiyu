use std::sync::atomic::Ordering;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_opener::OpenerExt;

use crate::state::AppState;

#[tauri::command]
pub async fn desktop_bootstrap(window: tauri::WebviewWindow) -> Result<crate::bootstrap::DesktopBootstrap, String> {
    crate::bootstrap::read(window).await
}

#[tauri::command]
pub async fn desktop_workspace_prepare(window: tauri::WebviewWindow) -> Result<crate::bootstrap::DesktopBootstrap, String> {
    crate::bootstrap::request(window, "prepare-candidate", None, false).await
}

#[tauri::command]
pub async fn desktop_workspace_activate(window: tauri::WebviewWindow, migration_id: String, bundled_ui: bool) -> Result<crate::bootstrap::DesktopBootstrap, String> {
    crate::bootstrap::request(window, "activate", Some(migration_id), bundled_ui).await
}

#[tauri::command]
pub async fn desktop_workspace_enable_bundled(window: tauri::WebviewWindow) -> Result<crate::bootstrap::DesktopBootstrap, String> {
    crate::bootstrap::request(window, "enable-bundled", None, true).await
}

/// IPC 命令层：与 Electron 版 preload 桥一一对应（前端零改动由 shim 保证）。

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopState {
    pub always_on_top: bool,
    pub ignore_mouse_events: bool,
    pub visible: bool,
    pub on_battery_power: bool,
    pub live2d_enabled: Option<bool>,
    pub bounds: Option<crate::window_state::WindowBounds>,
}

fn companion(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window("companion")
}

pub fn set_ignore_mouse_events(app: &AppHandle, ignore: bool) {
    let state = app.state::<AppState>();
    state
        .ignore_mouse_events
        .store(ignore, Ordering::Relaxed);
    if let Some(w) = companion(app) {
        let _ = w.set_ignore_cursor_events(ignore);
        let _ = w.emit("aics:interaction-mode", ignore);
    }
    state.preferences.lock().unwrap().ignore_mouse_events = ignore;
    state.save_preferences();
    crate::tray::refresh_tray_menu(app);
}

#[tauri::command]
pub fn get_state(app: AppHandle, state: State<AppState>) -> DesktopState {
    DesktopState {
        always_on_top: companion(&app)
            .map(|w| w.is_always_on_top().unwrap_or(false))
            .unwrap_or(false),
        ignore_mouse_events: state.ignore_mouse_events.load(Ordering::Relaxed),
        visible: companion(&app)
            .map(|w| w.is_visible().unwrap_or(false))
            .unwrap_or(false),
        on_battery_power: crate::watchers::on_battery_power(),
        live2d_enabled: *state.live2d_enabled.lock().unwrap(),
        bounds: crate::main_shared::companion_window_bounds(&app),
    }
}

#[tauri::command]
pub fn hide(app: AppHandle) {
    crate::main_shared::hide_companion(&app);
}

#[tauri::command]
pub fn quit(app: AppHandle) {
    let state = app.state::<AppState>();
    state.quitting.store(true, Ordering::Relaxed);
    state.info("quit from bridge");
    app.exit(0);
}

#[tauri::command]
pub fn set_ignore_mouse_events_cmd(app: AppHandle, ignore: bool) {
    set_ignore_mouse_events(&app, ignore);
}

#[tauri::command]
pub fn toggle_ignore_mouse_events(app: AppHandle, state: State<AppState>) -> bool {
    let next = !state.ignore_mouse_events.load(Ordering::Relaxed);
    set_ignore_mouse_events(&app, next);
    next
}

#[tauri::command]
pub fn toggle_always_on_top(app: AppHandle, state: State<AppState>) -> bool {
    let Some(w) = companion(&app) else { return false };
    let next = !w.is_always_on_top().unwrap_or(false);
    let _ = w.set_always_on_top(next);
    state.preferences.lock().unwrap().always_on_top = next;
    state.save_preferences();
    crate::tray::refresh_tray_menu(&app);
    next
}

#[tauri::command]
pub fn set_live2d_enabled(_app: AppHandle, state: State<AppState>, enabled: bool) {
    *state.live2d_enabled.lock().unwrap() = Some(enabled);
    state.preferences.lock().unwrap().live2d_enabled = Some(enabled);
    state.save_preferences();
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> serde_json::Value {
    serde_json::json!({
        "openAtLogin": app.autolaunch().is_enabled().unwrap_or(false)
    })
}

#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> bool {
    let result = if enabled {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    };
    crate::tray::refresh_tray_menu(&app);
    result.is_ok() && app.autolaunch().is_enabled().unwrap_or(false) == enabled
}

#[tauri::command]
pub fn is_packaged(app: AppHandle) -> bool {
    app.package_info().version.major > 0 && !cfg!(debug_assertions)
}

#[tauri::command]
pub fn get_workspace(state: State<AppState>) -> serde_json::Value {
    let root = state.workspace_root.lock().unwrap().clone();
    serde_json::json!({
        "root": root,
        "exists": !root.is_empty() && std::path::Path::new(&root).exists()
    })
}

#[tauri::command]
pub async fn set_workspace(
    _app: AppHandle,
    state: State<'_, AppState>,
    root: String,
) -> Result<serde_json::Value, String> {
    if root.trim().is_empty() {
        return Err("工作区路径不能为空".into());
    }
    if !crate::window_state::save_ai_workspace(&state.paths.ai_workspace_file, root.trim()) {
        return Err("工作区目录不存在或不是文件夹".into());
    }
    let resolved = std::path::absolute(root.trim()).map_err(|e| e.to_string())?;
    *state.workspace_root.lock().unwrap() = resolved.to_string_lossy().to_string();
    state.info(&format!("AI workspace updated to {}", resolved.display()));
    Ok(serde_json::json!({ "root": resolved.to_string_lossy() }))
}

#[tauri::command]
pub fn notify(app: AppHandle, title: String, body: String) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title(&title)
        .body(&body)
        .show();
}

#[tauri::command]
pub fn open_atelier(app: AppHandle, state: State<AppState>, pathname: Option<String>) {
    let gateway = state.gateway_url.lock().unwrap().clone();
    state.info(&format!("open atelier: path={pathname:?} gateway={gateway}"));
    crate::main_shared::open_atelier(&app, &gateway, pathname.as_deref());
}

/// 打开/聚焦聊天窗（companion-chat）。由角色窗悬停胶囊、托盘与快捷键调用。
#[tauri::command]
pub fn open_companion_chat(app: AppHandle, state: State<AppState>) {
    let gateway = state.gateway_url.lock().unwrap().clone();
    crate::main_shared::open_companion_chat(&app, &gateway);
}

/// 开/关聊天窗（快捷键用）。
#[tauri::command]
pub fn toggle_companion_chat(app: AppHandle, state: State<AppState>) {
    let gateway = state.gateway_url.lock().unwrap().clone();
    crate::main_shared::toggle_companion_chat(&app, &gateway);
}

/// 聊天窗 ×：直接 hide（不触发 close 链路，避免 WebView2 卸载导致空白）。
#[tauri::command]
pub fn hide_companion_chat(app: AppHandle) {
    crate::main_shared::hide_companion_chat(&app);
}

/// 聊天窗 → 角色窗指令中继：聊天窗不持有会话运行时，发送/切角色等动作
/// 转发给 companion 窗口的 CompanionView 执行（后者是唯一会话写者）。
#[derive(serde::Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatRelay {
    command: String,
    text: Option<String>,
    image_url: Option<String>,
    character: Option<String>,
    request_id: Option<String>,
}

#[tauri::command]
pub fn chat_relay(window: tauri::WebviewWindow, app: AppHandle, payload: ChatRelay) -> bool {
    if window.label() != "companion-chat"
        || !matches!(payload.command.as_str(), "send" | "stop" | "switch-character")
        || payload.text.as_ref().is_some_and(|value| value.len() > 65_536)
        || payload.image_url.as_ref().is_some_and(|value| value.len() > 16 * 1024 * 1024)
        || payload.character.as_ref().is_some_and(|value| value.len() > 256)
        || payload.request_id.as_ref().is_some_and(|value| value.len() > 128) { return false; }
    if payload.command == "send" && (payload.request_id.as_ref().is_none_or(|value| value.is_empty())
        || payload.text.as_ref().is_none_or(|value| value.trim().is_empty())) { return false; }
    let Some(w) = app.get_webview_window("companion") else { return false };
    let _ = w.emit("aics:chat-command", payload);
    true
}

#[tauri::command]
pub fn window_minimize(app: AppHandle) {
    // 2026-08-15 修复：标题栏最小化按钮位于 Atelier 窗口（DesktopTitleBar 在
    // /companion 路由隐藏），此前误操作 companion 窗口导致点击无反应。
    // 与 window_maximize_toggle / window_close 保持一致，统一操作 atelier。
    if let Some(w) = app.get_webview_window("atelier") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.minimize();
        }
    }
}

#[tauri::command]
pub fn window_maximize_toggle(app: AppHandle) {
    if let Some(w) = app.get_webview_window("atelier") {
        if w.is_visible().unwrap_or(false) {
            if w.is_maximized().unwrap_or(false) {
                let _ = w.unmaximize();
            } else {
                let _ = w.maximize();
            }
            let _ = w.emit("aics:maximized", w.is_maximized().unwrap_or(false));
        }
    }
}

#[tauri::command]
pub fn window_close(app: AppHandle) {
    if let Some(w) = app.get_webview_window("atelier") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.close();
        } else if companion(&app).is_some() {
            crate::main_shared::hide_companion(&app);
        }
    } else if companion(&app).is_some() {
        crate::main_shared::hide_companion(&app);
    }
}

#[tauri::command]
pub fn get_window_state(app: AppHandle) -> serde_json::Value {
    let win = app.get_webview_window("atelier").or_else(|| companion(&app));
    serde_json::json!({
        "maximized": win.as_ref().map(|w| w.is_maximized().unwrap_or(false)).unwrap_or(false),
        "focused": win.as_ref().map(|w| w.is_focused().unwrap_or(false)).unwrap_or(false),
    })
}

#[tauri::command]
pub fn set_progress(app: AppHandle, progress: Option<f64>) {
    use tauri::window::ProgressBarState;
    let value = match progress {
        Some(v) if v.is_finite() => v.clamp(0.0, 1.0),
        _ => -1.0,
    };
    let state = if value < 0.0 {
        ProgressBarState { status: None, progress: None }
    } else {
        ProgressBarState { status: None, progress: Some((value * 100.0).round() as u64) }
    };
    for label in ["atelier", "companion"] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.set_progress_bar(ProgressBarState { status: state.status, progress: state.progress });
        }
    }
}

#[tauri::command]
pub fn open_workspace(app: AppHandle, state: State<AppState>) -> bool {
    let root = state.workspace_root.lock().unwrap().clone();
    let root = if root.is_empty() {
        state
            .paths
            .config_root
            .parent()
            .unwrap_or(&state.paths.config_root)
            .join("AI")
    } else {
        std::path::PathBuf::from(&root)
    };
    app.opener().open_path(root.to_string_lossy().to_string(), None::<&str>).is_ok()
}

#[tauri::command]
pub fn open_runtime(app: AppHandle, state: State<AppState>) -> bool {
    app.opener().open_path(state.paths.config_root.to_string_lossy().to_string(), None::<&str>).is_ok()
}

#[tauri::command]
pub fn open_log(app: AppHandle, state: State<AppState>) -> bool {
    app.opener().open_path(state.paths.desktop_log.to_string_lossy().to_string(), None::<&str>).is_ok()
}

/// 对话框：文件选择（pickFiles）
#[tauri::command]
pub async fn pick_files(app: AppHandle) -> Vec<serde_json::Value> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app.dialog().file().blocking_pick_files().unwrap_or_default();
    picked
        .into_iter()
        .filter_map(|path| {
            let path = path.into_path().ok()?;
            let name = path.file_name()?.to_string_lossy().to_string();
            let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            let ext = path.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default();
            Some(serde_json::json!({
                "name": name,
                "path": path.to_string_lossy(),
                "size": size,
                "type": ext
            }))
        })
        .collect()
}

/// 对话框：保存图片（saveImage）
#[tauri::command]
pub async fn save_image(app: AppHandle, data: Vec<u8>, name: Option<String>) -> serde_json::Value {
    use tauri_plugin_dialog::DialogExt;
    let default_name = name.unwrap_or_else(|| "image.png".into());
    let file_path = app
        .dialog()
        .file()
        .set_file_name(&default_name)
        .blocking_save_file();
    match file_path {
        Some(path) => match path.into_path() {
            Ok(path) => match std::fs::write(&path, data) {
                Ok(_) => serde_json::json!({ "saved": true, "filePath": path.to_string_lossy() }),
                Err(e) => serde_json::json!({ "saved": false, "error": e.to_string() }),
            },
            Err(e) => serde_json::json!({ "saved": false, "error": e.to_string() }),
        },
        None => serde_json::json!({ "saved": false }),
    }
}
