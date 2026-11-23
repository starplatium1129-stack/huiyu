use super::super::{ApiError, ControlService, Result};
use axum::{Extension, Json};
use serde_json::{Value, json};
use std::sync::Arc;

fn validated_tts_api(value: &Value, existing: &Value) -> Result<Value> {
    let Some(obj) = value.as_object() else {
        return Err(ApiError::invalid("ttsApi 必须为对象"));
    };
    let field = |name: &str, max_len: usize| -> Result<String> {
        let raw = match obj.get(name) {
            Some(Value::String(s)) => s.trim(),
            Some(Value::Null) | None => "",
            _ => return Err(ApiError::invalid(format!("ttsApi.{name} 必须为字符串"))),
        };
        if raw.len() > max_len {
            return Err(ApiError::invalid(format!("ttsApi.{name} 长度超出限制")));
        }
        Ok(raw.to_owned())
    };
    let base_raw = field("baseUrl", 512)?;
    let base_url = if base_raw.is_empty() {
        String::new()
    } else {
        let parsed = url::Url::parse(&base_raw)
            .ok()
            .filter(|u| matches!(u.scheme(), "http" | "https") && u.host_str().is_some())
            .ok_or_else(|| ApiError::invalid("语音接口地址必须为有效的 http/https 地址"))?;
        let _ = parsed;
        base_raw.trim_end_matches('/').to_owned()
    };
    let response_format = match field("responseFormat", 16)?.to_ascii_lowercase().as_str() {
        "" | "mp3" => "mp3",
        "wav" => "wav",
        "opus" => "opus",
        "aac" => "aac",
        _ => {
            return Err(ApiError::invalid(
                "不支持的音频格式（仅支持 mp3/wav/opus/aac）",
            ));
        }
    };
    let clear_key = obj.get("clearApiKey").and_then(Value::as_bool) == Some(true);
    let supplied_key = field("apiKey", 512)?;
    let api_key = if clear_key {
        String::new()
    } else if !supplied_key.is_empty() {
        supplied_key
    } else {
        existing["ttsApi"]["apiKey"]
            .as_str()
            .unwrap_or("")
            .trim()
            .to_owned()
    };
    Ok(json!({
        "baseUrl": base_url,
        "apiKey": api_key,
        "model": field("model", 256)?,
        "voiceNene": field("voiceNene", 256)?,
        "voiceNatsume": field("voiceNatsume", 256)?,
        "defaultVoice": field("defaultVoice", 256)?,
        "responseFormat": response_format,
    }))
}

fn validated_patch(body: Value, existing: &Value) -> Result<Value> {
    let Value::Object(object) = body else {
        return Err(ApiError::invalid("配置必须为对象"));
    };
    let mut result = serde_json::Map::new();
    for (key, value) in object {
        let value = match key.as_str() {
            "sdHost" | "comfyHost" | "ttsHost" | "ollamaHost" => {
                let raw = value
                    .as_str()
                    .ok_or_else(|| ApiError::invalid("服务地址必须为字符串"))?;
                let url = crate::upstream::local_url(raw)
                    .map_err(|_| ApiError::invalid("服务地址只接受本机 HTTP"))?;
                Value::String(url.origin().ascii_serialization())
            }
            "voices" if value.is_object() => value,
            "ttsApi" => validated_tts_api(&value, existing)?,
            "ttsEngine"
                if matches!(
                    value.as_str(),
                    Some(
                        "off"
                            | "system"
                            | "openai-tts"
                            | "voxcpm2"
                            | "gpt-sovits"
                            | "gpt-sovits-native"
                    )
                ) =>
            {
                value
            }
            "autoStartVoice" if value.is_boolean() => value,
            _ => return Err(ApiError::invalid(format!("不支持的配置字段或类型：{key}"))),
        };
        result.insert(key, value);
    }
    Ok(Value::Object(result))
}
pub(super) async fn config(
    Extension(s): Extension<Arc<ControlService>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>> {
    let was_native = s.voice.native_selected();
    let patch = {
        let saved = s.saved.read().unwrap();
        validated_patch(body, &saved)?
    };
    let voice_changed = patch.get("ttsEngine").is_some()
        || patch.get("voices").is_some()
        || patch.get("ttsApi").is_some()
        || patch.get("ttsHost").is_some();
    s.patch(patch).await?;
    if voice_changed {
        s.sync_voice_settings();
        if was_native && !s.voice.native_selected() {
            let _ = s.voice.retire_native().await;
        }
    }
    let mut value = s.config_view();
    value["ok"] = json!(true);
    Ok(Json(value))
}
pub(super) async fn preference(
    Extension(s): Extension<Arc<ControlService>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>> {
    let enabled = body["autoStartVoice"]
        .as_bool()
        .ok_or_else(|| ApiError::invalid("autoStartVoice 必须为布尔值"))?;
    s.patch(json!({"autoStartVoice":enabled})).await?;
    Ok(Json(json!({"ok":true,"autoStartVoice":enabled})))
}
