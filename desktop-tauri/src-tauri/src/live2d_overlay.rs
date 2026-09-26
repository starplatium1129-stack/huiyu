//! Tauri adapter for the reusable native Live2D renderer.

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};
pub use crate::live2d_renderer::{Live2DOverlayState, OverlayRect, selftest};
use crate::live2d_renderer::*;
use crate::live2d_renderer::live2d_adapter::Live2DAdapterConfig;
use crate::live2d_renderer::live2d_assets;
use crate::live2d_process_protocol::Command as ProcessCommand;

static OVERLAY_STATE_INIT: OnceLock<Mutex<()>> = OnceLock::new();
pub fn ensure_overlay(app: &AppHandle, assets_root: std::path::PathBuf) -> Arc<Live2DOverlayState> {
    let _init_guard = OVERLAY_STATE_INIT
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap();
    let state = if let Some(state) = app.try_state::<Arc<Live2DOverlayState>>() {
        state.inner().clone()
    } else {
        let state = Arc::new(Live2DOverlayState::default());
        app.manage(state.clone());
        state
    };
    if try_begin_startup(&state) {
        let handle = state.clone();
        let app2 = app.clone();
        let local_root = Some(app.state::<crate::state::AppState>().paths.runtime_root.join("live2d-imports"));
        let events = RendererEvents(Arc::new(move |name, value| { let _ = app2.emit(name, value); }));
        thread::spawn(move || overlay_window_thread(handle, RendererEnvironment { assets_root, local_root, events: Some(events) }));
    }
    state
}

fn overlay_assets_root(app: &AppHandle) -> std::path::PathBuf {
    app.state::<crate::state::AppState>()
        .paths
        .assets_root
        .clone()
}


pub fn apply_frame(app: &AppHandle, local_rect: OverlayRect, visible: bool, opacity: Option<u32>) -> Result<(), String> {
    let state = ensure_overlay(app, overlay_assets_root(app));
    let deadline = Instant::now() + Duration::from_secs(1);
    while !state.window_ready.load(Ordering::SeqCst) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    let companion = app.get_webview_window("companion").and_then(|window| window.hwnd().ok()).map(|handle| handle.0 as isize);
    crate::live2d_renderer::apply_frame(&state, local_rect, visible, opacity, companion)
}

