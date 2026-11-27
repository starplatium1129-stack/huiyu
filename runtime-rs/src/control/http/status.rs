use super::{super::{ControlService, now}, web_build};
use axum::{
    Extension, Json,
    extract::Query,
    response::{IntoResponse, Response},
};
use serde::ser::{SerializeMap as _, SerializeSeq as _};
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Arc};

struct StatusResponse {
    health: Arc<Value>,
    overlay: Value,
}
impl serde::Serialize for StatusResponse {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        let health = self.health.as_object().unwrap();
        let overlay = self.overlay.as_object().unwrap();
        let mut map = serializer.serialize_map(None)?;
        for (key, value) in health {
            map.serialize_entry(key, overlay.get(key).unwrap_or(value))?;
        }
        for (key, value) in overlay {
            if !health.contains_key(key) {
                map.serialize_entry(key, value)?;
            }
        }
        map.end()
    }
}
#[derive(serde::Serialize)]
pub(super) struct LogsResponse {
    #[serde(serialize_with = "serialize_lines")]
    logs: Vec<Arc<String>>,
    total: u64,
    operation: Option<Value>,
}
fn serialize_lines<S: serde::Serializer>(
    lines: &[Arc<String>],
    serializer: S,
) -> std::result::Result<S::Ok, S::Error> {
    let mut seq = serializer.serialize_seq(Some(lines.len()))?;
    for line in lines {
        seq.serialize_element(line.as_ref())?;
    }
    seq.end()
}

pub(super) async fn status(
    Extension(s): Extension<Arc<ControlService>>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let (build, health, (tunnel_available, scripts)) = tokio::join!(
        web_build::snapshot_ready(&s),
        s.health(query.get("fresh").is_some_and(|v| v == "1")),
        file_status(&s),
    );
    let mut value = s.config_view();
    let (tunnel_status, tunnel_managed) = s.tunnel_status().await;
    let operation = s.state.lock().unwrap().operation.clone();
    let mode_busy = operation.as_ref().is_some_and(|op| {
        op["status"] == "running" && op["kind"].as_str().is_some_and(|s| s.starts_with("mode-"))
    });
    value["ok"] = true.into();
    value["running"] = (!s.shutdown.is_cancelled()).into();
    value["modeBusy"] = mode_busy.into();
    value["operation"] = operation.unwrap_or(Value::Null);
    value["localLink"] = format!("http://127.0.0.1:{}/", s.config.bind.port()).into();
    value["shareLinkAvailable"] = (tunnel_status == "active").into();
    value["tunnelStatus"] = tunnel_status.into();
    value["tunnelManaged"] = tunnel_managed.into();
    value["tunnelAvailable"] = tunnel_available.into();
    value["uptime"] = s.started.elapsed().as_secs().into();
    value["scripts"] = scripts;
    value["selfHealing"] = s.watchdog_status();
    value["webBuild"] = build.or_else(|| web_build::current(&s)).unwrap_or(Value::Null);
    Json(StatusResponse {
        health,
        overlay: value,
    })
    .into_response()
}
async fn file_status(s: &ControlService) -> (bool, Value) {
    let tunnel_enabled = !s.tunnel_disabled();
    let tunnel = s.tunnel_path();
    let scripts = [s.script(0), s.script(1), s.script(2)];
    tokio::task::spawn_blocking(move || {
        let voice = scripts[2].is_file();
        (
            tunnel_enabled && tunnel.is_file(),
            json!({"voiceStart":voice,"voiceStop":voice,"webui":scripts[0].is_file(),"comfy":scripts[1].is_file()}),
        )
    })
    .await
    .unwrap_or_else(|_| (false, json!({"voiceStart":false,"voiceStop":false,"webui":false,"comfy":false})))
}
pub(super) async fn share(Extension(s): Extension<Arc<ControlService>>) -> Json<Value> {
    Json(json!({"ok":true,"shareLink":s.share_link().await}))
}
pub(super) async fn logs(
    Extension(s): Extension<Arc<ControlService>>,
    Query(query): Query<HashMap<String, String>>,
) -> Json<LogsResponse> {
    let since = query
        .get("since")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    let (mut logs, total, operation) = {
        let state = s.state.lock().unwrap();
        let head = state.log_seq.saturating_sub(state.logs.len() as u64);
        let from = since.max(head).min(state.log_seq);
        (
            state
                .logs
                .iter()
                .skip((from - head) as usize)
                .cloned()
                .collect::<Vec<_>>(),
            state.log_seq,
            state.operation.clone(),
        )
    };
    logs.extend(s.file_logs().await);
    Json(LogsResponse {
        logs,
        total,
        operation,
    })
}
fn redact_config(s: &ControlService, value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| {
                    let lower = k.to_ascii_lowercase();
                    (
                        k.clone(),
                        if [
                            "token",
                            "secret",
                            "password",
                            "credential",
                            "apikey",
                            "remotekey",
                            "api_key",
                            "authorization",
                            "auth",
                            "cookie",
                            "prompt",
                            "messages",
                            "imagedata",
                        ]
                        .iter()
                        .any(|key| lower.contains(key))
                        {
                            json!("[redacted]")
                        } else {
                            redact_config(s, v)
                        },
                    )
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|v| redact_config(s, v))
                .collect::<Vec<_>>(),
        ),
        Value::String(text) => Value::String(s.redact(text)),
        other => other.clone(),
    }
}
pub(super) async fn diagnostics(Extension(s): Extension<Arc<ControlService>>) -> Json<Value> {
    let mut value = s.settings();
    value["timestamp"] = json!(
        chrono::DateTime::from_timestamp_millis(now() as i64)
            .unwrap()
            .to_rfc3339()
    );
    value["uptime"] = json!(s.started.elapsed().as_secs());
    value["port"] = json!(s.config.bind.port());
    // Kept as the legacy wire field until the shared TS diagnostics schema is
    // versioned; empty states correctly that no Node interpreter runs here.
    value["nodeVersion"] = json!("");
    value["runtimeVersion"] = json!(concat!("rust-runtime/", env!("CARGO_PKG_VERSION")));
    value["platform"] = json!(if cfg!(windows) {
        "win32"
    } else {
        std::env::consts::OS
    });
    value["disableTunnel"] = json!(s.tunnel_disabled());
    value["runtimeConfig"] = redact_config(&s, &s.saved.read().unwrap());
    value["token"] = json!({"present":!s.config.token.is_empty(),"length":s.config.token.len(),"suffix":"[redacted]"});
    value["operation"] = json!(s.state.lock().unwrap().operation);
    value["scripts"] = json!({"voiceStart":s.script(2),"voiceStop":s.script(2),"webui":s.script(0),"comfy":s.script(1),"voiceStartExists":s.script(2).is_file(),"voiceStopExists":s.script(2).is_file(),"webuiExists":s.script(0).is_file(),"comfyExists":s.script(1).is_file()});
    value["sceneShowcaseDir"] = json!(
        std::env::var("SCENE_SHOWCASE_DIR")
            .ok()
            .or_else(|| s.saved.read().unwrap()["sceneShowcaseDir"]
                .as_str()
                .map(str::to_owned))
            .unwrap_or_default()
    );
    Json(value)
}
