mod import;
mod scanner;

use super::*;
use axum::{
    Extension, Json, Router,
    extract::Path as RoutePath,
    routing::{delete, get, post},
};
use base64::Engine as _;
use serde::Deserialize;
use std::path::Path;

pub(super) fn routes() -> Router<crate::AppState> {
    Router::new()
        .route("/api/voice/existing-profiles", get(existing))
        .route("/api/voice/setup-status", get(setup_status))
        .route("/api/voice/import-pack", post(import::import_pack))
        .route("/api/voice/profiles/{id}", delete(remove_profile))
        .route("/api/voice/test-api", post(test_api))
}

fn default_display_name(id: &str) -> &str {
    match id {
        "nene" => "绫地宁宁",
        "natsume" => "四季夏目",
        "roxy" => "洛琪希",
        _ => id,
    }
}

fn default_catalog_id(id: &str) -> &str {
    match id {
        "roxy" => "roxy_migurdia",
        _ => "",
    }
}

fn profile_files_status(id: &str, profile: &Value) -> Value {
    let exists = |key: &str| -> Value {
        let raw = profile[key].as_str().unwrap_or("").trim();
        json!({
            "path": raw,
            "present": !raw.is_empty() && Path::new(raw).is_file(),
        })
    };
    let display_name = profile["displayName"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| default_display_name(id));
    let catalog_id = profile["catalogId"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| default_catalog_id(id));
    let emotions: Vec<String> = profile["references"]
        .as_object()
        .map(|refs| {
            refs.iter()
                .filter(|(_, item)| {
                    !item["refAudioPath"].as_str().unwrap_or("").trim().is_empty()
                })
                .map(|(k, _)| k.clone())
                .collect()
        })
        .unwrap_or_default();
    json!({
        "configured": !profile["refAudioPath"].as_str().unwrap_or("").trim().is_empty()
            && !profile["promptText"].as_str().unwrap_or("").trim().is_empty(),
        "displayName": display_name,
        "catalogId": catalog_id,
        "source": profile["source"].as_str().unwrap_or("").trim(),
        "emotions": emotions,
        "gptWeights": exists("gptWeightsPath"),
        "sovitsWeights": exists("sovitsWeightsPath"),
        "loraWeights": exists("loraWeightsPath"),
        "refAudio": exists("refAudioPath"),
        "promptText": profile["promptText"].as_str().unwrap_or("").trim(),
        "promptLang": profile["promptLang"].as_str().unwrap_or("ja"),
    })
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
    if let Some(entries) = value.as_object() {
        for (id, profile) in entries {
            if crate::voice::is_valid_voice_id(id) && profile.is_object() {
                voices.insert(id.clone(), profile.clone());
            }
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

async fn setup_status(Extension(service): Extension<Arc<ControlService>>) -> Result<Json<Value>> {
    let ai_root = service.config.ai_workspace_root.clone();
    let app_root = service.config.app_root.clone();
    let checks = tokio::task::spawn_blocking(move || {
        let packs_path = app_root.join("tools").join("voice").join("managed-voice-packs.json");
        let packs = std::fs::read(&packs_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|doc| doc["packs"].as_array().cloned())
            .unwrap_or_default();
        json!({
            "checks": {
                "gptSovitsDir": ai_root.join("GPT-SoVITS").is_dir(),
                "gptSovitsEnv": ai_root.join("GPT-SoVITS-env").join("python.exe").is_file(),
                "ttsInferConfig": ai_root.join("Voice/config/tts_infer.yaml").is_file(),
                "profilesJson": ai_root.join("Voice/config/profiles.json").is_file(),
                "voxcpmDir": ai_root.join("VoxCPM").is_dir(),
                "translationScript": app_root.join("tools").join("translate-zh-ja.py").is_file(),
            },
            "packs": packs,
        })
    })
    .await
    .map_err(|_| ApiError::new(503, "VOICE_STATUS_FAILED", "语音环境检查失败"))?;
    let saved = service.saved.read().unwrap().clone();
    let mut profiles = serde_json::Map::new();
    for id in ["nene", "natsume"] {
        profiles.insert(id.into(), profile_files_status(id, &saved["voices"][id]));
    }
    if let Some(entries) = saved["voices"].as_object() {
        let mut extra: Vec<_> = entries
            .keys()
            .filter(|id| !matches!(id.as_str(), "nene" | "natsume") && crate::voice::is_valid_voice_id(id))
            .cloned()
            .collect();
        extra.sort();
        for id in extra {
            profiles.insert(id.clone(), profile_files_status(&id, &entries[&id]));
        }
    }
    Ok(Json(json!({
        "ok": true,
        "engineId": service.voice.engine_id(),
        "workspacePath": service.config.ai_workspace_root,
        "ttsApi": super::public_tts_api(&saved),
        "profiles": Value::Object(profiles),
        "checks": checks["checks"],
        "packs": checks["packs"],
    })))
}

async fn remove_profile(
    Extension(service): Extension<Arc<ControlService>>,
    RoutePath(id): RoutePath<String>,
) -> Result<Json<Value>> {
    if !crate::voice::is_valid_voice_id(&id) {
        return Err(ApiError::invalid("无效的声线 ID"));
    }
    let mut merged = service
        .saved
        .read()
        .unwrap()["voices"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let existed = merged.remove(&id).is_some();
    if existed {
        service.patch(json!({ "voices": Value::Object(merged) })).await?;
        service.sync_voice_settings();
    }
    Ok(Json(json!({ "ok": true, "removed": existed })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestApiRequest {
    base_url: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
    voice: Option<String>,
    response_format: Option<String>,
    text: Option<String>,
    #[serde(default)]
    clear_api_key: bool,
}

async fn test_api(
    Extension(service): Extension<Arc<ControlService>>,
    Json(body): Json<TestApiRequest>,
) -> Result<Json<Value>> {
    let saved_api = service.saved.read().unwrap()["ttsApi"].clone();
    let saved_base = saved_api["baseUrl"].as_str().unwrap_or("").trim().trim_end_matches('/').to_owned();
    let base_raw = body.base_url.as_deref().unwrap_or(&saved_base).trim().trim_end_matches('/').to_owned();
    let parsed_base = url::Url::parse(&base_raw)
        .ok()
        .filter(|u| matches!(u.scheme(), "http" | "https") && u.host_str().is_some())
        .ok_or_else(|| ApiError::invalid("请填写有效的 http/https 语音接口地址"))?;
    let saved_origin_matches = url::Url::parse(&saved_base)
        .ok()
        .is_some_and(|u| u.origin() == parsed_base.origin());
    let supplied_key = body.api_key.as_deref().unwrap_or("").trim();
    let api_key = if body.clear_api_key {
        String::new()
    } else if !supplied_key.is_empty() {
        supplied_key.to_owned()
    } else if saved_origin_matches {
        saved_api["apiKey"].as_str().unwrap_or("").trim().to_owned()
    } else {
        String::new()
    };
    let model = body
        .model
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| saved_api["model"].as_str())
        .unwrap_or("")
        .trim()
        .to_owned();
    let voice = body
        .voice
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| saved_api["voiceNene"].as_str().filter(|s| !s.trim().is_empty()))
        .or_else(|| saved_api["defaultVoice"].as_str().filter(|s| !s.trim().is_empty()))
        .unwrap_or("alloy")
        .trim()
        .to_owned();
    let response_format = body
        .response_format
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| saved_api["responseFormat"].as_str())
        .unwrap_or("mp3")
        .trim()
        .to_ascii_lowercase();
    let text = body
        .text
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("你好，这是一段语音接口试听。");
    if text.encode_utf16().count() > 200 {
        return Err(ApiError::invalid("试听文本请控制在 200 字以内"));
    }
    let (bytes, content_type) = service
        .voice
        .test_openai_tts(&base_raw, &api_key, &model, &voice, &response_format, text)
        .await?;
    Ok(Json(json!({
        "ok": true,
        "contentType": content_type,
        "bytes": bytes.len(),
        "audioBase64": base64::engine::general_purpose::STANDARD.encode(&bytes),
    })))
}
