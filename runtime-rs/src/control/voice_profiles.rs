use super::*;
use axum::{Extension, Json, Router, routing::get};

pub(super) fn routes() -> Router<crate::AppState> {
    Router::new().route("/api/voice/existing-profiles", get(existing))
}

async fn existing(Extension(service): Extension<Arc<ControlService>>) -> Result<Json<Value>> {
    let path = service
        .config
        .ai_workspace_root
        .join("Voice/config/profiles.json");
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|_| ApiError::new(404, "VOICE_PROFILES_MISSING", "没有找到已有角色声线配置"))?;
    if !metadata.is_file() || metadata.len() > 512 * 1024 {
        return Err(ApiError::invalid("已有角色声线配置无效"));
    }
    let bytes = tokio::fs::read(path).await?;
    if bytes.len() > 512 * 1024 {
        return Err(ApiError::invalid("已有角色声线配置过大"));
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| ApiError::invalid("已有角色声线配置无法读取"))?;
    let mut voices = serde_json::Map::new();
    for id in ["nene", "natsume"] {
        if let Some(profile) = value.get(id).filter(|profile| profile.is_object()) {
            voices.insert(id.into(), profile.clone());
        }
    }
    if voices.is_empty() {
        return Err(ApiError::new(
            404,
            "VOICE_PROFILES_MISSING",
            "没有找到已有角色声线配置",
        ));
    }
    Ok(Json(json!({"ok":true,"voices":voices})))
}
