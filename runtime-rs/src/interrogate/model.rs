use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    time::SystemTime,
};

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Model {
    pub path: PathBuf,
    pub csv: PathBuf,
    pub name: String,
    pub bytes: u64,
    pub modified: Option<SystemTime>,
    pub csv_bytes: u64,
    pub csv_modified: Option<SystemTime>,
}
pub(super) fn find(directories: &[PathBuf]) -> Option<Model> {
    for directory in directories {
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        let mut files: Vec<_> = entries
            .flatten()
            .filter(|entry| {
                entry
                    .path()
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("onnx"))
            })
            .collect();
        files.sort_by_key(|entry| entry.file_name());
        for entry in files {
            let path = entry.path();
            let Some(name) = path
                .file_stem()
                .and_then(|name| name.to_str())
                .map(str::to_owned)
            else {
                continue;
            };
            let csv = directory.join(format!("{name}.csv"));
            let (Ok(meta), Ok(labels)) = (fs::metadata(&path), fs::metadata(&csv)) else {
                continue;
            };
            if meta.is_file() && labels.is_file() {
                return Some(Model {
                    path,
                    csv,
                    name,
                    bytes: meta.len(),
                    modified: meta.modified().ok(),
                    csv_bytes: labels.len(),
                    csv_modified: labels.modified().ok(),
                });
            }
        }
    }
    None
}
pub(super) struct Labels {
    pub names: Vec<String>,
    pub general: usize,
    pub characters: usize,
}
pub(super) fn labels(path: &Path) -> std::result::Result<Labels, String> {
    if fs::metadata(path)
        .map_err(|_| "Tag table unavailable")?
        .len()
        > 16 * 1024 * 1024
    {
        return Err("Tag table exceeds size limit".into());
    }
    let text = fs::read_to_string(path).map_err(|_| "Tag table is not UTF-8")?;
    let mut names = Vec::new();
    let (mut general, mut characters) = (None, None);
    // WD14's existing selected_tags.csv contract uses unquoted tag/category
    // columns. Preserve row order and category boundaries used by the Node code.
    for (index, line) in text.lines().enumerate() {
        let line = line.trim_matches(|ch: char| ch.is_whitespace() || ch == '\u{feff}');
        if line.is_empty() || index == 0 && line.starts_with("tag_id") {
            continue;
        }
        let parts: Vec<_> = line.split(',').collect();
        if parts.len() < 3 {
            continue;
        }
        if general.is_none() && parts[2] == "0" {
            general = Some(names.len());
        } else if characters.is_none() && parts[2] == "4" {
            characters = Some(names.len());
        }
        names.push(parts[1].into());
    }
    if names.len() < 4 || names[..4] != ["general", "sensitive", "questionable", "explicit"] {
        return Err("WD14 rating rows are invalid".into());
    }
    let general = general.unwrap_or(names.len());
    let characters = characters.unwrap_or(names.len());
    if general > characters {
        return Err("WD14 category boundaries are invalid".into());
    }
    Ok(Labels {
        names,
        general,
        characters,
    })
}
pub(super) fn output(
    model: &Model,
    labels: &Labels,
    probs: &[f32],
    threshold: f64,
    ms: u128,
) -> std::result::Result<Value, String> {
    if probs.len() != labels.names.len()
        || probs
            .iter()
            .any(|prob| !prob.is_finite() || !(0.0..=1.0).contains(prob))
    {
        return Err("WD14 output does not match its tag table".into());
    }
    let mut general: Vec<_> = (labels.general..labels.characters)
        .filter(|index| f64::from(probs[*index]) > threshold)
        .collect();
    general.sort_by(|a, b| probs[*b].total_cmp(&probs[*a]));
    general.truncate(100);
    let characters: Vec<_> = (labels.characters..labels.names.len())
        .filter(|index| f64::from(probs[*index]) > 0.85)
        .map(|index| labels.names[index].clone())
        .collect();
    let round = |value: f32| (f64::from(value) * 10000.0).round() / 10000.0;
    let mut scores = serde_json::Map::new();
    let mut rating = serde_json::Map::new();
    for index in &general {
        scores.insert(labels.names[*index].clone(), json!(round(probs[*index])));
    }
    for (index, name) in ["general", "sensitive", "questionable", "explicit"]
        .iter()
        .enumerate()
    {
        rating.insert((*name).into(), json!(round(probs[index])));
    }
    let tags: Vec<_> = general
        .iter()
        .map(|index| labels.names[*index].clone())
        .collect();
    Ok(
        json!({"model":model.name,"tags":tags,"characterTags":characters,"scores":scores,"rating":rating,
        "meta":{"threshold":threshold,"characterThreshold":0.85,"topN":100,"modelPath":model.path,"modelBytes":model.bytes,"modelDir":model.path.parent(),"count":tags.len(),"ms":ms}}),
    )
}
