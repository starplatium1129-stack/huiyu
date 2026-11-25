use super::scanner::{is_link, resolve_profile_paths, sanitize_voice_id, scan_character_dir};
use super::super::*;
use axum::{Extension, Json};
use serde::Deserialize;
use std::path::PathBuf;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ImportPackRequest {
    folder_path: String,
    character_id: Option<String>,
    display_name: Option<String>,
    catalog_id: Option<String>,
    #[serde(default)]
    apply: bool,
}

pub(super) async fn import_pack(
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
            for (id, aliases) in [
                ("nene", &["nene", "宁宁"][..]),
                ("natsume", &["natsume", "夏目"][..]),
            ] {
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
        service
            .patch(json!({ "voices": Value::Object(merged) }))
            .await?;
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
