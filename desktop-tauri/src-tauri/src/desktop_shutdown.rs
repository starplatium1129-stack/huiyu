use std::sync::atomic::{AtomicU8, Ordering};
use tauri::{AppHandle, Manager};

const RUNNING: u8 = 0;
const CLEANING: u8 = 1;
const FINISHED: u8 = 2;
static PHASE: AtomicU8 = AtomicU8::new(RUNNING);

pub fn finished() -> bool {
    PHASE.load(Ordering::Acquire) == FINISHED
}

fn cleanup(app: &AppHandle) {
    close_renderers(app);
    crate::window_persistence::shutdown(app);
    if let Some(supervisor) = app.try_state::<crate::gateway::GatewaySupervisor>() {
        supervisor.stop_sync();
    }
}

pub fn close_renderers(app: &AppHandle) {
    crate::live2d_overlay::shutdown(app);
    crate::live2d_process::shutdown();
}

pub fn request(app: &AppHandle, code: i32, restart: bool) {
    if PHASE.compare_exchange(RUNNING, CLEANING, Ordering::AcqRel, Ordering::Acquire).is_err() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let worker_app = app.clone();
        if let Err(error) = tauri::async_runtime::spawn_blocking(move || cleanup(&worker_app)).await {
            app.state::<crate::state::AppState>().warn(&format!("Desktop shutdown worker failed: {error}"));
        }
        PHASE.store(FINISHED, Ordering::Release);
        if restart { app.request_restart(); } else { app.exit(code); }
    });
}

/// All application restart commands prepare off-thread first. Retain bounded
/// renderer cleanup even for a restart initiated directly by Tauri.
pub fn finish_before_restart(app: &AppHandle) {
    if PHASE.compare_exchange(RUNNING, CLEANING, Ordering::AcqRel, Ordering::Acquire).is_ok() {
        cleanup(app);
        PHASE.store(FINISHED, Ordering::Release);
    }
}
