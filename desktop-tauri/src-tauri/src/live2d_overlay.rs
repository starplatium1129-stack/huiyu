//! Tauri adapter for the reusable native Live2D renderer.

use crate::mutex::RecoverMutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
pub use crate::live2d_renderer::{Live2DOverlayState, OverlayRect};
use crate::live2d_renderer::*;
use crate::live2d_renderer::live2d_adapter::Live2DAdapterConfig;
use crate::live2d_renderer::live2d_assets;
use crate::live2d_process_protocol::Command as ProcessCommand;

struct OverlayWorker {
    thread: thread::JoinHandle<()>,
    finished: mpsc::Receiver<()>,
}

static OVERLAY_WORKER: Mutex<Option<OverlayWorker>> = Mutex::new(None);
static OVERLAY_STOPPING: AtomicBool = AtomicBool::new(false);
const MODEL_REPLY_TIMEOUT: Duration = Duration::from_secs(45);
const COMMAND_REPLY_TIMEOUT: Duration = Duration::from_secs(5);
pub fn ensure_overlay(app: &AppHandle, assets_root: std::path::PathBuf) -> Arc<Live2DOverlayState> {
    let mut worker = OVERLAY_WORKER.recover_lock();
    if OVERLAY_STOPPING.load(Ordering::Acquire)
        || app.state::<crate::state::AppState>().quitting.load(Ordering::Acquire)
    {
        let state = Arc::new(Live2DOverlayState::default());
        state.shutdown.store(true, Ordering::Release);
        return state;
    }
    let state = if let Some(state) = app.try_state::<Arc<Live2DOverlayState>>() {
        state.inner().clone()
    } else {
        let state = Arc::new(Live2DOverlayState::default());
        let shown = app.state::<crate::state::AppState>().companion_presentation.recover_lock().shown;
        state.revealed.store(shown, Ordering::Release);
        app.manage(state.clone());
        state
    };
    if try_begin_startup(&state) {
        let handle = state.clone();
        let app2 = app.clone();
        let runtime_root = app.state::<crate::state::AppState>().paths.runtime_root.clone();
        let local_root = Some(runtime_root.join("live2d-imports"));
        let cache_root = Some(runtime_root.join("live2d-cache"));
        let events = RendererEvents(Arc::new(move |name, value| {
            if name == "aics:live2d:first-frame" { crate::companion_window::native_frame(&app2); }
            let _ = app2.emit(name, value);
        }));
        let (done, finished) = mpsc::sync_channel(1);
        let thread = thread::spawn(move || {
            overlay_window_thread(handle, RendererEnvironment {
                assets_root, local_root, cache_root, events: Some(events), attached: None,
            });
            let _ = done.send(());
        });
        *worker = Some(OverlayWorker { thread, finished });
    }
    state
}

/// Stop admission first, then let the owning render thread release GPU and
/// Win32 resources. Call from a blocking worker, never while holding an IPC lock.
pub fn shutdown(app: &AppHandle) {
    let worker = {
        let mut worker = OVERLAY_WORKER.recover_lock();
        OVERLAY_STOPPING.store(true, Ordering::Release);
        if let Some(state) = app.try_state::<Arc<Live2DOverlayState>>() {
            state.shutdown.store(true, Ordering::Release);
            if let Some(sender) = state.cmd_tx.recover_lock().as_ref() {
                let _ = sender.send(OverlayCommand::Shutdown);
            }
        }
        worker.take()
    };
    let Some(worker) = worker else { return; };
    let state = app.state::<crate::state::AppState>();
    if matches!(worker.finished.recv_timeout(Duration::from_secs(2)), Err(mpsc::RecvTimeoutError::Timeout)) {
        state.warn("Live2D overlay shutdown timed out");
    } else if worker.thread.join().is_err() {
        state.warn("Live2D overlay thread exited unexpectedly");
    }
}

