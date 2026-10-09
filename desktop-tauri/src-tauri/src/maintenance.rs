//! A finite single-instance deployment handoff, separate from renderer IPC.
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Mutex, atomic::Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use ring::rand::{SecureRandom, SystemRandom};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use crate::maintenance_protocol::{self as protocol, Identity};

struct Handoff { id: String, phase: &'static str, acknowledgements: BTreeMap<String, Option<Result<(), String>>> }
pub struct MaintenanceHost { root: PathBuf, identity: Identity, handoff: Mutex<Option<Handoff>> }
fn milliseconds() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }
fn started_at() -> Result<String, String> {
    use windows_sys::Win32::{Foundation::FILETIME, System::Threading::{GetCurrentProcess, GetProcessTimes}};
    let empty = || FILETIME { dwLowDateTime:0, dwHighDateTime:0 };
    let (mut start, mut end, mut kernel, mut user) = (empty(), empty(), empty(), empty());
    if unsafe { GetProcessTimes(GetCurrentProcess(), &mut start, &mut end, &mut kernel, &mut user) } == 0 { return Err("MAINTENANCE_PROCESS_IDENTITY".into()); }
    Ok(((u64::from(start.dwHighDateTime) << 32) | u64::from(start.dwLowDateTime)).to_string())
}
impl MaintenanceHost {
    pub fn new(root: PathBuf, namespace: String, publish: bool) -> Result<Self, String> {
        let mut nonce = [0u8; 32]; SystemRandom::new().fill(&mut nonce).map_err(|_| "MAINTENANCE_RANDOM")?;
        let executable = std::env::current_exe().map_err(|_| "MAINTENANCE_EXECUTABLE")?.to_string_lossy().trim_start_matches(r"\\?\").to_string();
        let identity = Identity { protocol_version:1, instance_id:nonce.iter().map(|b| format!("{b:02x}")).collect(),
            host_pid:std::process::id(), started_at_filetime:started_at()?, executable, instance_namespace:namespace };
        protocol::directory(&root)?;
        if publish { protocol::write_json(&root.join(protocol::CAPABILITY_FILE), &identity)?; }
        Ok(Self { root, identity, handoff:Mutex::new(None) })
    }
    fn respond(&self, request_id: &str, state: &str, reason: Option<&str>) {
        let value = serde_json::json!({ "protocolVersion":1, "requestId":request_id,
            "instanceId":self.identity.instance_id, "hostPid":self.identity.host_pid,
            "startedAtFiletime":self.identity.started_at_filetime, "executable":self.identity.executable,
            "instanceNamespace":self.identity.instance_namespace,
            "state":state, "reason":reason });
        if let Err(error) = protocol::directory(&self.root).and_then(|dir| protocol::write_json(&dir.join(format!("{request_id}.response.json")), &value)) {
            eprintln!("[maintenance] {error}");
        }
    }
}
pub fn active(app: &AppHandle) -> bool {
    app.try_state::<MaintenanceHost>().is_some_and(|host| host.handoff.lock().unwrap().is_some())
}
pub fn admits(app: &AppHandle, command: &str) -> bool {
    let Some(host) = app.try_state::<MaintenanceHost>() else { return true; };
    let guard = host.handoff.lock().unwrap();
    let Some(state) = guard.as_ref() else { return true; };
    phase_admits(state.phase, command)
}
fn phase_admits(phase: &str, command: &str) -> bool {
    matches!(command, "desktop_maintenance_ack" | "desktop_bootstrap" | "get_state")
        || (phase == "preparing" && matches!(command, "chat_credential_read" | "chat_credential_write"))
        // A failed drain is not an install approval. Keep writes frozen, but
        // retain the user's existing normal Quit action as the repair exit.
        || (phase == "blocked" && command == "quit")
}
pub fn is_client() -> bool { protocol::cli(&std::env::args().collect::<Vec<_>>()).is_some() }
pub fn namespace() -> Result<Option<String>, String> {
    let argv: Vec<String> = std::env::args().collect();
    if protocol::cli(&argv).is_some() { return protocol::cli_namespace(&argv).map(Some); }
    if std::env::var("AICS_DESKTOP_MAINTENANCE_TEST").as_deref() != Ok("1") { return Ok(None); }
    let profile = crate::ui_entry::isolated_profile().ok_or("MAINTENANCE_TEST_REQUIRES_ISOLATION")?;
    let config = std::env::var_os("AICS_DESKTOP_CONFIG_ROOT").map(PathBuf::from).filter(|path| path.is_absolute()).ok_or("MAINTENANCE_TEST_REQUIRES_ISOLATION")?;
    let normalize = |path: PathBuf| std::fs::canonicalize(&path).unwrap_or(path).to_string_lossy().trim_start_matches(r"\\?\").replace('/', "\\").to_lowercase();
    let input = format!("{}\n{}", normalize(profile), normalize(config));
    let digest = ring::digest::digest(&ring::digest::SHA256, input.as_bytes());
    Ok(Some(format!("com.aics.studio.maintenance.{}", digest.as_ref().iter().map(|byte| format!("{byte:02x}")).collect::<String>())))
}

/// Consume all maintenance-shaped CLI requests, even malformed ones, so they
/// cannot accidentally show a window or fall through to a deep-link action.
pub fn handle(app: &AppHandle, argv: &[String]) -> bool {
    let Some(parsed) = protocol::cli(argv) else { return false; };
    let Ok((command, id)) = parsed else { return true; };
    let Some(host) = app.try_state::<MaintenanceHost>() else { return true; };
    if let Err(error) = protocol::load_request(&host.root, &host.identity, &command, &id) {
        host.respond(&id, "refused", Some(&error)); return true;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if command == "status" {
            let host = app.state::<MaintenanceHost>();
            let phase = host.handoff.lock().unwrap().as_ref().map(|value| value.phase);
            // This is process/gateway readiness, not proof that frontend JS or
            // images have mounted. Real window acceptance remains separate.
            let healthy = match app.try_state::<crate::gateway::GatewaySupervisor>() {
                Some(gateway) if gateway.owns_gateway() => gateway.is_healthy_async().await,
                _ => false,
            };
            let ready = healthy && !app.webview_windows().is_empty();
            host.respond(&id, phase.unwrap_or(if ready { "ready" } else { "starting" }), None);
        } else { shutdown(app, id).await; }
    });
    true
}
fn complete(app: &AppHandle, id: &str, state: &'static str, reason: &str) {
    let host = app.state::<MaintenanceHost>();
    if state == "cancelled" { *host.handoff.lock().unwrap() = None; }
    else if let Some(value) = host.handoff.lock().unwrap().as_mut() { value.phase = "blocked"; }
    let _ = app.emit("aics:maintenance-result", serde_json::json!({ "requestId":id, "state":state, "reason":reason }));
    host.respond(id, state, Some(reason));
}
async fn shutdown(app: AppHandle, id: String) {
    let labels: Vec<String> = app.webview_windows().keys().filter(|label| matches!(label.as_str(), "atelier" | "companion" | "companion-chat")).cloned().collect();
    {
        let host = app.state::<MaintenanceHost>();
        let mut state = host.handoff.lock().unwrap();
        if state.is_some() { host.respond(&id, "refused", Some("MAINTENANCE_BUSY")); return; }
        if labels.is_empty() { host.respond(&id, "refused", Some("MAINTENANCE_UI_NOT_READY")); return; }
        *state = Some(Handoff { id:id.clone(), phase:"preparing", acknowledgements:labels.iter().map(|label| (label.clone(), None)).collect() });
    }
    let deadline = milliseconds() + 20_000;
    for label in &labels {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.emit("aics:maintenance-prepare", serde_json::json!({ "requestId":id, "deadlineAt":deadline }));
        }
    }
    loop {
        let result = {
            let host = app.state::<MaintenanceHost>(); let guard = host.handoff.lock().unwrap();
            let state = guard.as_ref().unwrap();
            if let Some(error) = state.acknowledgements.values().find_map(|value| value.as_ref().and_then(|result| result.as_ref().err())) { Some(Err(error.clone())) }
            else if state.acknowledgements.values().all(Option::is_some) { Some(Ok(())) } else { None }
        };
        match result {
            Some(Err(error)) => { complete(&app, &id, "cancelled", &error); return; }
            Some(Ok(())) => break,
            None if milliseconds() >= deadline => { complete(&app, &id, "cancelled", "MAINTENANCE_FLUSH_TIMEOUT"); return; }
            None => tokio::time::sleep(Duration::from_millis(40)).await,
        }
    }
    app.state::<MaintenanceHost>().handoff.lock().unwrap().as_mut().unwrap().phase = "draining";
    let Some(gateway) = app.try_state::<crate::gateway::GatewaySupervisor>() else { complete(&app, &id, "blocked", "MAINTENANCE_GATEWAY_MISSING"); return; };
    if let Err(error) = gateway.maintenance_stop().await { complete(&app, &id, "blocked", &error); return; }
    // Stop admission stays closed until exit. A late stopped-event retry cannot
    // resurrect Live2D while the runtime drains or the OS tears down windows.
    crate::live2d_process::shutdown();
    app.state::<MaintenanceHost>().respond(&id, "drained", None);
    app.state::<crate::state::AppState>().quitting.store(true, Ordering::SeqCst);
    app.exit(0);
}

