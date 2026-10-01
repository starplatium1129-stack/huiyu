use crate::error::{ApiError, Result};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashSet};
use tokio::io::{AsyncBufRead, AsyncBufReadExt};

pub(super) const MODEL: &str = "pixai-tagger-v1.0";
pub(super) const MODEL_FILES: &[&str] = &[
    "model.safetensors",
    "tagger_pipeline.py",
    "config.json",
    "preprocessor_config.json",
    "README.md",
];
const LINE_LIMIT: usize = 256 * 1024;

pub(super) async fn read(reader: &mut (impl AsyncBufRead + Unpin)) -> Result<Value> {
    let mut line = Vec::new();
    loop {
        let buffer = reader.fill_buf().await.map_err(|_| invalid())?;
        if buffer.is_empty() {
            return Err(invalid());
        }
        let count = buffer
            .iter()
            .position(|b| *b == b'\n')
            .map_or(buffer.len(), |n| n + 1);
        if line.len() + count > LINE_LIMIT {
            return Err(invalid());
        }
        line.extend_from_slice(&buffer[..count]);
        reader.consume(count);
        if line.last() == Some(&b'\n') {
            break;
        }
    }
    serde_json::from_slice(&line).map_err(|_| invalid())
}

#[derive(Deserialize)]
struct Ready {
    kind: String,
    ok: bool,
    engine: String,
    model: String,
    #[serde(default)]
    meta: Map<String, Value>,
    code: Option<String>,
    error: Option<String>,
}

pub(super) fn ready(value: Value) -> Result<Value> {
    let value: Ready = serde_json::from_value(value).map_err(|_| invalid())?;
    if value.kind != "ready" || value.engine != "pixai" || value.model != MODEL {
        return Err(invalid());
    }
    if !value.ok {
        return Err(failure(value.code, value.error)?);
    }
    if !valid_meta(&value.meta) {
        return Err(invalid());
    }
    Ok(Value::Object(value.meta))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    request_id: String,
    ok: bool,
    engine: Option<String>,
    model: Option<String>,
    tags: Option<Vec<String>>,
    scores: Option<BTreeMap<String, f64>>,
    character_tags: Option<Vec<String>>,
    rating: Option<BTreeMap<String, f64>>,
    meta: Option<Map<String, Value>>,
    code: Option<String>,
    error: Option<String>,
}

pub(super) fn response(value: Value, id: &str) -> Result<Value> {
    let value: Response = serde_json::from_value(value).map_err(|_| invalid())?;
    if value.request_id != id {
        return Err(invalid());
    }
    if !value.ok {
        return Err(failure(value.code, value.error)?);
    }
    if value.engine.as_deref() != Some("pixai") || value.model.as_deref() != Some(MODEL) {
        return Err(invalid());
    }
    let tags = value.tags.ok_or_else(invalid)?;
    let scores = value.scores.ok_or_else(invalid)?;
    let characters = value.character_tags.ok_or_else(invalid)?;
    let rating = value.rating.ok_or_else(invalid)?;
    let meta = value.meta.ok_or_else(invalid)?;
    if !valid_tags(&tags)
        || !valid_tags(&characters)
        || scores.len() != tags.len()
        || !tags.iter().all(|t| scores.contains_key(t))
        || !scores
            .values()
            .chain(rating.values())
            .all(|p| p.is_finite() && (0.0..=1.0).contains(p))
        || !valid_meta(&meta)
        || rating.len() != 4
        || !["general", "sensitive", "questionable", "explicit"]
            .iter()
            .all(|key| rating.contains_key(*key))
    {
        return Err(invalid());
    }
    Ok(json!({
        "ok":true, "engine":"pixai", "model":MODEL,
        "tags":tags, "scores":scores, "characterTags":characters,
        "rating":rating, "meta":meta
    }))
}

fn valid_tags(tags: &[String]) -> bool {
    tags.len() <= 100
        && tags.iter().all(|s| !s.is_empty() && s.len() <= 512)
        && tags.iter().collect::<HashSet<_>>().len() == tags.len()
}

fn valid_meta(meta: &Map<String, Value>) -> bool {
    serde_json::to_vec(meta).is_ok_and(|bytes| bytes.len() <= 64 * 1024)
}

fn failure(code: Option<String>, error: Option<String>) -> Result<ApiError> {
    let code = code.ok_or_else(invalid)?;
    let status = match code.as_str() {
        "INVALID_IMAGE" | "INVALID_PARAMETER" => 400,
        "IMAGE_TOO_LARGE" => 413,
        "PIXAI_MODEL_MISSING"
        | "PIXAI_MODEL_INTEGRITY"
        | "PIXAI_DEPENDENCY_MISSING"
        | "PIXAI_GPU_UNAVAILABLE"
        | "PIXAI_OUT_OF_MEMORY"
        | "PIXAI_GPU_BUSY"
        | "PIXAI_INFERENCE_FAILED" => 503,
        _ => return Err(invalid()),
    };
    let error = error
        .filter(|s| !s.is_empty() && s.len() <= 4096)
        .ok_or_else(invalid)?;
    Ok(ApiError::new(status, code, error))
}

fn invalid() -> ApiError {
    ApiError::new(
        503,
        "PIXAI_PROTOCOL_ERROR",
        "PixAI 工作进程返回无效数据或通信已断开",
    )
}