pub fn prewarm(app: &AppHandle) {
    if crate::live2d_process::enabled() { return; }
    // Prepare only the HWND and command channel. The GPU starts at SetCharacter.
    ensure_overlay(app, overlay_assets_root(app));
}

pub fn first_frame_ready(app: &AppHandle) -> bool {
    app.try_state::<Arc<Live2DOverlayState>>().is_some_and(|state| state.first_frame_ready.load(Ordering::Acquire))
}

pub fn set_revealed(app: &AppHandle, visible: bool) {
    if let Some(state) = app.try_state::<Arc<Live2DOverlayState>>() {
        crate::live2d_renderer::set_revealed(&state, visible);
        if !visible {
            let _ = send_command(&state, OverlayCommand::ReleaseHidden);
        }
    }
    if !visible && crate::live2d_process::enabled() {
        crate::live2d_process::release_hidden();
    }
}

fn overlay_assets_root(app: &AppHandle) -> std::path::PathBuf {
    app.state::<crate::state::AppState>()
        .paths
        .assets_root
        .clone()
}

pub async fn apply_frame(
    app: &AppHandle,
    local_rect: OverlayRect,
    visible: bool,
    opacity: Option<u32>,
    framing: crate::live2d_framing::StageFraming,
) -> Result<(), String> {
    let state = ensure_overlay(app, overlay_assets_root(app));
    wait_for_attachment(&state, Duration::from_secs(1)).await?;
    *state.framing.recover_lock() = framing;
    let companion = app.get_webview_window("companion").and_then(|window| window.hwnd().ok()).map(|handle| handle.0 as isize);
    crate::live2d_renderer::apply_frame(&state, local_rect, visible, opacity, companion)
}

async fn renderer_reply<T>(
    state: &Arc<Live2DOverlayState>,
    timeout: Duration,
    command: impl FnOnce(OverlayReply<T>) -> OverlayCommand,
) -> Result<T, String> {
    let (reply, wait) = tokio::sync::oneshot::channel();
    send_command_async(state, command(OverlayReply::Async(reply))).await?;
    tokio::time::timeout(timeout, wait).await
        .map_err(|_| "renderer reply timed out".to_string())?
        .map_err(|_| "renderer dropped command".to_string())
}

/// 异步版 send_command：模型加载/纹理解码需要数秒，绝不能在 Tauri 主线程
/// 用 pollster::block_on 等待，否则 UI 线程被冻结、前端 loading 无法显示。
async fn send_command_async(
    state: &Arc<Live2DOverlayState>,
    cmd: OverlayCommand,
) -> Result<(), String> {
    wait_for_attachment(state, Duration::from_secs(2)).await?;
    send_command(state, cmd)
}

async fn wait_for_attachment(state: &Live2DOverlayState, timeout: Duration) -> Result<(), String> {
    tokio::time::timeout(timeout, async {
        loop {
            let changed = state.startup_changed.notified();
            if state.shutdown.load(Ordering::Acquire) {
                return Err("renderer is shutting down".into());
            }
            if state.window_ready.load(Ordering::Acquire) {
                return Ok(());
            }
            if !state.starting.load(Ordering::Acquire) {
                return Err("renderer not attached".into());
            }
            changed.await;
        }
    }).await.map_err(|_| "renderer startup timed out".to_string())?
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
    let result = renderer_reply(&state, MODEL_REPLY_TIMEOUT, |reply| {
        OverlayCommand::SetCharacter {
            character,
            texture_scale,
            adapter,
            reply,
        }
    }).await?;
    match result {
        Ok(()) => Ok(serde_json::json!({ "ok": true })),
        Err(e) => Ok(serde_json::json!({ "ok": false, "error": e })),
    }
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
    let result = renderer_reply(&state, COMMAND_REPLY_TIMEOUT, |reply| {
        OverlayCommand::PlayMotion {
            group,
            index,
            priority,
            reply,
        }
    }).await?;
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
    let result = renderer_reply(&state, COMMAND_REPLY_TIMEOUT, |reply| {
        OverlayCommand::SetExpression { name, reply }
    }).await?;
    match result {
        Ok(()) => Ok(serde_json::json!({ "ok": true })),
        Err(e) => Ok(serde_json::json!({ "ok": false, "error": e })),
    }
}