/// 异步版 send_command：模型加载/纹理解码需要数秒，绝不能在 Tauri 主线程
/// 用 pollster::block_on 等待，否则 UI 线程被冻结、前端 loading 无法显示。
async fn send_command_async(
    state: &Arc<Live2DOverlayState>,
    cmd: OverlayCommand,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let tx = state.cmd_tx.lock().unwrap().clone();
        if let Some(tx) = tx {
            tx.send(cmd)
                .map_err(|_| "renderer thread disconnected".to_string())?;
            return Ok(());
        }
        if Instant::now() > deadline {
            return Err("renderer not attached".to_string());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

// ---------------- IPC 命令（aics_live2d_*） ----------------

#[tauri::command]
pub async fn aics_live2d_set_character(
    app: AppHandle,
    model_path: String,
    character: Option<String>,
    texture_scale: Option<u32>,
    adapter: Option<Live2DAdapterConfig>,
) -> Result<serde_json::Value, String> {
    // 白名单：character 只接受已知角色；model_path 忽略（资产由 Rust 从
    // assets_root/live2d/{character} 读取，不接收任意路径）。
    let character = character.unwrap_or_else(|| "nene".to_string());
    let Some(adapter) = adapter else {
        return Ok(serde_json::json!({ "ok": false, "error": "missing Live2D adapter profile" }));
    };
    if let Err(error) = adapter.validate() {
        return Ok(serde_json::json!({ "ok": false, "error": error }));
    }
    let _ = model_path;
    let texture_scale = texture_scale.unwrap_or(1);
    if !matches!(texture_scale, 1 | 2 | 4) { return Err("invalid Live2D texture scale".into()); }
    let assets_root = overlay_assets_root(&app);
    let local_root = app.state::<crate::state::AppState>().paths.runtime_root.join("live2d-imports");
    if let Err(error) = live2d_assets::resolve_model(&assets_root, Some(&local_root), &character, &adapter.profile_id) {
        return Ok(serde_json::json!({ "ok": false, "error": error }));
    }
    if crate::live2d_process::enabled() {
        return crate::live2d_process::call(&app, ProcessCommand::SetCharacter { character, texture_scale, adapter: serde_json::to_value(adapter).map_err(|e| e.to_string())? }).await;
    }
    let state = ensure_overlay(&app, assets_root);
    let (tx, rx) = tokio::sync::oneshot::channel();
    // 真异步：模型加载在渲染线程执行，本 command 挂起等待，不阻塞主线程；
    // 前端在调用期间保持 loading 状态。
    send_command_async(
        &state,
        OverlayCommand::SetCharacter {
            character,
            texture_scale,
            adapter,
            reply: tx,
        },
    )
    .await?;
    let result = rx
        .await
        .map_err(|_| "renderer dropped command".to_string())?;
    match result {
        Ok(()) => Ok(serde_json::json!({ "ok": true })),
        Err(e) => Ok(serde_json::json!({ "ok": false, "error": e })),
    }
}

/// 只读状态查询。未初始化时不得创建 overlay 或启动渲染线程。
#[tauri::command]
pub async fn aics_live2d_get_state(app: AppHandle) -> Result<serde_json::Value, String> {
    if crate::live2d_process::enabled() { return crate::live2d_process::call(&app, ProcessCommand::GetState).await; }
    let Some(state) = app.try_state::<Arc<Live2DOverlayState>>() else {
        return Ok(serde_json::json!({
            "active": false,
            "rect": OverlayRect::default(),
            "visible": false,
            "frameCount": 0,
            "targetFps": 0,
            "character": null,
            "ready": false,
            "windowReady": false,
            "rendererAttached": false,
            "starting": false,
            "modelBounds": null,
            "mouthLevel": 0.0,
            "mouthMappedValue": 0.0,
            "surfaceFailures": 0,
            "surfaceRecoveries": 0,
            "renderErrors": 0,
        }));
    };
    Ok(crate::live2d_renderer::state_snapshot(state.inner()))
}

#[tauri::command]
pub async fn aics_live2d_play_motion(
    app: AppHandle,
    group: String,
    index: Option<i64>,
    priority: Option<String>,
) -> Result<serde_json::Value, String> {
    if crate::live2d_process::enabled() { return crate::live2d_process::call(&app, ProcessCommand::PlayMotion { group, index, priority }).await; }
    let assets_root = overlay_assets_root(&app);
    let state = ensure_overlay(&app, assets_root);
    let (tx, rx) = tokio::sync::oneshot::channel();
    send_command(
        &state,
        OverlayCommand::PlayMotion {
            group,
            index,
            priority,
            reply: tx,
        },
    )?;
    let result = rx.await.map_err(|_| "renderer dropped command".to_string())?;
    match result {
        Ok(()) => Ok(serde_json::json!({ "ok": true })),
        Err(e) => Ok(serde_json::json!({ "ok": false, "error": e })),
    }
}

#[tauri::command]
pub async fn aics_live2d_set_expression(
    app: AppHandle,
    name: String,
) -> Result<serde_json::Value, String> {
    if crate::live2d_process::enabled() { return crate::live2d_process::call(&app, ProcessCommand::SetExpression { name }).await; }
    let assets_root = overlay_assets_root(&app);
    let state = ensure_overlay(&app, assets_root);
    let (tx, rx) = tokio::sync::oneshot::channel();
    send_command(&state, OverlayCommand::SetExpression { name, reply: tx })?;
    let result = rx.await.map_err(|_| "renderer dropped command".to_string())?;
    match result {
        Ok(()) => Ok(serde_json::json!({ "ok": true })),
        Err(e) => Ok(serde_json::json!({ "ok": false, "error": e })),
    }
}

#[tauri::command]
pub async fn aics_live2d_set_mouth_level(app: AppHandle, level: f64) -> Result<(), String> {
    if crate::live2d_process::enabled() { return crate::live2d_process::call(&app, ProcessCommand::SetMouthLevel { level: level as f32 }).await.map(|_| ()); }
    let assets_root = overlay_assets_root(&app);
    let state = ensure_overlay(&app, assets_root);
    send_command(&state, OverlayCommand::SetMouthLevel(level as f32))
}

#[tauri::command]
pub async fn aics_live2d_set_max_fps(app: AppHandle, fps: f64) -> Result<(), String> {
    let fps = if fps.is_finite() { fps.round().clamp(1.0, 1000.0) as u32 } else { 60 };
    if crate::live2d_process::enabled() { return crate::live2d_process::call(&app, ProcessCommand::SetMaxFps { fps }).await.map(|_| ()); }
    let state = ensure_overlay(&app, overlay_assets_root(&app));
    send_command_async(&state, OverlayCommand::SetMaxFps(fps)).await
}

#[tauri::command]
pub async fn aics_live2d_set_emotion(app: AppHandle, name: String, intensity: f64) -> Result<(), String> {
    if crate::live2d_process::enabled() { return crate::live2d_process::call(&app, ProcessCommand::SetEmotion { name, intensity: intensity as f32 }).await.map(|_| ()); }
    let assets_root = overlay_assets_root(&app);
    let state = ensure_overlay(&app, assets_root);
    send_command(
        &state,
        OverlayCommand::SetEmotion {
            name,
            intensity: intensity as f32,
        },
    )
}

#[tauri::command]
pub async fn aics_live2d_set_gaze(app: AppHandle, x: f64, y: f64) -> Result<(), String> {
    if crate::live2d_process::enabled() { return crate::live2d_process::call(&app, ProcessCommand::SetGaze { x: x as f32, y: y as f32 }).await.map(|_| ()); }
    let assets_root = overlay_assets_root(&app);
    let state = ensure_overlay(&app, assets_root);
    send_command(&state, OverlayCommand::SetGaze(x as f32, y as f32))
}

#[tauri::command]
pub async fn aics_live2d_hit_test(app: AppHandle, x: f64, y: f64) -> Result<serde_json::Value, String> {
    if crate::live2d_process::enabled() { return crate::live2d_process::call(&app, ProcessCommand::HitTest { x: x as f32, y: y as f32 }).await; }
    let assets_root = overlay_assets_root(&app);
    let state = ensure_overlay(&app, assets_root);
    let (tx, rx) = tokio::sync::oneshot::channel();
    send_command(
        &state,
        OverlayCommand::HitTest {
            x: x as f32,
            y: y as f32,
            reply: tx,
        },
    )?;
    let areas =
        rx.await.map_err(|_| "renderer dropped hit-test command".to_string())??;
    Ok(serde_json::json!({ "areas": areas }))
}

#[tauri::command]
pub async fn aics_live2d_destroy(app: AppHandle) -> Result<(), String> {
    if crate::live2d_process::enabled() { return crate::live2d_process::call(&app, ProcessCommand::Destroy).await.map(|_| ()); }
    let assets_root = overlay_assets_root(&app);
    let state = ensure_overlay(&app, assets_root);
    let (tx, rx) = tokio::sync::oneshot::channel();
    send_command(&state, OverlayCommand::Destroy { reply: tx })?;
    let _ = rx.await;
    if let Some(hwnd) = state.hwnd.lock().unwrap().clone().map(|h| h as HWND) {
        unsafe {
            ShowWindow(hwnd, SW_HIDE);
        }
    }
    state.visible.store(false, Ordering::SeqCst);
    Ok(())
}
