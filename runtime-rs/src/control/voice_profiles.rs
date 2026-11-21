use super::*;
use axum::{
    Extension, Json, Router,
    routing::{get, post},
};
use base64::Engine as _;
use serde::Deserialize;
use std::path::{Path, PathBuf};

pub(super) fn routes() -> Router<crate::AppState> {
    Router::new()
        .route("/api/voice/existing-profiles", get(existing))
        .route("/api/voice/setup-status", get(setup_status))
        .route("/api/voice/import-pack", post(import_pack))
        .route("/api/voice/test-api", post(test_api))
}

fn is_link(path: &Path) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    false
}

fn profile_files_status(profile: &Value) -> Value {
    let exists = |key: &str| -> Value {
        let raw = profile[key].as_str().unwrap_or("").trim();
        json!({
            "path": raw,
            "present": !raw.is_empty() && Path::new(raw).is_file(),
        })
    };
    json!({
        "configured": !profile["refAudioPath"].as_str().unwrap_or("").trim().is_empty()
            && !profile["promptText"].as_str().unwrap_or("").trim().is_empty(),
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
    let profiles = json!({
        "nene": profile_files_status(&saved["voices"]["nene"]),
        "natsume": profile_files_status(&saved["voices"]["natsume"]),
    });
    Ok(Json(json!({
        "ok": true,
        "engineId": service.voice.engine_id(),
        "workspacePath": service.config.ai_workspace_root,
        "ttsApi": super::public_tts_api(&saved),
        "profiles": profiles,
        "checks": checks["checks"],
        "packs": checks["packs"],
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportPackRequest {
    folder_path: String,
    character_id: Option<String>,
    #[serde(default)]
    apply: bool,
}

fn resolve_entry_path(base: &Path, raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let path = Path::new(trimmed);
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    };
    crate::file_paths::absolute(&candidate)
        .unwrap_or(candidate)
        .to_string_lossy()
        .into_owned()
}

fn resolve_profile_paths(base: &Path, profile: &Value) -> Value {
    let mut map = profile.as_object().cloned().unwrap_or_default();
    for key in [
        "refAudioPath",
        "gptWeightsPath",
        "sovitsWeightsPath",
        "loraWeightsPath",
    ] {
        if let Some(raw) = map.get(key).and_then(Value::as_str) {
            map.insert(key.into(), Value::String(resolve_entry_path(base, raw)));
        }
    }
    if let Some(refs) = map.get_mut("references").and_then(Value::as_object_mut) {
        for item in refs.values_mut() {
            if let Some(obj) = item.as_object_mut()
                && let Some(raw) = obj.get("refAudioPath").and_then(Value::as_str)
            {
                obj.insert("refAudioPath".into(), Value::String(resolve_entry_path(base, raw)));
            }
        }
    }
    Value::Object(map)
}

fn scan_character_dir(dir: &Path) -> (Option<Value>, Vec<String>, Vec<String>) {
    let mut queue = vec![(dir.to_path_buf(), 0usize)];
    let mut seen_files = 0usize;
    let mut ckpt = None::<PathBuf>;
    let mut pth = None::<PathBuf>;
    let mut lora = None::<PathBuf>;
    let mut audio = None::<PathBuf>;
    let mut txts = Vec::<PathBuf>::new();
    let mut detected = Vec::<String>::new();
    let mut warnings = Vec::<String>::new();
    while let Some((current, depth)) = queue.pop() {
        if depth > 3 || seen_files >= 256 || is_link(&current) {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&current) else {
            continue;
        };
        let mut sorted: Vec<_> = entries.flatten().collect();
        sorted.sort_by_key(|entry| entry.file_name());
        for entry in sorted {
            let path = entry.path();
            if is_link(&path) {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                if depth < 3 {
                    queue.push((path, depth + 1));
                }
                continue;
            }
            if !kind.is_file() {
                continue;
            }
            seen_files += 1;
            if seen_files > 256 {
                warnings.push("目录文件过多，已仅扫描前 256 项".into());
                break;
            }
            let ext = path
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s.to_ascii_lowercase())
                .unwrap_or_default();
            let name_lower = path
                .file_name()
                .and_then(|s| s.to_str())
                .map(|s| s.to_ascii_lowercase())
                .unwrap_or_default();
            match ext.as_str() {
                "ckpt" if ckpt.is_none() => {
                    detected.push(path.to_string_lossy().into_owned());
                    ckpt = Some(path);
                }
                "pth" if pth.is_none() => {
                    detected.push(path.to_string_lossy().into_owned());
                    pth = Some(path);
                }
                "safetensors" if name_lower.contains("lora") && lora.is_none() => {
                    detected.push(path.to_string_lossy().into_owned());
                    lora = Some(path);
                }
                "wav" | "flac" | "mp3" if audio.is_none() => {
                    detected.push(path.to_string_lossy().into_owned());
                    audio = Some(path);
                }
                "txt" => txts.push(path),
                _ => {}
            }
        }
    }
    let prompt_path = audio.as_ref().and_then(|audio_path| {
        let stem = audio_path.file_stem()?.to_os_string();
        txts.iter()
            .find(|p| p.file_stem() == Some(stem.as_os_str()))
            .cloned()
            .or_else(|| {
                txts.iter()
                    .find(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.eq_ignore_ascii_case("prompt.txt")))
                    .cloned()
            })
            .or_else(|| txts.first().cloned())
    });
    let prompt_text = prompt_path
        .and_then(|p| {
            std::fs::metadata(&p)
                .ok()
                .filter(|m| m.is_file() && m.len() <= 16 * 1024)?;
            std::fs::read_to_string(p).ok()
        })
        .map(|s| s.lines().next().unwrap_or("").trim().to_owned())
        .unwrap_or_default();
    if ckpt.is_none() && pth.is_none() && lora.is_none() && audio.is_none() {
        return (None, detected, warnings);
    }
    if audio.is_some() && prompt_text.is_empty() {
        warnings.push("未找到与参考音频同名的 .txt 或 prompt.txt 台词文本，导入后请补全参考台词".into());
    }
    let mut profile = serde_json::Map::new();
    if let Some(p) = ckpt {
        profile.insert("gptWeightsPath".into(), json!(p.to_string_lossy()));
    }
    if let Some(p) = pth {
        profile.insert("sovitsWeightsPath".into(), json!(p.to_string_lossy()));
    }
    if let Some(p) = lora {
        profile.insert("loraWeightsPath".into(), json!(p.to_string_lossy()));
    }
    if let Some(p) = audio {
        profile.insert("refAudioPath".into(), json!(p.to_string_lossy()));
    }
    if !prompt_text.is_empty() {
        profile.insert("promptText".into(), json!(prompt_text));
        profile.insert("promptLang".into(), json!("ja"));
    }
    (Some(Value::Object(profile)), detected, warnings)
}

async fn import_pack(
    Extension(service): Extension<Arc<ControlService>>,
    Json(body): Json<ImportPackRequest>,
) -> Result<Json<Value>> {
    let raw = body.folder_path.trim();
    if raw.is_empty() {
        return Err(ApiError::invalid("请选择或填写语音包文件夹路径"));
    }
    let target_char = match body.character_id.as_deref() {
        None | Some("") | Some("nene") => "nene".to_owned(),
        Some("natsume") => "natsume".to_owned(),
        _ => return Err(ApiError::invalid("仅支持导入绫地宁宁（nene）或四季夏目（natsume）声线")),
    };
    let folder = PathBuf::from(raw);
    if !folder.is_absolute() {
        return Err(ApiError::invalid("请提供绝对路径的本地文件夹"));
    }
    let scanned = tokio::task::spawn_blocking(move || -> Result<(Value, Vec<String>, Vec<String>)> {
        if is_link(&folder) || !folder.is_dir() {
            return Err(ApiError::invalid("所选目录不存在或不是普通文件夹"));
        }
        let folder = crate::file_paths::absolute(&folder).unwrap_or(folder);
        let mut warnings = Vec::new();
        let mut detected = Vec::new();
        for rel in ["profiles.json", "Voice/config/profiles.json"] {
            let manifest = folder.join(rel);
            if !is_link(&manifest)
                && std::fs::metadata(&manifest).is_ok_and(|m| m.is_file() && m.len() <= 512 * 1024)
            {
                let value: Value = serde_json::from_slice(&std::fs::read(&manifest)?)
                    .map_err(|_| ApiError::invalid("目录中的 profiles.json 无法解析"))?;
                let base = manifest.parent().unwrap_or(&folder);
                let mut voices = serde_json::Map::new();
                for id in ["nene", "natsume"] {
                    if let Some(p) = value.get(id).filter(|v| v.is_object()) {
                        voices.insert(id.into(), resolve_profile_paths(base, p));
                    }
                }
                if !voices.is_empty() {
                    detected.push(manifest.to_string_lossy().into_owned());
                    return Ok((Value::Object(voices), detected, warnings));
                }
            }
        }
        let mut voices = serde_json::Map::new();
        for (id, aliases) in [("nene", &["nene", "宁宁"][..]), ("natsume", &["natsume", "夏目"][..])] {
            for alias in aliases {
                let sub = folder.join(alias);
                if sub.is_dir() && !is_link(&sub) {
                    let (profile, files, warn) = scan_character_dir(&sub);
                    detected.extend(files);
                    warnings.extend(warn);
                    if let Some(p) = profile {
                        voices.insert(id.into(), p);
                        break;
                    }
                }
            }
        }
        if voices.is_empty() {
            let (profile, files, warn) = scan_character_dir(&folder);
            detected.extend(files);
            warnings.extend(warn);
            if let Some(p) = profile {
                voices.insert(target_char, p);
            }
        }
        if voices.is_empty() {
            return Err(ApiError::new(
                404,
                "VOICE_PACK_EMPTY",
                "未在该目录中找到可识别的模型权重（.ckpt / .pth）或参考音频（.wav / .mp3 / .flac）",
            ));
        }
        Ok((Value::Object(voices), detected, warnings))
    })
    .await
    .map_err(|_| ApiError::new(503, "VOICE_IMPORT_FAILED", "语音包扫描失败"))??;
    let (voices, detected_files, warnings) = scanned;
    let mut applied = false;
    if body.apply {
        let mut merged = service
            .saved
            .read()
            .unwrap()["voices"]
            .as_object()
            .cloned()
            .unwrap_or_default();
        if let Some(new_map) = voices.as_object() {
            for (k, v) in new_map {
                let mut current = merged
                    .get(k)
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                if let Some(fields) = v.as_object() {
                    for (fk, fv) in fields {
                        current.insert(fk.clone(), fv.clone());
                    }
                }
                merged.insert(k.clone(), Value::Object(current));
            }
        }
        service.patch(json!({ "voices": Value::Object(merged) })).await?;
        service.sync_voice_settings();
        applied = true;
    }
    Ok(Json(json!({
        "ok": true,
        "voices": voices,
        "detectedFiles": detected_files,
        "warnings": warnings,
        "applied": applied,
    })))
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
