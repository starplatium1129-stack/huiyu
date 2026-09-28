use super::{
    Error, Result,
    context::{Options, VERSIONED_FILES},
    fs, journal,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
};

#[derive(Clone)]
pub(crate) struct Source {
    pub file: String,
    pub entry: Value,
    pub scenes: Vec<Value>,
}
#[derive(Clone)]
pub(super) struct State {
    pub value: Value,
    pub manifest: Value,
    pub sources: Vec<Source>,
    pub retired: HashSet<String>,
}
pub(super) fn scene_number(id: &str) -> Option<u64> {
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
fn sources(root: &Path) -> Result<Vec<PathBuf>> {
    fn visit(path: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
        if fs::safe(path, true, true)?.is_none() {
            return Ok(());
        }
        for entry in std::fs::read_dir(path)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                visit(&entry.path(), out)?;
            } else if entry.file_name().to_string_lossy().ends_with(".json") {
                fs::safe(&entry.path(), false, false)?;
                out.push(entry.path());
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    for name in ["scenes", "blueprints", "popular"] {
        visit(&root.join("data").join(name), &mut files)?;
    }
    files.sort_by(|a, b| {
        a.to_string_lossy()
            .encode_utf16()
            .cmp(b.to_string_lossy().encode_utf16())
    });
    Ok(files)
}
pub(super) fn version(root: &Path) -> Result<u64> {
    let mut files = Vec::new();
    for name in VERSIONED_FILES {
        for suffix in ["", ".gz", ".br"] {
            files.push(root.join("data").join(format!("{name}{suffix}")));
        }
    }
    for name in ["retired-scenes.json", "prompt-pinned-scenes.json"] {
        files.push(root.join("data").join(name));
    }
    files.push(root.join("src/stores/sceneStore.ts"));
    files.extend(sources(root)?);
    let mut hash = Sha256::new();
    for file in files {
        let bytes = fs::read(&file, true)?;
        let relative = file
            .strip_prefix(root)
            .map_err(|_| Error::path("版本文件越界"))?
            .to_string_lossy();
        // Node path.relative emits the platform separator even when a source
        // path was constructed from a slash-containing segment.
        #[cfg(windows)]
        let relative = relative.replace('/', "\\");
        hash.update(
            crate::storage::stringify(&json!([relative, bytes.as_ref().map(Vec::len)])).as_bytes(),
        );
        if let Some(bytes) = bytes {
            hash.update(bytes);
        }
    }
    Ok(u64::from_str_radix(&hex::encode(hash.finalize())[..12], 16).unwrap())
}
fn invalid(message: impl Into<String>) -> Error {
    Error::new(500, "SCENE_SOURCE_INVALID", message)
}
pub(crate) fn load_scenes(root: &Path) -> Result<(Value, Vec<Source>, Vec<Value>)> {
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
    let mut loaded = Vec::new();
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
            loaded.push(Source {
                file,
                entry: entry.clone(),
                scenes: items.clone(),
            });
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
    Ok((manifest, loaded, scenes))
}
fn blueprints(root: &Path) -> Result<Value> {
    let mut value = fs::json(&root.join("data/scene-blueprints.json"))?;
    let directory = root.join("data/blueprints");
    if fs::safe(&directory.join("manifest.json"), false, true)?.is_some() {
        let manifest = fs::json(&directory.join("manifest.json"))?;
        let entries = manifest["files"]
            .as_array()
            .filter(|entries| !entries.is_empty())
            .ok_or_else(|| invalid("蓝图 manifest.files 无效"))?;
        let mut all = Vec::new();
        for entry in entries {
            let name = entry["file"]
                .as_str()
                .filter(|name| super::context::safe_name(name) && *name != "manifest.json")
                .ok_or_else(|| invalid("蓝图分片路径无效"))?;
            let shard = fs::json(&directory.join(name))?;
            all.extend(
                shard["blueprints"]
                    .as_array()
                    .ok_or_else(|| invalid("蓝图分片必须含 blueprints 数组"))?
                    .iter()
                    .cloned(),
            );
        }
        value = all.into();
    } else if !value.is_array() {
        value = value["blueprints"].clone();
    }
    if !value.is_array() {
        return Err(invalid("蓝图快照无效"));
    }
    Ok(value)
}
pub(super) fn read(options: &Options) -> Result<State> {
    let token = journal::read_token(options)?;
    let value = read_owned(options)?;
    journal::assert_token(options, &token)?;
    Ok(value)
}
// The caller must hold the unforgeable transaction while invoking this variant.
pub(super) fn read_transaction(
    options: &Options,
    transaction: &super::transaction::Transaction,
) -> Result<State> {
    transaction.assert_owned()?;
    let value = read_owned(options)?;
    transaction.assert_owned()?;
    Ok(value)
}
fn read_owned(options: &Options) -> Result<State> {
    let initial = version(&options.root)?;
    let (manifest, sources, scenes) = load_scenes(&options.root)?;
    let mut retired = HashSet::new();
    let retired_file = options.root.join("data/retired-scenes.json");
    if fs::safe(&retired_file, false, true)?.is_some() {
        let data = fs::json(&retired_file)?;
        for entry in data["records"]
            .as_array()
            .ok_or_else(|| invalid("retired-scenes.json 格式无效"))?
        {
            retired.insert(
                entry["id"]
                    .as_str()
                    .filter(|id| !id.trim().is_empty())
                    .ok_or_else(|| invalid("retired 场景 ID 无效"))?
                    .to_owned(),
            );
        }
    }
    let tags = fs::json(&options.root.join("data/tags.json"))?;
    let curation = fs::json(&options.root.join("data/curation.json"))?;
    let blueprints = blueprints(&options.root)?;
    if initial != version(&options.root)? {
        return Err(invalid("读取期间内容发生变化，请重新读取"));
    }
    let mut highest = 0;
    for id in scenes
        .iter()
        .map(|scene| scene["id"].as_str().unwrap())
        .chain(retired.iter().map(String::as_str))
    {
        highest = highest.max(
            scene_number(id)
                .ok_or_else(|| invalid(format!("现有场景编号不规范，停止分配：{id}")))?,
        );
    }
    let next = if highest == 9_007_199_254_740_991 {
        None
    } else {
        Some(format!("sc{:03}", highest + 1))
    };
    let value = json!({"version":initial,"snapshot":{"scenes":scenes,"tags":tags,"curation":curation,"blueprints":blueprints},"nextSceneId":next,"sceneCount":scenes.len(),"retiredCount":retired.len()});
    Ok(State {
        value,
        manifest,
        sources,
        retired,
    })
}
pub(super) fn scene_plan(state: &State, incoming: &[Value]) -> Result<()> {
    let previous = state
        .sources
        .iter()
        .flat_map(|source| {
            source
                .scenes
                .iter()
                .map(move |scene| (scene["id"].as_str().unwrap(), (&source.entry, scene)))
        })
        .collect::<HashMap<_, _>>();
    let entries = state.manifest["files"].as_array().unwrap();
    for scene in incoming {
        let id = scene["id"].as_str().unwrap();
        let original = previous.get(id);
        let needs_group = original.is_none_or(|(entry, old)| {
            crate::storage::stringify(old) != crate::storage::stringify(scene)
                && !entry["character"].is_null()
                && entry["character"] != ""
                && scene["char"] != entry["character"]
        });
        if !needs_group {
            continue;
        }
        let group = match scene["char"].as_str() {
            Some("triad") => "shared.json".to_owned(),
            Some(character @ ("nene" | "natsume")) => format!(
                "{character}-{}.json",
                if scene["category"]
                    .as_str()
                    .unwrap_or("")
                    .to_lowercase()
                    .contains("after_story")
                {
                    "after-story"
                } else {
                    "core"
                }
            ),
            _ => {
                return Err(Error::invalid(format!(
                    "{id}: cannot choose shard for char"
                )));
            }
        };
        if !entries.iter().any(|entry| entry["file"] == group) {
            return Err(Error::invalid(format!(
                "manifest does not declare a shard for scene {id}"
            )));
        }
    }
    Ok(())
}
