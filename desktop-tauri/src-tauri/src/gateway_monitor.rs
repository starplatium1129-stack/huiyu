use crate::{gateway::GatewaySupervisor, main_shared, maintenance, state::AppState};
use std::{sync::atomic::Ordering, time::Duration};
use tauri::{AppHandle, Emitter, Manager};

/// 网关健康监控：5s 轮询，连续 3 次失败或子进程退出 → 指数退避重启（2^n 秒封顶 30s）
pub(crate) fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut failures = 0u32;
        let mut restart_attempt = 0u32;
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            let state = app.state::<AppState>();
            if maintenance::active(&app) || state.quitting.load(Ordering::SeqCst) { continue; }
            let Some(supervisor) = app.try_state::<GatewaySupervisor>() else {
                continue;
            };
            let healthy = supervisor.is_healthy_async().await;
            if healthy {
                failures = 0;
                restart_attempt = 0;
                continue;
            }
            failures += 1;
            if failures < 3 {
                continue;
            }
            // 子进程已退出（owned 但不在运行）或 3 次探测失败 → 重启
            let delay = Duration::from_secs((2u64.saturating_pow(restart_attempt.min(5))).min(30));
            restart_attempt += 1;
            failures = 0;
            state.warn(&format!("gateway unhealthy, restarting in {delay:?}"));
            tokio::time::sleep(delay).await;
            if maintenance::active(&app) || state.quitting.load(Ordering::SeqCst) { continue; }
            match supervisor.start().await {
                Ok(url) => {
                    if let Err(error) = main_shared::authorize_gateway_origin(&app, &url) {
                        state.error(&format!("gateway capability rejected: {error}"));
                        continue;
                    }
                    *state.gateway_url.lock().unwrap() = url.clone();
                    let _ = app.emit("aics:gateway-ready", url.clone());
                    state.info(&format!("gateway restarted at {url}"));
                    // Existing documents reconnect through the typed transport;
                    // navigation here would discard unsaved drafts and task views.
                    main_shared::dispatch_startup(&app, &url);
                }
                Err(e) => state.error(&format!("gateway restart failed: {e}")),
            }
        }
    });
}
