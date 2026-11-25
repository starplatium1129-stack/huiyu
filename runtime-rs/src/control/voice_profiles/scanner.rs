use serde_json::{Value, json};
use std::path::{Path, PathBuf};

pub(super) fn is_link(path: &Path) -> bool {
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

pub(super) fn resolve_profile_paths(base: &Path, profile: &Value) -> Value {
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
                obj.insert(
                    "refAudioPath".into(),
                    Value::String(resolve_entry_path(base, raw)),
                );
            }
        }
    }
    Value::Object(map)
}

pub(super) fn sanitize_voice_id(raw: &str) -> Option<String> {
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

pub(super) fn scan_character_dir(dir: &Path) -> (Option<Value>, Vec<String>, Vec<String>) {
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