#[tauri::command]
pub async fn aics_live2d_set_mouth_level(app: AppHandle, level: f64) -> Result<(), String> {
    if crate::live2d_process::enabled() { return crate::live2d_process::call(&app, ProcessCommand::SetMouthLevel { level: level as f32 }).await.map(|_| ()); }
    if let Some(state) = app.try_state::<Arc<Live2DOverlayState>>() {
        state.publish_mouth(level as f32);
    }
    Ok(())
}

#[tauri::command]
pub async fn aics_live2d_set_max_fps(app: AppHandle, fps: f64) -> Result<(), String> {
    let fps = if fps == 0.0 { 0 } else if fps.is_finite() { fps.round().clamp(1.0, 1000.0) as u32 } else { 60 };
    if crate::live2d_process::enabled() { return crate::live2d_process::call(&app, ProcessCommand::SetMaxFps { fps }).await.map(|_| ()); }
    let state = ensure_overlay(&app, overlay_assets_root(&app));
    send_command_async(&state, OverlayCommand::SetMaxFps(fps)).await
}

#[tauri::command]
pub async fn aics_live2d_set_emotion(app: AppHandle, name: String, intensity: f64) -> Result<(), String> {
    if crate::live2d_process::enabled() { return crate::live2d_process::call(&app, ProcessCommand::SetEmotion { name, intensity: intensity as f32 }).await.map(|_| ()); }
    let assets_root = overlay_assets_root(&app);
    let state = ensure_overlay(&app, assets_root);
    send_command_async(
        &state,
        OverlayCommand::SetEmotion {
            name,
            intensity: intensity as f32,
        },
    ).await
}

#[tauri::command]
pub async fn aics_live2d_set_gaze(app: AppHandle, x: f64, y: f64) -> Result<(), String> {
    if crate::live2d_process::enabled() { return crate::live2d_process::call(&app, ProcessCommand::SetGaze { x: x as f32, y: y as f32 }).await.map(|_| ()); }
    if let Some(state) = app.try_state::<Arc<Live2DOverlayState>>() {
        state.publish_gaze(x as f32, y as f32);
    }
    Ok(())
}

#[tauri::command]
pub async fn aics_live2d_hit_test(app: AppHandle, x: f64, y: f64) -> Result<serde_json::Value, String> {
    if crate::live2d_process::enabled() { return crate::live2d_process::call(&app, ProcessCommand::HitTest { x: x as f32, y: y as f32 }).await; }
    let assets_root = overlay_assets_root(&app);
    let state = ensure_overlay(&app, assets_root);
    let areas = renderer_reply(&state, COMMAND_REPLY_TIMEOUT, |reply| {
        OverlayCommand::HitTest {
            x: x as f32,
            y: y as f32,
            reply,
        }
    }).await??;
    Ok(serde_json::json!({ "areas": areas }))
}

#[tauri::command]
pub async fn aics_live2d_destroy(app: AppHandle) -> Result<(), String> {
    if crate::live2d_process::enabled() { return crate::live2d_process::call(&app, ProcessCommand::Destroy).await.map(|_| ()); }
    let Some(state) = app.try_state::<Arc<Live2DOverlayState>>() else { return Ok(()); };
    if state.shutdown.load(Ordering::Acquire)
        || (!state.starting.load(Ordering::Acquire) && !state.renderer_attached.load(Ordering::Acquire))
    {
        return Ok(());
    }
    renderer_reply(&state, COMMAND_REPLY_TIMEOUT, |reply| OverlayCommand::Destroy { reply }).await
}
