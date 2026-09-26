//! R1 exposes an authenticated descriptor, not workspace authority or secrets.
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
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBootstrap {
    protocol_version: u32,
    window_role: WindowRole,
    connection: &'static str,
    runtime: Option<RuntimeDescriptor>,
}

pub async fn read(window: WebviewWindow) -> Result<DesktopBootstrap, String> {
    let role = window_role(window.label())?;
    let url = window.url().map_err(|_| "BOOTSTRAP_ORIGIN_DENIED")?;
    let app = window.app_handle().clone();
    if !crate::main_shared::is_gateway_origin(&app, &url) {
        return Err("BOOTSTRAP_ORIGIN_DENIED".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let gateway = app.state::<crate::gateway::GatewaySupervisor>();
        // Reuse the supervisor's fresh challenge/HMAC proof, never public health
        // alone. The endpoint is selected by the host, not renderer input.
        let ready = gateway.is_healthy();
        let runtime = if ready {
            Some(RuntimeDescriptor {
                origin: gateway.base_url(),
                protocol_version: crate::gateway::DESKTOP_GATEWAY_PROTOCOL,
                ownership: if gateway.owns_gateway() { "managed" } else { "attached" },
            })
        } else { None };
        DesktopBootstrap {
            protocol_version: 1,
            window_role: role,
            connection: if ready { "ready" } else { "unavailable" },
            runtime,
        }
    }).await.map_err(|_| "BOOTSTRAP_CHECK_FAILED".into())
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

    #[test]
    fn descriptor_has_only_the_r1_wire_fields() {
        let dto = DesktopBootstrap {
            protocol_version: 1, window_role: WindowRole::Atelier, connection: "ready",
            runtime: Some(RuntimeDescriptor { origin: "http://127.0.0.1:4312".into(), protocol_version: 1, ownership: "managed" }),
        };
        assert_eq!(serde_json::to_value(dto).unwrap(), serde_json::json!({
            "protocolVersion": 1, "windowRole": "atelier", "connection": "ready",
            "runtime": { "origin": "http://127.0.0.1:4312", "protocolVersion": 1, "ownership": "managed" }
        }));
    }
}
