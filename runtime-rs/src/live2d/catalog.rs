use super::manifest::{self, identity, invalid, model_file, no_links, read_json};
use crate::error::{ApiError, Result};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

pub(super) struct Model {
    pub id: String,
    pub directory: PathBuf,
    pub files: HashSet<String>,
    pub receipt: Option<Value>,
}
pub(super) struct Snapshot {
    pub status: Value,
    pub models: Vec<Model>,
}
#[derive(Default)]
pub(super) struct Catalog {
    cached: Mutex<Option<(Instant, Arc<Snapshot>)>>,
}
impl Catalog {
    pub fn clear(&self) {
        self.cached.lock().unwrap().take();
    }
    pub fn cached(&self) -> Option<Arc<Snapshot>> {
        let cache = self.cached.try_lock().ok()?;
        cache
            .as_ref()
            .filter(|(at, _)| at.elapsed() < Duration::from_secs(4))
            .map(|(_, snapshot)| snapshot.clone())
    }
    pub fn read(
        &self,
        builtins: &Path,
        local: &Path,
        cancel: &tokio_util::sync::CancellationToken,
    ) -> Result<Arc<Snapshot>> {
        self.read_selected(builtins, Some(local), cancel)
    }
    pub fn read_builtin(
        &self,
        builtins: &Path,
        cancel: &tokio_util::sync::CancellationToken,
    ) -> Result<Arc<Snapshot>> {
        self.read_selected(builtins, None, cancel)
    }
    fn read_selected(
        &self,
        builtins: &Path,
        local: Option<&Path>,
        cancel: &tokio_util::sync::CancellationToken,
    ) -> Result<Arc<Snapshot>> {
        let mut cache = self.cached.lock().unwrap();
        super::editor::check_cancel(cancel)?;
        if let Some((at, value)) = &*cache
            && at.elapsed() < Duration::from_secs(4)
        {
            return Ok(value.clone());
        }
        let value = scan(builtins, local, Some(cancel))
            .ok_or_else(|| ApiError::new(499, "CANCELLED", "Live2D operation cancelled"))?;
        super::editor::check_cancel(cancel)?;
        let value = Arc::new(value);
        *cache = Some((Instant::now(), value.clone()));
        Ok(value)
    }
}
fn inspect_builtin(
    directory: &Path,
    manifest: &str,
    cancel: Option<&tokio_util::sync::CancellationToken>,
) -> Result<(Vec<String>, Vec<String>)> {
    let model = read_json(&model_file(directory, manifest)?)?;
    let mut files = manifest::references(model)?;
    let mut missing = Vec::new();
    for file in &files {
        if let Some(cancel) = cancel {
            super::editor::check_cancel(cancel)?;
        }
        if model_file(directory, file).is_err() {
            missing.push(file.clone());
        }
    }
    files.push(manifest.to_owned());
    Ok((files, missing))
}

// A boolean capability probe uses the same complete model inspections as the
// catalog, but stops at the first enabled model and builds no catalog JSON.
// It does not take the catalog mutex or authorize any resource access.
pub(super) fn available(
    builtins: &Path,
    local: &Path,
    cancel: &tokio_util::sync::CancellationToken,
) -> Option<bool> {
    for id in ["nene", "natsume"] {
        if cancel.is_cancelled() {
            return None;
        }
        if inspect_builtin(
            &builtins.join(id),
            &format!("{id}.model3.json"),
            Some(cancel),
        )
        .is_ok_and(|(_, missing)| missing.is_empty())
        {
            return (!cancel.is_cancelled()).then_some(true);
        }
    }
    if no_links(local).is_ok()
        && let Ok(entries) = fs::read_dir(local)
    {
        for entry in entries.flatten() {
            if cancel.is_cancelled() {
                return None;
            }
            let id = entry.file_name().to_string_lossy().into_owned();
            if !identity(&id) || !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            if let Ok(model) = local_model_checked(local, &id, Some(cancel))
                && model.receipt.as_ref().unwrap()["disabled"] != true
            {
                return (!cancel.is_cancelled()).then_some(true);
            }
        }
    }
    (!cancel.is_cancelled()).then_some(false)
}

