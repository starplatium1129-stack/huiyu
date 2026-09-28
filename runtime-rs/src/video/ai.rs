mod output;
mod prompts;
#[cfg(test)]
mod tests;
mod validation;

use crate::{
    AppState,
    error::{ApiError, Result},
    security,
};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{ConnectInfo, DefaultBodyLimit, OriginalUri, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::{Value, json};
use std::{net::SocketAddr, sync::LazyLock};

static CONSTANTS: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("ai/constants.json")).expect("video AI constants")
});
const SIZES: &[&str] = &["wide", "medium", "closeup"];
const CAMERAS: &[&str] = &["still", "push", "pull", "pan", "orbit"];
const MOTIONS: &[&str] = &["subtle", "natural", "expressive"];

pub(super) fn router() -> Router<AppState> {
    let mut router = Router::new().route("/api/video-ai/status", get(status));
    for action in ["rewrite", "polish", "dialogue", "review", "script"] {
        router = router.route(
            &format!("/api/video-ai/{action}"),
            post(complete).layer(DefaultBodyLimit::max(
                if matches!(action, "polish" | "review") {
                    256 * 1024
                } else {
                    64 * 1024
                },
            )),
        );
    }
    router
}
fn response(result: Result<Value>) -> Response {
    let mut response = match result {
        Ok(mut value) => {
            value["ok"] = json!(true);
            Json(value).into_response()
        }
        Err(error) => error.into_response(),
    };
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    response
}
async fn status(State(app): State<AppState>) -> Response {
    response(
        async {
            app.host.check_available()?;
            app.chat
                .as_ref()
                .ok_or_else(unavailable)?
                .mechanical_status(&app.config, &app.shutdown)
                .await
        }
        .await,
    )
}
async fn complete(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    response(
        async {
            if !security::is_direct_local(&headers, peer.ip()) {
                return Err(ApiError::new(403, "LOCAL_ONLY", "此操作仅允许在本机执行"));
            }
            app.host.check_available()?;
            let action = uri.path().rsplit('/').next().unwrap_or("");
            let raw: Value =
                serde_json::from_slice(&body).map_err(|_| invalid("请求体必须是 JSON 对象"))?;
            let input = validation::validate(action, &raw)?;
            let cancel = app.shutdown.child_token();
            let _guard = cancel.clone().drop_guard();
            let chat = app.chat.as_ref().ok_or_else(unavailable)?;
            let source = chat.mechanical_status(&app.config, &cancel).await?;
            if source["available"] != true {
                return Err(unavailable());
            }
            let messages = prompts::messages(action, &input);
            let text = chat
                .mechanical_complete(&app.config, messages, cancel)
                .await?;
            let parsed = output::extract(&text);
            let field = match action {
                "rewrite" => "shot",
                "dialogue" => "options",
                "review" => "issues",
                _ => "shots",
            };
            let mut result = json!({"source":source["source"],"model":source["model"]});
            result[field] = output::clean(action, &parsed, &input);
            Ok(result)
        }
        .await,
    )
}
fn unavailable() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT.as_u16(),
        "AI_LLM_UNAVAILABLE",
        "AI 整理暂不可用：请先在聊天设置中配置 API 或启动 Ollama",
    )
}
fn invalid(message: impl Into<String>) -> ApiError {
    ApiError::new(400, "INVALID_REQUEST", message)
}
fn truthy(value: &Value) -> bool {
    crate::generation::truthy(value)
}
fn text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Object(_) => "[object Object]".into(),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    text(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        _ => crate::storage::stringify(value),
    }
}
fn string(value: &Value, fallback: &str) -> String {
    if truthy(value) {
        text(value)
    } else {
        fallback.into()
    }
}
fn trim(value: &str) -> &str {
    value.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}
fn limited(value: &str, limit: usize) -> String {
    let mut units = 0;
    value
        .chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= limit
        })
        .collect()
}
fn length(value: &str) -> usize {
    value.encode_utf16().count()
}
fn clean_string(value: &Value, limit: usize) -> String {
    limited(trim(&string(value, "")), limit)
}
fn list(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.,
        Some(Value::Bool(v)) => {
            if *v {
                1.
            } else {
                0.
            }
        }
        Some(Value::Number(v)) => v.as_f64().unwrap_or(f64::NAN),
        Some(v) => {
            let text = text(v);
            let value = trim(&text);
            if value.is_empty() {
                0.
            } else {
                value.parse().unwrap_or(f64::NAN)
            }
        }
    }
}
