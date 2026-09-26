//! Only host-labelled windows receive short-lived private workspace sessions.
use serde::Serialize;
use tauri::{Manager, WebviewWindow};

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum WindowRole { Atelier, Companion, CompanionChat }

fn window_role(label: &str) -> Result<WindowRole, String> {
    match label {
        "atelier" => Ok(WindowRole::Atelier),
        "companion" => Ok(WindowRole::Companion),
        "companion-chat" => Ok(WindowRole::CompanionChat),
        _ => Err("BOOTSTRAP_WINDOW_DENIED: unknown window label".into()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDescriptor {
    origin: String,
    protocol_version: i64,
    ownership: &'static str,
    runtime_epoch: String,
    workspace: serde_json::Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBootstrap {
    protocol_version: u32,
    window_role: WindowRole,
    window_id: String,
    source_profile_id: String,
    source_origin: String,
    bundled_ui_available: bool,
    connection: &'static str,
    runtime: Option<RuntimeDescriptor>,
}

pub async fn read(window: WebviewWindow) -> Result<DesktopBootstrap, String> {
    request(window, "session", None, false).await
}

pub async fn request(window: WebviewWindow, action: &'static str, migration_id: Option<String>, bundled_ui: bool) -> Result<DesktopBootstrap, String> {
    let role = window_role(window.label())?;
    let url = window.url().map_err(|_| "BOOTSTRAP_ORIGIN_DENIED")?;
    let app = window.app_handle().clone();
    if !crate::main_shared::is_gateway_origin(&app, &url) {
        return Err("BOOTSTRAP_ORIGIN_DENIED".into());
    }
    if action != "session" && role != WindowRole::Atelier { return Err("HOST_ROLE_DENIED".into()); }
    if bundled_ui && !crate::ui_entry::can_enable_bundled() { return Err("BUNDLED_UI_ACCEPTANCE_REQUIRED".into()); }
    let window_id = window.label().to_string();
    let source_origin = url.origin().ascii_serialization();
    tauri::async_runtime::spawn_blocking(move || {
        let source_profile_id = app.state::<crate::state::AppState>().paths.source_profile_id.clone();
        let gateway = app.state::<crate::gateway::GatewaySupervisor>();
        // Reuse the supervisor's fresh challenge/HMAC proof, never public health
        // alone. The endpoint is selected by the host, not renderer input.
        let ready = gateway.is_healthy();
        let runtime = if ready {
            let response = gateway.host_request(serde_json::json!({
                "action": action, "windowId": window_id, "origin": source_origin,
                "sourceProfileId": source_profile_id, "migrationId": migration_id, "bundledUi": bundled_ui,
            }))?;
            Some(RuntimeDescriptor {
                origin: gateway.base_url(),
                protocol_version: crate::gateway::DESKTOP_GATEWAY_PROTOCOL,
                ownership: if gateway.owns_gateway() { "managed" } else { "attached" },
                runtime_epoch: gateway.runtime_epoch(),
                workspace: response.get("workspace").cloned().unwrap_or(serde_json::Value::Null),
            })
        } else { None };
        Ok(DesktopBootstrap {
            protocol_version: 1,
            window_role: role,
            window_id,
            source_profile_id,
            source_origin,
            bundled_ui_available: crate::ui_entry::can_enable_bundled(),
            connection: if ready { "ready" } else { "unavailable" },
            runtime,
        })
    }).await.map_err(|_| "BOOTSTRAP_CHECK_FAILED".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roles_are_host_labels_and_unknown_windows_are_denied() {
        for (label, role) in [("atelier", WindowRole::Atelier), ("companion", WindowRole::Companion), ("companion-chat", WindowRole::CompanionChat)] {
            assert_eq!(window_role(label).unwrap(), role);
            assert_eq!(serde_json::to_value(role).unwrap(), label);
        }
        assert!(window_role("preview").is_err());
    }

}
