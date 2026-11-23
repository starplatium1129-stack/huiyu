use super::*;
use axum::{
    Extension, Json, Router,
    extract::Path as RoutePath,
    routing::{delete, get, post},
};
use base64::Engine as _;
use serde::Deserialize;
use std::path::{Path, PathBuf};

pub(super) fn routes() -> Router<crate::AppState> {
    Router::new()
        .route("/api/voice/existing-profiles", get(existing))
        .route("/api/voice/setup-status", get(setup_status))
        .route("/api/voice/import-pack", post(import_pack))
        .route("/api/voice/profiles/{id}", delete(remove_profile))
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportPackRequest {
    folder_path: String,
    character_id: Option<String>,
    display_name: Option<String>,
    catalog_id: Option<String>,
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

fn sanitize_voice_id(raw: &str) -> Option<String> {
    let mut out = String::new();
    let mut prev_sep = false;
    for ch in raw.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_sep = false;
        } else if matches!(ch, '_' | '-' | '.' | ' ') && !out.is_empty() && !prev_sep {
            out.push('_');
            prev_sep = true;
        }
    }
    while out.ends_with('_') {
        out.pop();
    }
    if out.len() > 64 {
        out.truncate(64);
    }
    crate::voice::is_valid_voice_id(&out).then_some(out)
}

fn read_prompt_line(path: &Path) -> String {
    std::fs::metadata(path)
        .ok()
        .filter(|m| m.is_file() && m.len() <= 16 * 1024)
        .and_then(|_| std::fs::read_to_string(path).ok())
        .map(|s| s.lines().next().unwrap_or("").trim().to_owned())
        .unwrap_or_default()
}

fn find_prompt_for_audio(audio_path: &Path, txts: &[PathBuf]) -> String {
    let Some(stem) = audio_path.file_stem() else {
        return String::new();
    };
    txts.iter()
        .find(|p| p.file_stem() == Some(stem))
        .map(|p| read_prompt_line(p))
        .filter(|s| !s.is_empty())
        .unwrap_or_default()
}

fn match_emotion_key(stem_lower: &str) -> Option<&'static str> {
    for emotion in ["neutral", "gentle", "happy", "shy", "serious", "sad"] {
        if stem_lower == emotion
            || stem_lower.ends_with(&format!("-{emotion}"))
            || stem_lower.ends_with(&format!("_{emotion}"))
        {
            return Some(emotion);
        }
    }
    None
}

fn scan_character_dir(dir: &Path) -> (Option<Value>, Vec<String>, Vec<String>) {
    let mut queue = vec![(dir.to_path_buf(), 0usize)];
    let mut seen_files = 0usize;
    let mut ckpt = None::<PathBuf>;
    let mut pth = None::<PathBuf>;
    let mut lora = None::<PathBuf>;
    let mut audios = Vec::<PathBuf>::new();
    let mut txts = Vec::<PathBuf>::new();
    let mut detected = Vec::new();
    let mut warnings = Vec::new();
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
                "wav" | "flac" | "mp3" => {
                    detected.push(path.to_string_lossy().into_owned());
                    audios.push(path);
                }
                "txt" | "lab" => txts.push(path),
                _ => {}
            }
        }
    }
    let primary_audio = audios
        .iter()
        .find(|p| {
            p.file_stem()
                .and_then(|s| s.to_str())
                .map(|s| s.to_ascii_lowercase())
                .is_some_and(|stem| match_emotion_key(&stem) == Some("neutral"))
        })
        .or_else(|| audios.first())
        .cloned();
    let prompt_text = primary_audio
        .as_ref()
        .map(|audio_path| {
            let exact = find_prompt_for_audio(audio_path, &txts);
            if !exact.is_empty() {
                return exact;
            }
            txts.iter()
                .find(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.eq_ignore_ascii_case("prompt.txt"))
                })
                .or_else(|| txts.first())
                .map(|p| read_prompt_line(p))
                .unwrap_or_default()
        })
        .unwrap_or_default();
    if ckpt.is_none() && pth.is_none() && lora.is_none() && primary_audio.is_none() {
        return (None, detected, warnings);
    }
    if primary_audio.is_some() && prompt_text.is_empty() {
        warnings.push("未找到与参考音频同名的 .txt / .lab 或 prompt.txt 台词文本，导入后请补全参考台词".into());
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
    if let Some(p) = primary_audio {
        profile.insert("refAudioPath".into(), json!(p.to_string_lossy()));
    }
    if !prompt_text.is_empty() {
        profile.insert("promptText".into(), json!(prompt_text));
        profile.insert("promptLang".into(), json!("ja"));
    }
    let mut emotion_refs = serde_json::Map::new();
    for audio_path in &audios {
        let Some(stem) = audio_path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase())
        else {
            continue;
        };
        let Some(emotion) = match_emotion_key(&stem) else {
            continue;
        };
        if emotion == "neutral" || emotion_refs.contains_key(emotion) {
            continue;
        }
        let line = find_prompt_for_audio(audio_path, &txts);
        if line.is_empty() {
            continue;
        }
        emotion_refs.insert(
            emotion.into(),
            json!({
                "refAudioPath": audio_path.to_string_lossy(),
                "promptText": line,
                "promptLang": "ja",
            }),
        );
    }
    if !emotion_refs.is_empty() {
        profile.insert("references".into(), Value::Object(emotion_refs));
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
    let requested_char = match body.character_id.as_deref().map(str::trim) {
        None | Some("") | Some("auto") => None,
        Some(id) if crate::voice::is_valid_voice_id(id) => Some(id.to_owned()),
        _ => return Err(ApiError::invalid("声线 ID 请使用小写字母、数字、下划线或连字符")),
    };
    let display_name = body
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.chars().count() <= 40)
        .map(str::to_owned);
    let catalog_id = body
        .catalog_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && crate::voice::is_valid_voice_id(s))
        .map(str::to_owned);
    let folder = PathBuf::from(raw);
    if !folder.is_absolute() {
        return Err(ApiError::invalid("请提供绝对路径的本地文件夹"));
    }
    let target_char = requested_char.clone();
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
                if let Some(entries) = value.as_object() {
                    for (id, p) in entries {
                        if let Some(target) = target_char.as_deref()
                            && id != target
                        {
                            continue;
                        }
                        if crate::voice::is_valid_voice_id(id) && p.is_object() {
                            voices.insert(id.clone(), resolve_profile_paths(base, p));
                        }
                    }
                }
                if !voices.is_empty() {
                    detected.push(manifest.to_string_lossy().into_owned());
                    return Ok((Value::Object(voices), detected, warnings));
                }
            }
        }
        let mut voices = serde_json::Map::new();
        if target_char.is_none() {
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
        }
        if voices.is_empty() {
            let (profile, files, warn) = scan_character_dir(&folder);
            detected.extend(files);
            warnings.extend(warn);
            if let Some(p) = profile {
                let id = target_char
                    .clone()
                    .or_else(|| {
                        folder
                            .file_name()
                            .and_then(|s| s.to_str())
                            .and_then(sanitize_voice_id)
                    })
                    .unwrap_or_else(|| "custom_voice".to_owned());
                voices.insert(id, p);
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
    let (mut voices, detected_files, warnings) = scanned;
    if let Some(map) = voices.as_object_mut()
        && map.len() == 1
        && let Some((_, profile)) = map.iter_mut().next()
        && let Some(obj) = profile.as_object_mut()
    {
        if let Some(name) = display_name {
            obj.insert("displayName".into(), Value::String(name));
        }
        if let Some(cid) = catalog_id {
            obj.insert("catalogId".into(), Value::String(cid));
        }
    }
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
