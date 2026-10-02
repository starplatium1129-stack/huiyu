use super::{
    editor::{self, EditorLock},
    manifest::{self, identity, invalid, model_file, no_links, relative},
    profile, upload_checks,
};
use crate::error::{ApiError, Result};
use axum::extract::Multipart;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

struct UploadDirectory(Option<tempfile::TempDir>);
impl UploadDirectory {
    fn published(&mut self) {
        if let Some(directory) = self.0.take() {
            let _ = directory.keep();
        }
    }
}
impl Drop for UploadDirectory {
    fn drop(&mut self) {
        let Some(directory) = self.0.take() else {
            return;
        };
        let path = directory.keep();
        let cleanup = move || {
            // Best-effort cleanup of this request's staging directory only.
            // Skip ancestry currently containing links; this is not an atomic
            // identity guard against external replacement. Never sweep old uploads.
            if no_links(&path).is_ok() {
                let _ = fs::remove_dir_all(path);
            }
        };
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn_blocking(cleanup);
        } else {
            cleanup();
        }
    }
}

pub(super) struct Upload {
    metadata: Value,
    paths: Vec<String>,
    directory: PathBuf,
    count: usize,
    cleanup: UploadDirectory,
}
pub(super) async fn receive(
    root: &Path,
    mut form: Multipart,
    cancel: &CancellationToken,
) -> Result<Upload> {
    no_links(root)?;
    tokio::fs::create_dir_all(root).await?;
    let owned = tempfile::Builder::new()
        .prefix(".editor-upload-")
        .tempdir_in(root)?;
    let directory = owned.path().to_owned();
    let cleanup = UploadDirectory(Some(owned));
    let (mut metadata, mut paths) = (None, None);
    let (mut count, mut total) = (0, 0usize);
    while let Some(mut field) = tokio::select! { field = form.next_field() => field.map_err(|_| invalid("Invalid multipart model files"))?, _ = cancel.cancelled() => return Err(ApiError::new(499,"CANCELLED","Model import cancelled")) }
    {
        let name = field.name().unwrap_or("").to_owned();
        if name == "files" {
            if count >= 512 || field.file_name().is_none() {
                return Err(invalid("Invalid model file"));
            }
            let mut output = tokio::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(directory.join(format!(".upload-{count}")))
                .await?;
            let mut length = 0usize;
            while let Some(chunk) = tokio::select! { chunk = field.chunk() => chunk.map_err(|_| invalid("Invalid model upload"))?, _ = cancel.cancelled() => return Err(ApiError::new(499,"CANCELLED","Model import cancelled")) }
            {
                length += chunk.len();
                total += chunk.len();
                if length > 64 * 1024 * 1024 || total > 256 * 1024 * 1024 {
                    return Err(ApiError::new(
                        413,
                        "LIVE2D_TOO_LARGE",
                        "Model upload exceeds size limit",
                    ));
                }
                output.write_all(&chunk).await?;
            }
            if length == 0 {
                return Err(invalid("Empty model file"));
            }
            output.sync_all().await?;
            count += 1;
        } else if name == "metadata" || name == "paths" {
            let mut bytes = Vec::new();
            while let Some(chunk) = field
                .chunk()
                .await
                .map_err(|_| invalid("Invalid upload metadata"))?
            {
                if bytes.len() + chunk.len() > 512 * 1024 {
                    return Err(invalid("Upload metadata exceeds limit"));
                }
                bytes.extend_from_slice(&chunk);
            }
            let value: Value = serde_json::from_slice(&bytes)?;
            let target = if name == "metadata" {
                &mut metadata
            } else {
                &mut paths
            };
            if target.replace(value).is_some() {
                return Err(invalid("Duplicate upload metadata"));
            }
        } else {
            return Err(invalid("Unknown model upload field"));
        }
    }
    let metadata = metadata
        .filter(Value::is_object)
        .ok_or_else(|| invalid("Invalid import metadata"))?;
    let paths: Vec<String> =
        serde_json::from_value(paths.ok_or_else(|| invalid("Missing upload paths"))?)?;
    if paths.len() != count || count < 3 {
        return Err(invalid("Invalid upload manifest"));
    }
    Ok(Upload {
        metadata,
        paths,
        directory,
        count,
        cleanup,
    })
}