#[tauri::command]
pub fn desktop_maintenance_ack(window: WebviewWindow, request_id: String, ok: bool, error: Option<String>) -> Result<(), String> {
    if !protocol::valid_id(&request_id) { return Err("MAINTENANCE_REQUEST".into()); }
    let app = window.app_handle(); let host = app.state::<MaintenanceHost>();
    let mut guard = host.handoff.lock().unwrap();
    let state = guard.as_mut().filter(|value| value.id == request_id && value.phase == "preparing").ok_or("MAINTENANCE_NOT_PREPARING")?;
    let slot = state.acknowledgements.get_mut(window.label()).ok_or("MAINTENANCE_WINDOW_DENIED")?;
    if slot.is_none() {
        let reason = error.filter(|value| value.len() <= 80 && value.bytes().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')).unwrap_or_else(|| "MAINTENANCE_FLUSH_FAILED".into());
        *slot = Some(if ok { Ok(()) } else { Err(reason) });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::phase_admits;
    #[test]
    fn blocked_phase_allows_only_existing_explicit_quit_without_reopening_writes() {
        assert!(!phase_admits("preparing", "quit"));
        assert!(!phase_admits("draining", "quit"));
        assert!(phase_admits("blocked", "quit"));
        for command in ["chat_credential_write", "open_atelier", "desktop_workspace_prepare", "aics_live2d_set_character"] {
            assert!(!phase_admits("blocked", command));
        }
    }
}
