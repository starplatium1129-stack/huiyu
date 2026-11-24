use super::*;
use std::{collections::HashSet, fs, process::Stdio};

#[derive(Deserialize)]
struct Weight {
    path: String,
    source: Option<String>,
    bytes: u64,
    sha256: String,
    #[serde(default)]
    optional: bool,
}
impl Weight {
    fn source_name(&self) -> &str {
        self.source.as_deref().unwrap_or(&self.path)
    }
}

pub(super) struct VideoImport {
    script: &'static str,
    weights: Vec<Weight>,
    outputs: Vec<String>,
    pub required_bytes: u64,
}
impl VideoImport {
    pub(super) fn download_bytes(&self, model: &ModelBundle) -> u64 {
        if model.id != "minimax-h3" {
            return 0;
        }
        // The H3 importer fetches each unique config once and links duplicates.
        let mut seen = HashSet::new();
        model
            .files
            .iter()
            .filter(|file| self.outputs.contains(&file.path) && seen.insert(&file.sha256))
            .map(|file| file.bytes)
            .sum()
    }
}

fn video(id: &str) -> Option<&'static VideoImport> {
    static WAN: LazyLock<VideoImport> = LazyLock::new(|| {
        let recipe: Value = serde_json::from_str(include_str!(
            "../../../../tools/inference/wan22-import.json"
        ))
        .expect("bundled Wan import recipe");
        let outputs = Vec::<Weight>::deserialize(&recipe["convertedFiles"])
            .expect("bundled Wan converted file list")
            .into_iter()
            .map(|file| file.path)
            .collect();
        VideoImport {
            script: "import_wan.py",
            weights: recipe["sources"]
                .as_object()
                .unwrap()
                .values()
                .map(|record| Weight::deserialize(record).expect("bundled Wan checkpoint"))
                .collect(),
            outputs,
            required_bytes: 25_000_000_000,
        }
    });
    static H3: LazyLock<VideoImport> = LazyLock::new(|| {
        let pack = &crate::generation::native::adapters::model("minimax-h3").unwrap()["localPack"];
        VideoImport {
            script: "import_h3.py",
            weights: Vec::deserialize(&pack["files"]).expect("bundled H3 checkpoints"),
            outputs: Vec::deserialize(&pack["configs"]).expect("bundled H3 configuration"),
            // Both paths are under the same ordinary workspace directory.
            required_bytes: 128 * 1024 * 1024,
        }
    });
    match id {
        "wan2.2-ti2v-5b" => Some(&WAN),
        "minimax-h3" => Some(&H3),
        _ => None,
    }
}

fn same_size(path: &Path, bytes: u64) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file() && meta.len() == bytes)
}

pub(super) fn available(workspace: &Path, id: &str) -> Option<&'static VideoImport> {
    let import = video(id)?;
    let root = workspace.join("ComfyUI/models");
    import
        .weights
        .iter()
        .filter(|weight| !weight.optional)
        .all(|weight| {
            let path = root.join(weight.source_name());
            plan::safe_directory(path.parent().unwrap()).is_ok() && same_size(&path, weight.bytes)
        })
        .then_some(import)
}

/// Legacy Krea conversions record the size and hash of each published shard in
/// its component, instead of the official download's revision and split sizes.
pub(super) fn krea_receipt(root: &Path, receipt: &Value) -> bool {
    receipt["schemaVersion"] == 1
        && ["transformer", "text_encoder", "vae"].iter().all(|&name| {
            let component = &receipt["components"][name];
            let Some(files) = component["files"]
                .as_object()
                .filter(|files| !files.is_empty())
            else {
                return false;
            };
            let Ok(entries) = fs::read_dir(root.join(name)) else {
                return false;
            };
            let mut count = 0;
            for entry in entries {
                let Ok(entry) = entry else { return false };
                let filename = entry.file_name();
                let Some(filename) = filename.to_str() else {
                    return false;
                };
                if !filename.ends_with(".safetensors") {
                    continue;
                }
                let Some(record) = files.get(filename) else {
                    return false;
                };
                let Some(bytes) = record["bytes"].as_u64().filter(|bytes| *bytes > 0) else {
                    return false;
                };
                if !record["sha256"].as_str().is_some_and(|hash| {
                    hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())
                }) || !same_size(&entry.path(), bytes)
                {
                    return false;
                }
                count += 1;
            }
            component["sourceBytes"]
                .as_u64()
                .is_some_and(|bytes| bytes > 0)
                && component["source"]
                    .as_str()
                    .is_some_and(|file| file.ends_with(".safetensors"))
                && count == files.len()
        })
}

