//! Stable Krea style IDs, ordered strengths and resource lookup shared by both image providers.
use super::*;
use std::{fs, path::Path};

mod header;

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Style {
    pub id: String,
    pub strength: f64,
}

fn custom_name(id: &str) -> Option<&str> {
    let name = id.strip_prefix("krea2/")?;
    let (stem, ext) = name.rsplit_once('.')?;
    let base = stem.split('.').next()?.trim_end().to_ascii_uppercase();
    let reserved = matches!(
        base.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ["COM", "LPT"].iter().any(|prefix| {
        base.strip_prefix(prefix).is_some_and(|n| {
            matches!(
                n,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    });
    (ext.eq_ignore_ascii_case("safetensors")
        && !stem.trim_matches([' ', '.']).is_empty()
        && name.encode_utf16().count() <= 255
        && !reserved
        && !name.contains(['/', '\\', ':', '<', '>', '"', '|', '?', '*'])
        && !name.chars().any(char::is_control))
    .then_some(name)
}

pub(super) fn file_name(id: &str) -> Result<&str> {
    catalog::styles()[id]["file"]
        .as_str()
        .or_else(|| custom_name(id).map(|_| id))
        .ok_or_else(|| {
            error(
                "UNKNOWN_STYLE_LORA",
                "请选择已登记或已放入 loras/krea2 的风格 LoRA",
            )
        })
}

fn strength(value: &Value) -> Result<f64> {
    value
        .as_f64()
        .filter(|n| n.is_finite() && (-2.0..=2.0).contains(n))
        .ok_or_else(|| {
            error(
                "INVALID_PARAMETER",
                "Krea 2 风格 LoRA 强度须为 -2 到 2 的数值",
            )
        })
}

pub(super) fn fields(id: Option<&str>, strength: Option<f64>, styles: Option<&[Style]>) -> Value {
    let mut input = json!({});
    if let Some(id) = id {
        input["styleLoraId"] = json!(id);
    }
    if let Some(strength) = strength {
        input["styleLoraStrength"] = json!(strength);
    }
    if let Some(styles) = styles {
        input["styleLoras"] = json!(styles);
    }
    input
}

pub(crate) fn selection(input: &Value, krea: bool) -> Result<Vec<Style>> {
    let legacy = input.get("styleLoraId").filter(|v| !v.is_null());
    let weight = input.get("styleLoraStrength");
    let stack = input.get("styleLoras");
    if !krea && (legacy.is_some() || weight.is_some() || stack.is_some()) {
        return Err(error("WRONG_ROUTE_FAMILY", "风格 LoRA 仅适用于 Krea 2"));
    }
    let first_id = legacy
        .map(|v| {
            v.as_str()
                .ok_or_else(|| error("UNKNOWN_STYLE_LORA", "风格 LoRA ID 需为文本"))
        })
        .transpose()?;
    let first_weight = weight.map(strength).transpose()?;
    if let Some(stack) = stack {
        let rows = stack
            .as_array()
            .filter(|rows| rows.len() <= 2)
            .ok_or_else(|| {
                error(
                    "INVALID_PARAMETER",
                    "styleLoras 必须是包含最多两个风格的数组",
                )
            })?;
        let mut result: Vec<Style> = Vec::with_capacity(rows.len());
        for row in rows {
            let style: Style = serde_json::from_value(row.clone())
                .map_err(|_| error("INVALID_PARAMETER", "每个风格需包含 id 和数值 strength"))?;
            file_name(&style.id)?;
            strength(&row["strength"])?;
            if result
                .iter()
                .any(|used| used.id.eq_ignore_ascii_case(&style.id))
            {
                return Err(error("INVALID_PARAMETER", "同一个风格 LoRA 不能重复叠加"));
            }
            result.push(style);
        }
        if first_id.is_some_and(|id| result.first().is_none_or(|s| id != s.id))
            || first_weight
                .is_some_and(|weight| result.first().is_none_or(|s| weight != s.strength))
        {
            return Err(error(
                "INVALID_PARAMETER",
                "旧版风格 ID 或强度与 styleLoras 首项不一致",
            ));
        }
        return Ok(result);
    }
    if let Some(id) = first_id {
        file_name(id)?;
        return Ok(vec![Style {
            id: id.into(),
            strength: first_weight.unwrap_or(1.0),
        }]);
    }
    if first_weight.is_some() {
        return Err(error("INVALID_PARAMETER", "指定风格强度时需要选择 LoRA"));
    }
    Ok(vec![])
}

pub(super) fn write_selection(input: &mut Value, styles: &[Style]) {
    if let Some(first) = styles.first() {
        input["styleLoraId"] = json!(first.id);
        input["styleLoraStrength"] = json!(first.strength);
        input["styleLoras"] = json!(styles);
    }
}

#[derive(Default)]
struct CustomSidecar {
    label: Option<String>,
    trigger: Option<String>,
    recommended_strength: Option<f64>,
}

fn read_sidecar(root: &Path, id: &str) -> CustomSidecar {
    let Some(name) = custom_name(id) else {
        return CustomSidecar::default();
    };
    let Some((stem, _)) = name.rsplit_once('.') else {
        return CustomSidecar::default();
    };
    let dir = root.join("krea2");
    if !plain(&dir).is_some_and(|m| m.is_dir()) {
        return CustomSidecar::default();
    }
    let path = dir.join(format!("{stem}.json"));
    let Some(meta) = plain(&path).filter(|m| m.is_file() && m.len() <= 16 * 1024) else {
        return CustomSidecar::default();
    };
    let Ok(bytes) = fs::read(&path) else {
        return CustomSidecar::default();
    };
    if bytes.len() as u64 != meta.len() {
        return CustomSidecar::default();
    }
    let Ok(Value::Object(map)) = serde_json::from_slice::<Value>(&bytes) else {
        return CustomSidecar::default();
    };
    let label = map
        .get("label")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.chars().count() <= 120 && !s.chars().any(char::is_control))
        .map(str::to_owned);
    let trigger = map
        .get("trigger")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.encode_utf16().count() <= 500 && !s.chars().any(char::is_control))
        .map(str::to_owned);
    let recommended_strength = map
        .get("recommendedStrength")
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && (-2.0..=2.0).contains(n));
    CustomSidecar {
        label,
        trigger,
        recommended_strength,
    }
}

pub(super) fn trigger_suffix(base: &str, styles: &[Style]) -> Result<Option<String>> {
    trigger_suffix_with_root(base, styles, None)
}

pub(super) fn trigger_suffix_with_root(
    base: &str,
    styles: &[Style],
    root: Option<&Path>,
) -> Result<Option<String>> {
    let mut triggers: Vec<String> = Vec::with_capacity(styles.len());
    let base_lower = base.to_ascii_lowercase();
    for item in styles.iter().filter(|s| s.strength != 0.) {
        let candidate = catalog::styles()[&item.id]["trigger"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .or_else(|| root.and_then(|dir| read_sidecar(dir, &item.id).trigger));
        if let Some(trigger) = candidate {
            let trigger_lower = trigger.to_ascii_lowercase();
            if !triggers
                .iter()
                .any(|seen| seen.eq_ignore_ascii_case(&trigger))
                && !base_lower.contains(&trigger_lower)
            {
                triggers.push(trigger);
            }
        }
    }
    if triggers.is_empty() {
        return Ok(None);
    }
    let suffix = triggers.join(", ");
    if base.trim().encode_utf16().count() + 2 + suffix.encode_utf16().count() > 12000 {
        return Err(error(
            "INVALID_PARAMETER",
            "加入风格触发词后的提示词超过 12000 字符",
        ));
    }
    Ok(Some(suffix))
}

pub(super) fn prompt(base: &str, styles: &[Style]) -> Result<String> {
    prompt_with_root(base, styles, None)
}

pub(super) fn prompt_with_root(
    base: &str,
    styles: &[Style],
    root: Option<&Path>,
) -> Result<String> {
    Ok(match trigger_suffix_with_root(base, styles, root)? {
        Some(trigger) => format!("{}, {trigger}", base.trim()),
        None => base.trim().into(),
    })
}

fn plain(path: &Path) -> Option<fs::Metadata> {
    let meta = fs::symlink_metadata(path).ok()?;
    if meta.file_type().is_symlink() {
        return None;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return None;
        }
    }
    Some(meta)
}

pub(super) fn resolve(root: &Path, id: &str) -> Result<PathBuf> {
    let name = file_name(id)?;
    let resolved = generation::native::resources::file(root, name, true).ok_or_else(unavailable)?;
    if custom_name(id).is_some() {
        let dir = root.join("krea2");
        if !plain(&dir).is_some_and(|m| m.is_dir())
            || !plain(&root.join(name)).is_some_and(|m| m.is_file())
            || resolved.parent() != dir.canonicalize().ok().as_deref()
        {
            return Err(unavailable());
        }
    }
    Ok(resolved)
}

fn unavailable() -> ApiError {
    ApiError::new(
        503,
        "KREA_STYLE_LORA_UNAVAILABLE",
        "风格 LoRA 文件不可用，请核对当前后端的 LoRA 目录",
    )
}

pub(super) fn comfy_files(
    root: &Path,
    checkpoint: &Path,
    styles: &[Style],
) -> Result<Vec<PathBuf>> {
    let targets = header::targets(checkpoint)?;
    let mut files = Vec::with_capacity(styles.len());
    for style in styles {
        let file = resolve(root, &style.id)?;
        header::validate(&file, &targets)?;
        files.push(file);
    }
    Ok(files)
}

pub(crate) fn list(root: &Path) -> Vec<Value> {
    let mut styles: Vec<Value> = catalog::styles().as_object().unwrap().iter().map(|(id, style)| {
        let recommended = style["recommendedStrength"].as_f64().filter(|n| n.is_finite() && (-2.0..=2.0).contains(n)).unwrap_or(1.0);
        json!({"id":id,"label":style["label"],"trigger":style["trigger"],"recommendedStrength":recommended,
            "available":resolve(root,id).is_ok(),"formatValidation":"on-load"})
    }).collect();
    let dir = root.join("krea2");
    if plain(&dir).is_some_and(|m| m.is_dir())
        && let Ok(entries) = fs::read_dir(dir)
    {
        let mut custom = Vec::new();
        for entry in entries.flatten() {
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            let id = format!("krea2/{name}");
            if custom_name(&id).is_some() && resolve(root, &id).is_ok() {
                custom.push((id, name));
            }
        }
        custom.sort_unstable();
        styles.extend(custom.into_iter().map(|(id, name)| {
            let sidecar = read_sidecar(root, &id);
            let fallback_label = name.rsplit_once('.').unwrap().0;
            json!({"id":id,"label":sidecar.label.as_deref().unwrap_or(fallback_label),
            "trigger":sidecar.trigger.as_deref().unwrap_or(""),
            "recommendedStrength":sidecar.recommended_strength.unwrap_or(1.0),
            "available":true,"formatValidation":"on-load"})
        }));
    }
    styles
}