pub(super) fn scan(
    builtins: &Path,
    local: Option<&Path>,
    cancel: Option<&tokio_util::sync::CancellationToken>,
) -> Option<Snapshot> {
    let mut status = json!({"available": false, "characters": [], "models": {}});
    let mut models = Vec::new();
    let mut characters = Vec::new();
    for id in ["nene", "natsume"] {
        if cancel.is_some_and(|cancel| cancel.is_cancelled()) {
            return None;
        }
        let directory = builtins.join(id);
        let manifest = format!("{id}.model3.json");
        let inspection = inspect_builtin(&directory, &manifest, cancel);
        let inspected = match inspection {
            Ok((files, missing)) if missing.is_empty() => {
                models.push(Model {
                    id: id.into(),
                    directory: directory.clone(),
                    files: files.into_iter().collect(),
                    receipt: None,
                });
                characters.push(id.to_owned());
                json!({"available":true, "modelUrl":format!("/assets/live2d-current/{id}/{manifest}"), "source":"project-local", "missing":[], "canvas":{"width":420,"height":610}})
            }
            Ok((_, missing)) => {
                json!({"available":false,"modelUrl":"","source":"incomplete-model","missing":missing,"canvas":{"width":420,"height":610}})
            }
            Err(_) if !directory.join(&manifest).is_file() => {
                json!({"available":false,"modelUrl":"","source":"missing","missing":[]})
            }
            Err(_) => {
                json!({"available":false,"modelUrl":"","source":"invalid-manifest","missing":[manifest]})
            }
        };
        status["models"][id] = inspected;
    }
    if let Some(local) = local.filter(|local| no_links(local).is_ok())
        && let Ok(entries) = fs::read_dir(local)
    {
        for entry in entries.flatten() {
            if cancel.is_some_and(|cancel| cancel.is_cancelled()) {
                return None;
            }
            let id = entry.file_name().to_string_lossy().into_owned();
            if !identity(&id) || !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            if let Ok(model) = local_model_checked(local, &id, cancel) {
                let receipt = model.receipt.as_ref().unwrap();
                if receipt["disabled"] == true {
                    continue;
                }
                status["models"][&id] = json!({"available":true,"modelUrl":receipt["avatar"]["modelPath"],"source":"local-import","missing":[]});
                characters.push(id);
                models.push(model);
            }
        }
    }
    status["available"] = json!(!characters.is_empty());
    status["characters"] = json!(characters);
    if cancel.is_some_and(|cancel| cancel.is_cancelled()) {
        return None;
    }
    Some(Snapshot { status, models })
}
pub(super) fn receipt(root: &Path, id: &str) -> Result<(PathBuf, Value, Vec<u8>)> {
    if !identity(id) {
        return Err(invalid("Invalid companion ID"));
    }
    let directory = root.join(id);
    no_links(&directory)?;
    let file = model_file(&directory, "companion.json")?;
    if fs::metadata(&file)?.len() > 4 * 1024 * 1024 {
        return Err(invalid("Import receipt exceeds 4 MiB"));
    }
    let bytes = fs::read(file)?;
    let receipt: Value = serde_json::from_slice(&bytes)?;
    let expected = receipt["manifest"]
        .as_str()
        .ok_or_else(|| invalid("Missing model manifest"))?;
    if receipt["character"]["id"] != id
        || !receipt["character"]["personaPrompt"].is_string()
        || !receipt["avatar"]["id"]
            .as_str()
            .is_some_and(|id| !id.is_empty())
        || !receipt["profile"]["profileId"]
            .as_str()
            .is_some_and(|id| !id.is_empty())
        || !receipt["files"].is_array()
        || receipt["avatar"]["characterId"] != id
        || receipt["character"]["defaultAvatarId"] != receipt["avatar"]["id"]
        || receipt["avatar"]["profileId"] != receipt["profile"]["profileId"]
        || receipt["profile"]["avatarId"] != receipt["avatar"]["id"]
        || receipt["avatar"]["modelPath"] != format!("/api/live2d-local/{id}/{expected}")
    {
        return Err(invalid("Invalid import receipt identity"));
    }
    Ok((directory, receipt, bytes))
}
fn local_model_checked(
    root: &Path,
    id: &str,
    cancel: Option<&tokio_util::sync::CancellationToken>,
) -> Result<Model> {
    let (directory, receipt, _) = receipt(root, id)?;
    let manifest = receipt["manifest"].as_str().unwrap().to_owned();
    let model = read_json(&model_file(&directory, &manifest)?)?;
    let files = receipt["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| {
            if let Some(cancel) = cancel {
                super::editor::check_cancel(cancel)?;
            }
            let path = value
                .as_str()
                .ok_or_else(|| invalid("Invalid receipt file list"))?;
            manifest::relative(path)?;
            model_file(&directory, path)?;
            Ok(path.to_owned())
        })
        .collect::<Result<HashSet<_>>>()?;
    if !files.contains(manifest.as_str()) {
        return Err(invalid("Receipt does not include its manifest"));
    }
    for reference in manifest::references(model)? {
        if let Some(cancel) = cancel {
            super::editor::check_cancel(cancel)?;
        }
        if !files.contains(reference.as_str()) {
            return Err(invalid("Model dependency is outside its receipt"));
        }
        model_file(&directory, &reference)?;
    }
    Ok(Model {
        id: id.into(),
        directory,
        files,
        receipt: Some(receipt),
    })
}