pub(super) fn video_receipt(root: &Path, id: &str, receipt: &mut Value) -> bool {
    let Some(import) = video(id) else {
        return false;
    };
    let Ok(sources) = anima_models::parse_outputs(receipt["sources"].take()) else {
        return false;
    };
    let Ok(files) = anima_models::parse_outputs(receipt["files"].take()) else {
        return false;
    };
    let Some(verified) = fs::metadata(root.join("huiyu-model.json"))
        .and_then(|m| m.modified())
        .ok()
    else {
        return false;
    };
    let mut paths = HashSet::new();
    let mut source_names = HashSet::new();
    receipt["schemaVersion"] == 1
        && sources.iter().all(|source| {
            source_names.insert(&source.path)
                && import
                    .weights
                    .iter()
                    .any(|weight| weight.source_name() == source.path)
        })
        && import.weights.iter().all(|weight| {
            let source = sources.iter().find(|s| s.path == weight.source_name());
            let Some(source) = source else {
                return weight.optional && !files.iter().any(|file| file.path == weight.path);
            };
            source.bytes == weight.bytes
                && source.sha256 == weight.sha256
                && (weight.source.is_none()
                    || files.iter().any(|file| {
                        file.path == weight.path
                            && file.sha256 == source.sha256
                            && file.bytes == source.bytes
                    }))
        })
        && import
            .outputs
            .iter()
            .all(|name| files.iter().any(|file| &file.path == name))
        && files.iter().all(|file| {
            let path = root.join(&file.path);
            paths.insert(&file.path)
                && plan::safe_directory(path.parent().unwrap()).is_ok()
                && fs::symlink_metadata(path).is_ok_and(|meta| {
                    meta.is_file()
                        && meta.len() == file.bytes
                        && meta.modified().is_ok_and(|modified| modified <= verified)
                })
        })
}

pub(super) fn selected(view: &Value, requested: bool) -> Result<Option<&'static VideoImport>> {
    if view["localVideoImport"] == true {
        return Ok(view["id"].as_str().and_then(video));
    }
    if requested && view["installed"] != true {
        return Err(ApiError::new(
            409,
            "LOCAL_VIDEO_MODEL_CHANGED",
            "本机视频模型或运行环境已改变，请重新检查准备清单",
        ));
    }
    Ok(None)
}

impl ControlService {
    pub(super) async fn import_local_video(
        &self,
        import: &VideoImport,
        model: &ModelBundle,
        target: &Path,
        operation: &Value,
        cancel: &CancellationToken,
        permit: &Arc<OwnedSemaphorePermit>,
    ) -> Result<()> {
        let workspace = &self.config.ai_workspace_root;
        let staging = workspace.join("inference/.staging");
        let models = target.parent().unwrap();
        plan::safe_directory(&staging)?;
        plan::safe_directory(models)?;
        if fs::symlink_metadata(target).is_ok() {
            return Err(ApiError::new(
                409,
                "MODEL_CONFLICT",
                "原生模型目录已有文件，请先核对现有目录",
            ));
        }
        flow::require_space(
            Some(plan::safe_workspace(workspace, &self.config.app_root)?),
            import.required_bytes,
        )?;
        let runtime = image_models::runtime_for(Some(&model.id))?;
        let settings = image_models::settings(self, &runtime)?;
        fs::create_dir_all(&staging)?;
        let temporary = Arc::new(
            tempfile::Builder::new()
                .prefix("video-import-")
                .tempdir_in(staging)?,
        );
        let output = temporary.path().join(&model.id);
        self.native_stage(operation, 1);
        self.native_progress(operation, json!({"stage":"converting","phase":"converting","message":"正在将本机视频权重导入原生引擎"}));
        let script = self
            .config
            .app_root
            .join("tools/inference")
            .join(import.script);
        let mut command = crate::native_python::command(&settings.python, &script);
        if model.id == "minimax-h3" {
            command.arg("--discover-dwd");
        }
        command
            .arg("--comfy-models")
            .arg(workspace.join("ComfyUI/models"))
            .arg("--models-root")
            .arg(temporary.path())
            .arg("--apply")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let value = self
            .run_setup_helper(
                &mut command,
                cancel,
                3600,
                permit.clone(),
                Some(temporary.clone()),
                Some(operation),
            )
            .await?;
        self.native_stage(operation, 2);
        if value["preparedModel"] != model.id || !receipt_matches(&output, model) {
            return Err(ApiError::new(
                409,
                "NATIVE_CONVERSION_INCOMPLETE",
                "转换输出与原生模型清单不匹配，请核对本机权重",
            ));
        }
        stopped(cancel)?;
        fs::create_dir_all(models)?;
        if fs::symlink_metadata(target).is_ok() {
            return Err(ApiError::new(
                409,
                "MODEL_CONFLICT",
                "目标模型目录已出现，请重新检查",
            ));
        }
        fs::rename(output, target)?;
        self.native_stage(operation, 3);
        self.native_progress(
            operation,
            json!({"result":{"modelId":model.id,"path":target,"verified":true}}),
        );
        Ok(())
    }
}
