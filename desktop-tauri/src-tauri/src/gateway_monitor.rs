use crate::{gateway::GatewaySupervisor, main_shared, maintenance, mutex::RecoverMutex, state::AppState};
use std::sync::{atomic::Ordering, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tokio::sync::Notify;

const HEALTH_INTERVAL: Duration = Duration::from_secs(5);
const EXIT_INTERVAL: Duration = Duration::from_millis(250);
const STABLE_AFTER: Duration = Duration::from_secs(25);
const MAX_RESTARTS: u32 = 3;

#[derive(Clone, Copy, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Phase {
    #[default]
    Starting,
    Ready,
    Reconnecting,
    Failed,
}

#[derive(Clone, Copy, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    revision: u64,
    phase: Phase,
    reason: &'static str,
}

#[derive(Default)]
pub(crate) struct Recovery {
    snapshot: Mutex<Snapshot>,
    retry: Notify,
}

impl Recovery {
    pub(crate) fn publish(&self, app: &AppHandle, phase: Phase, reason: &'static str) {
        let next = {
            let mut snapshot = self.snapshot.recover_lock();
            if snapshot.phase == phase && snapshot.reason == reason { return; }
            snapshot.revision += 1;
            snapshot.phase = phase;
            snapshot.reason = reason;
            *snapshot
        };
        let _ = app.emit_to("atelier", "aics:gateway-recovery", next);
    }
}

#[tauri::command]
pub(crate) fn desktop_gateway_recovery(window: WebviewWindow) -> Result<Snapshot, String> {
    crate::bootstrap::require_atelier(&window)?;
    let snapshot = *window.state::<AppState>().gateway_recovery.snapshot.recover_lock();
    Ok(snapshot)
}

#[tauri::command]
pub(crate) fn desktop_gateway_retry(window: WebviewWindow) -> Result<(), String> {
    crate::bootstrap::require_atelier(&window)?;
    let state = window.state::<AppState>();
    if state.quitting.load(Ordering::Acquire) || maintenance::active(window.app_handle()) {
        return Err("桌面端正在退出或维护中".into());
    }
    if state.gateway_recovery.snapshot.recover_lock().phase == Phase::Reconnecting { return Ok(()); }
    state.gateway_recovery.retry.notify_one();
    Ok(())
}

async fn restart(app: &AppHandle, supervisor: &GatewaySupervisor) -> Result<(), String> {
    let state = app.state::<AppState>();
    let url = supervisor.start().await?;
    main_shared::authorize_gateway_origin(app, &url).map_err(|error| error.to_string())?;
    *state.gateway_url.recover_lock() = url.clone();
    crate::window_state::save_desktop_gateway_port(&state.paths.gateway_port_file, supervisor.port());
    let _ = app.emit("aics:gateway-ready", &url);
    main_shared::dispatch_startup(app, &url);
    Ok(())
}

pub(crate) fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let supervisor = app.state::<GatewaySupervisor>();
        let recovery = &state.gateway_recovery;
        let mut tick = tokio::time::interval(EXIT_INTERVAL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut next_health = Instant::now() + HEALTH_INTERVAL;
        let mut failures = 0u32;
        let mut restarts = 0u32;
        let mut stable_since = None;
        let mut next_restart = None;
        loop {
            let manual = tokio::select! {
                _ = tick.tick() => false,
                _ = recovery.retry.notified() => true,
            };
            if state.quitting.load(Ordering::Acquire) { break; }
            if maintenance::active(&app) { continue; }
            let snapshot = *recovery.snapshot.recover_lock();
            let phase = snapshot.phase;
            if phase == Phase::Starting { continue; }
            if manual {
                failures = 0;
                restarts = 0;
                stable_since = None;
                next_restart = Some((Instant::now(), "manual"));
            } else if phase == Phase::Failed { continue; }
            let now = Instant::now();
            if next_restart.is_none() {
                if phase == Phase::Reconnecting {
                    next_restart = Some((now, snapshot.reason));
                } else if supervisor.owned_child_exited() {
                    next_restart = Some((now, "childExited"));
                } else if now >= next_health {
                    next_health = now + HEALTH_INTERVAL;
                    if supervisor.is_healthy_async().await {
                        failures = 0;
                        if now.duration_since(*stable_since.get_or_insert(now)) >= STABLE_AFTER {
                            restarts = 0;
                        }
                        continue;
                    }
                    stable_since = None;
                    failures += 1;
                    if failures >= 3 {
                        next_restart = Some((now, "healthCheck"));
                    }
                }
            }
            let Some((scheduled, reason)) = next_restart else { continue; };
            if now < scheduled { continue; }
            if restarts >= MAX_RESTARTS {
                next_restart = None;
                recovery.publish(&app, Phase::Failed, reason);
                continue;
            }
            restarts += 1;
            stable_since = None;
            failures = 0;
            recovery.publish(&app, Phase::Reconnecting, reason);
            let _ = app.emit("aics:gateway-unavailable", ());
            match restart(&app, &supervisor).await {
                Ok(()) => {
                    state.info("gateway recovered");
                    recovery.publish(&app, Phase::Ready, "");
                    next_health = Instant::now() + HEALTH_INTERVAL;
                    next_restart = None;
                }
                Err(error) => {
                    state.error(&format!("gateway restart failed ({restarts}): {error}"));
                    next_restart = Some((Instant::now() + Duration::from_secs(u64::from(restarts)), "restartFailed"));
                }
            }
        }
    });
}