pub(super) fn publish(
    root: &Path,
    mut upload: Upload,
    cancel: &CancellationToken,
) -> Result<Value> {
    let _lock = EditorLock::acquire(root)?;
    let meta = &upload.metadata;
    let id = meta["id"]
        .as_str()
        .filter(|id| identity(id))
        .ok_or_else(|| invalid("Invalid companion ID"))?;
    let target = root.join(id);
    if target.exists() {
        return Err(ApiError::new(
            409,
            "LIVE2D_EXISTS",
            "Companion ID already exists",
        ));
    }
    for name in ["name", "persona", "author", "terms"] {
        if !meta[name].as_str().is_some_and(|text| {
            !text.trim().is_empty()
                && text.encode_utf16().count() <= if name == "persona" { 12000 } else { 2000 }
        }) {
            return Err(invalid(format!("Invalid {name}")));
        }
    }
    let mut names = HashSet::new();
    for name in &upload.paths {
        relative(name)?;
        let lower = name.to_lowercase();
        let extension = lower.rsplit_once('.').map(|(_, ext)| ext).unwrap_or("");
        if ![
            "json", "moc3", "png", "jpg", "jpeg", "webp", "wav", "mp3", "ogg",
        ]
        .contains(&extension)
        {
            return Err(invalid("Unsupported model file type"));
        }
        if !names.insert(lower.clone()) || lower.rsplit('/').next() == Some("companion.json") {
            return Err(invalid("Duplicate or reserved model file"));
        }
    }
    let entry = relative(
        meta["entryPath"]
            .as_str()
            .ok_or_else(|| invalid("Missing entry path"))?,
    )?;
    if !entry.to_ascii_lowercase().ends_with(".model3.json")
        || !names.contains(&entry.to_lowercase())
    {
        return Err(invalid("Choose a Cubism3 model manifest"));
    }
    let profile = profile::validate(&meta["profile"], false)?;
    if ["avatar-nene-default", "avatar-natsume-default"]
        .iter()
        .any(|id| profile["avatarId"] == *id)
        || ["profile-nene-v1", "profile-natsume-v1"]
            .iter()
            .any(|id| profile["profileId"] == *id)
    {
        return Err(invalid("Avatar or profile ID already registered"));
    }
    for item in fs::read_dir(root)? {
        let item = item?;
        let name = item.file_name().to_string_lossy().into_owned();
        if !item.file_type()?.is_dir() || name.starts_with('.') {
            continue;
        }
        let prior = manifest::read_json(&model_file(&item.path(), "companion.json")?)?;
        if prior["avatar"]["id"] == profile["avatarId"]
            || prior["profile"]["profileId"] == profile["profileId"]
        {
            return Err(invalid("Avatar or profile ID already registered"));
        }
    }
    for index in 0..upload.count {
        editor::check_cancel(cancel)?;
        let destination = upload.directory.join(&upload.paths[index]);
        fs::create_dir_all(destination.parent().unwrap())?;
        fs::rename(
            upload.directory.join(format!(".upload-{index}")),
            destination,
        )?;
    }
    let json_files = upload_checks::inspect(&upload.directory, &upload.paths, cancel)?;
    let mut model = json_files
        .get(entry)
        .filter(|value| value["Version"] == 3)
        .cloned()
        .ok_or_else(|| invalid("Only Cubism3 Version 3 is supported"))?;
    upload_checks::references(&model, entry, &upload.paths.iter().cloned().collect())?;
    model.as_object_mut().unwrap().remove("Controllers");
    model.as_object_mut().unwrap().remove("Options");
    let prefix = entry
        .rsplit_once('/')
        .map(|(prefix, _)| format!("{prefix}/"))
        .unwrap_or_default();
    let mut files = Vec::new();
    let mut seen = HashSet::new();
    manifest::map_references(&mut model, |reference| {
        let path = format!("{prefix}{reference}");
        relative(&path)?;
        model_file(&upload.directory, &path)?;
        if seen.insert(path.clone()) {
            files.push(path.clone());
        }
        Ok(path)
    })?;
    let manifest = format!("imported-{}.model3.json", uuid::Uuid::new_v4());
    let mut manifest_file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(upload.directory.join(&manifest))?;
    manifest_file.write_all(&serde_json::to_vec(&model)?)?;
    manifest_file.sync_all()?;
    drop(manifest_file);
    files.push(manifest.clone());
    let expressions: Vec<Value> = model["FileReferences"]["Expressions"].as_array().into_iter().flatten().map(|expression| {
        let data = manifest::read_json(&model_file(&upload.directory, expression["File"].as_str().ok_or_else(|| invalid("Invalid expression file"))?)?)?;
        let parameters: Vec<Value> = data["Parameters"].as_array().into_iter().flatten().filter_map(|parameter| parameter["Id"].as_str().filter(|id| !id.is_empty()).map(Value::from)).collect();
        Ok(json!({"id":expression["Name"],"label":expression["Name"],"parameterIds":parameters}))
    }).collect::<Result<_>>()?;
    let character = json!({"id":id,"name":meta["name"],"shortName":meta["name"],"defaultAvatarId":profile["avatarId"],"personaPrompt":meta["persona"],"tags":["local-import"],
        "presentation":{"id":id,"name":meta["name"],"image":"","caption":format!("{} · {}",meta["author"].as_str().unwrap(),meta["terms"].as_str().unwrap()),"description":"本机导入模型","icon":"character","greeting":"你好，今天想聊些什么？","roomCode":"LOCAL · LIVE2D","roomMood":"一起聊聊今天的生活与灵感","starters":["聊聊今天吧"],"voice":"","accent":"var(--accent)","live2dLayout":{"scale":1,"anchorX":0.5,"bottomOffset":0}}});
    let avatar = json!({"id":profile["avatarId"],"characterId":id,"name":"本机模型","modelPath":format!("/api/live2d-local/{id}/{manifest}"),"version":"1.0.0","profileId":profile["profileId"],"defaultOutfitId":"default","outfits":[{"id":"default","label":"原版服装"}],"expressions":expressions,"license":{"author":meta["author"],"terms":meta["terms"]}});
    let mut hashes = serde_json::Map::new();
    for file in &files {
        hashes.insert(
            file.clone(),
            json!(editor::hash_file(
                &model_file(&upload.directory, file)?,
                cancel
            )?),
        );
    }
    let receipt = json!({"character":character,"avatar":avatar,"profile":profile,"manifest":manifest,"entryPath":entry,"files":files,"format":"cubism3","hashes":hashes});
    editor::save_receipt(&upload.directory, &receipt)?;
    editor::check_cancel(cancel)?;
    fs::rename(&upload.directory, &target)?;
    upload.cleanup.published();
    editor::get(root, id, cancel)
}
