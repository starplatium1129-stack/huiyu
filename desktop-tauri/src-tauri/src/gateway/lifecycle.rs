use std::path::PathBuf;
use std::sync::atomic::Ordering;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use std::process::{Command, Stdio};

use super::{host, GatewayChild, GatewaySupervisor};
use crate::mutex::RecoverMutex;

struct ShutdownRequest {
    origin: String,
    secret: String,
    profile: String,
}

impl ShutdownRequest {
    fn drain(self) -> Result<(), String> {
        let drained = host::request(&self.origin, &self.secret, serde_json::json!({
            "action": "shutdown", "windowId": "atelier", "origin": self.origin, "sourceProfileId": self.profile,
        }))?;
        if drained["closed"] == true { Ok(()) } else { Err("MAINTENANCE_DRAIN_UNCONFIRMED".into()) }
    }
}

struct RetiredGateway {
    child: GatewayChild,
    config_root: Option<PathBuf>,
    request: Option<ShutdownRequest>,
}

impl RetiredGateway {
    fn reap(mut self) {
        let pid = self.child.process.id();
        let owner = || self.config_root.as_ref().and_then(|root| host::owner_snapshot(root, pid));
        let before_shutdown = owner();
        if let Some(request) = self.request.take() {
            let _ = request.drain();
        }
        terminate_child(&mut self.child);
        // The owner may have been created during startup, after the first snapshot.
        // Only the retained child handle can prove it has stopped.
        host::release_exited_owner(before_shutdown.or_else(owner), &mut self.child.process);
    }
}

impl GatewaySupervisor {
    fn shutdown_request(&self) -> Result<ShutdownRequest, String> {
        let secret = self.identity_token.recover_lock().clone().ok_or("HOST_IDENTITY_UNAVAILABLE")?;
        let profile = self.env.iter().find(|(key, _)| key == "AICS_DESKTOP_SOURCE_PROFILE_ID")
            .ok_or("HOST_PROFILE_UNAVAILABLE")?;
        Ok(ShutdownRequest { origin: self.base_url(), secret, profile: profile.1.clone() })
    }

    fn retire_child(&self) -> Option<RetiredGateway> {
        self.authenticated.store(false, Ordering::SeqCst);
        let child = self.child.recover_lock().take();
        self.owned.store(false, Ordering::Relaxed);
        child.map(|child| RetiredGateway {
            child,
            config_root: self.env.iter().find(|(key, _)| key == "AICS_DESKTOP_CONFIG_ROOT")
                .map(|(_, value)| PathBuf::from(value)),
            request: self.shutdown_request().ok(),
        })
    }

    pub(super) async fn reap_child(&self) -> Result<(), String> {
        if let Some(retired) = self.retire_child() {
            tauri::async_runtime::spawn_blocking(move || retired.reap())
                .await.map_err(|error| format!("gateway stop worker: {error}"))?;
        }
        Ok(())
    }

    pub(super) async fn stop(&self) {
        self.stop_generation.fetch_add(1, Ordering::SeqCst);
        let _ = self.reap_child().await;
    }

    /// Interrupted offline import freezes future starts without terminating a
    /// possibly live writer. The importer still acquires its workspace lease.
    pub async fn maintenance_idle(&self) -> Result<(), String> {
        self.stopping.store(true, Ordering::SeqCst);
        let _start_guard = self.start_lock.lock().await;
        self.stop_generation.fetch_add(1, Ordering::SeqCst);
        let mut slot = self.child.recover_lock();
        if let Some(child) = slot.as_mut() {
            if child.process.try_wait().map_err(|_| "MAINTENANCE_CHILD_WAIT")?.is_none() {
                return Err("MAINTENANCE_CHILD_RUNNING".into());
            }
        }
        slot.take();
        self.owned.store(false, Ordering::SeqCst);
        self.authenticated.store(false, Ordering::SeqCst);
        Ok(())
    }

    /// Only an authenticated positive drain receipt permits deployment.
    pub async fn maintenance_stop(&self) -> Result<(), String> {
        self.stopping.store(true, Ordering::SeqCst);
        let _start_guard = self.start_lock.lock().await;
        self.stop_generation.fetch_add(1, Ordering::SeqCst);
        if !self.owns_gateway() { return Err("MAINTENANCE_REQUIRES_OWNED_GATEWAY".into()); }
        let request = self.shutdown_request()?;
        if !self.is_healthy_async().await { return Err("HOST_IDENTITY_UNAVAILABLE".into()); }
        tauri::async_runtime::spawn_blocking(move || request.drain())
            .await.map_err(|_| "MAINTENANCE_DRAIN_WORKER")??;

        let mut child = self.child.recover_lock().take().ok_or("MAINTENANCE_CHILD_MISSING")?;
        // The signed receipt proves the gateway has released its lease. Use
        // the retained child handle to verify that its process has exited.
        let (child, exited) = tauri::async_runtime::spawn_blocking(move || {
            terminate_child(&mut child);
            let exited = child.process.try_wait().map_err(|_| "MAINTENANCE_CHILD_WAIT");
            (child, exited)
        }).await.map_err(|_| "MAINTENANCE_CHILD_WORKER")?;
        match exited {
            Ok(Some(_)) => {
                self.owned.store(false, Ordering::SeqCst);
                self.authenticated.store(false, Ordering::SeqCst);
                Ok(())
            }
            result => {
                *self.child.recover_lock() = Some(child);
                Err(result.err().unwrap_or("MAINTENANCE_CHILD_RUNNING").into())
            }
        }
    }

    /// Called by the desktop shutdown worker or as a final owning-state fallback.
    pub fn stop_sync(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        self.stop_generation.fetch_add(1, Ordering::SeqCst);
        if let Some(retired) = self.retire_child() { retired.reap(); }
    }
}

impl Drop for GatewaySupervisor {
    fn drop(&mut self) {
        self.stop_sync();
    }
}

fn terminate_child(child: &mut GatewayChild) {
    if matches!(child.process.try_wait(), Ok(Some(_))) { return; }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &child.process.id().to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000)
            .stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    let _ = child.process.kill();
    let _ = child.process.wait();
}
