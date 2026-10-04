use super::{Error, Result, fs};
use serde_json::Value;
use std::{collections::HashSet, path::Path};
pub(crate) fn scene_number(id: &str) -> Option<u64> {
    let digits = id.strip_prefix("sc")?;
    if !(digits.len() == 3 || (digits.len() > 3 && !digits.starts_with('0')))
        || !digits.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    digits
        .parse::<u64>()
        .ok()
        .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991)
}
fn invalid(message: impl Into<String>) -> Error {
    Error::new(500, "SCENE_SOURCE_INVALID", message)
}
pub(crate) fn load_scenes(root: &Path) -> Result<(Value, Vec<Value>)> {
    let directory = root.join("data/scenes");
    let manifest = fs::json(&directory.join("manifest.json"))?;
    let entries = manifest["files"]
        .as_array()
        .filter(|entries| !entries.is_empty())
        .ok_or_else(|| invalid("manifest.json 必须声明非空 files 数组"))?;
    let mut declared = HashSet::new();
    for entry in entries {
        let file = entry["file"]
            .as_str()
            .ok_or_else(|| invalid("manifest 分片文件名无效"))?;
        let base = file
            .strip_suffix(".json")
            .filter(|name| !name.is_empty())
            .ok_or_else(|| invalid("manifest 分片文件名无效"))?;
        if file == "manifest.json"
            || !base
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
            || !declared.insert(file.to_owned())
        {
            return Err(invalid("manifest 分片文件名无效或重复"));
        }
    }
    let names = std::fs::read_dir(&directory)?
        .map(|entry| entry.map(|entry| entry.file_name().to_string_lossy().into_owned()))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut scenes = Vec::new();
    let mut ids = HashSet::new();
    let mut accepted = HashSet::from(["manifest.json".to_owned()]);
    for entry in entries {
        let file = entry["file"].as_str().unwrap();
        let base = file.trim_end_matches(".json");
        let prefix = format!("{base}.");
        let mut batches = Vec::new();
        for name in &names {
            if let Some(digits) = name
                .strip_prefix(&prefix)
                .and_then(|tail| tail.strip_suffix(".json"))
                && !digits.is_empty()
                && digits.bytes().all(|b| b.is_ascii_digit())
            {
                let number = digits
                    .parse::<u64>()
                    .ok()
                    .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991)
                    .ok_or_else(|| invalid("非规范批次编号"))?;
                if digits.starts_with('0') {
                    return Err(invalid("非规范批次编号"));
                }
                batches.push((number, name.clone()));
            }
        }
        batches.sort_by_key(|entry| entry.0);
        let group = if batches.is_empty() {
            if !names.iter().any(|name| name == file) {
                return Err(invalid(format!("manifest 声明的 {file} 不存在")));
            }
            vec![file.to_owned()]
        } else {
            if names.iter().any(|name| name == file) {
                return Err(invalid("单文件与批次文件并存"));
            }
            for (index, (number, _)) in batches.iter().enumerate() {
                if *number != index as u64 + 1 {
                    return Err(invalid("批次缺号且其后仍有分片"));
                }
            }
            batches.into_iter().map(|(_, name)| name).collect()
        };
        for file in group {
            accepted.insert(file.clone());
            let value = fs::json(&directory.join(&file))?;
            let items = value
                .as_array()
                .ok_or_else(|| invalid(format!("{file}: 根必须是数组")))?;
            for scene in items {
                let id = scene["id"]
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| invalid("存在缺少 id 的场景"))?;
                if !ids.insert(id.to_owned()) {
                    return Err(invalid(format!("场景 ID 重复：{id}")));
                }
                if !scene["char"].is_null()
                    && scene["char"] != ""
                    && !entry["character"].is_null()
                    && entry["character"] != ""
                    && scene["char"] != entry["character"]
                {
                    return Err(invalid(format!(
                        "{id} 的 char 与 manifest character 不一致"
                    )));
                }
            }
            scenes.extend(items.iter().cloned());
        }
    }
    if names
        .iter()
        .any(|name| name.ends_with(".json") && !accepted.contains(name))
    {
        return Err(invalid("存在未登记或不规范场景分片"));
    }
    scenes.sort_by_key(|scene| {
        scene["id"]
            .as_str()
            .and_then(scene_number)
            .unwrap_or(9_007_199_254_740_991)
    });
    Ok((manifest, scenes))
}
