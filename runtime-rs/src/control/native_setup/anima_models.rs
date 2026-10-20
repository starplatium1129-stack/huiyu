//! The recommended checkpoint uses the existing, strict local Anima converter.
use super::*;
use super::super::{setup::RECOMMENDED_MODEL, setup_verify::{self, ModelFile}};
use std::process::Stdio;

pub(super) fn bundle(base: &ModelBundle) -> Result<ModelBundle> {
    let source = setup_verify::model_source(RECOMMENDED_MODEL)?;
    let mut files = Vec::<Artifact>::new();
    for (id, path) in [(RECOMMENDED_MODEL, "checkpoint.safetensors"),
        ("qwen-encoder", "text_encoder.safetensors"), ("qwen-vae", "vae.safetensors")] {
        let value = setup_verify::model_source(id)?;
        let url = value["sourceUrl"].as_str().map(str::to_owned).unwrap_or_else(|| format!(
            "https://huggingface.co/{}/resolve/{}/{}", value["repo"].as_str().unwrap(),
            value["revision"].as_str().unwrap(), value["remotePath"].as_str().unwrap()));
        files.push(serde_json::from_value(json!({"path":path,"url":url,
            "bytes":value["bytes"],"sha256":value["sha256"]}))?);
    }
    files.extend(base.files.iter().filter(|file| {
        file.path == "LICENSE.md" || file.path == "transformer/config.json"
            || file.path.starts_with("tokenizer/") || file.path.starts_with("t5_tokenizer/")
    }).cloned());
    let download_bytes = files.iter().map(|file| file.bytes).sum::<u64>();
    Ok(ModelBundle {
        id: RECOMMENDED_MODEL.into(), label: format!("{} · 推荐", source["label"].as_str().unwrap()),
        revision: format!("{}-{}-convert-v1", source["revision"].as_str().unwrap(), base.revision),
        license: base.license.clone(), license_url: source["licenseUrl"].as_str().unwrap().into(),
        source_url: source["modelCardUrl"].as_str().unwrap().into(),
        required_bytes: download_bytes.saturating_add(base.required_bytes), files,
        requires_access: false, conversion_profile: Some("anima-cosmos2b-v041".into()),
    })
}

pub(super) fn input_root(target: &Path, model: &ModelBundle) -> PathBuf {
    if model.conversion_profile.is_none() { return target.to_owned(); }
    target.parent().unwrap().parent().unwrap().join(".downloads/models")
        .join(format!("{}-{}", model.id, model.revision))
}

pub(super) fn output_files(root: &Path) -> Result<Vec<ModelFile>> {
    let path = root.join("huiyu-model.json");
    if std::fs::metadata(&path)?.len() > 65536 {
        return Err(ApiError::invalid("转换模型的文件清单过大，请重新准备"));
    }
    let receipt: Value = serde_json::from_slice(&std::fs::read(path)?)?;
    parse_outputs(receipt["outputs"].clone())
}

fn parse_outputs(value: Value) -> Result<Vec<ModelFile>> {
    let files: Vec<ModelFile> = serde_json::from_value(value)?;
    if files.is_empty() || files.len() > 256 || files.iter().any(|file| {
        file.path.is_empty() || Path::new(&file.path).is_absolute() || file.path.contains(['\\', ':'])
            || Path::new(&file.path).components().any(|part| !matches!(part, std::path::Component::Normal(_)))
            || file.bytes == 0 || file.sha256.len() != 64
            || !file.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    }) {
        return Err(ApiError::invalid("转换模型的文件清单无效，请重新准备"));
    }
    Ok(files)
}

impl ControlService {
    pub(super) async fn install_anima_checkpoint(&self, model: &ModelBundle, target: &Path,
        operation: &Value, cancel: &CancellationToken, permit: &Arc<OwnedSemaphorePermit>) -> Result<()> {
        if std::fs::symlink_metadata(target).is_ok() {
            if !receipt_matches(target, model) {
                return Err(ApiError::new(409, "MODEL_CONFLICT",
                    "此模型目录已有文件，准备不会覆盖；已有完整原生模型可在高级设置中采用"));
            }
            jobs::verify_model_files(target, output_files(target)?, cancel).await?;
            return Ok(());
        }
        let inputs = input_root(target, model);
        plan::safe_directory(&inputs)?;
        self.native_stage(operation, 1);
        self.download_native_files(&inputs, &model.files, operation, cancel).await?;
        jobs::verify_files(&inputs, &model.files, cancel).await?;
        stopped(cancel)?;
        self.native_stage(operation, 2);
        self.native_progress(operation, json!({"phase":"converting","stage":"converting",
            "message":"正在将 MiaoMiao 1.6 转换为原生模型；仅使用 CPU，完成前不会启用"}));
        let staging = self.config.ai_workspace_root.join("inference/.staging");
        plan::safe_directory(&staging)?;
        std::fs::create_dir_all(&staging)?;
        // The process owner retains this directory if child termination is unconfirmed.
        let temporary = Arc::new(tempfile::Builder::new().prefix("miaomiao-convert-").tempdir_in(staging)?);
        let output = temporary.path().join("model");
        let runtime = image_models::runtime_for(Some(&model.id))?;
        let settings = image_models::settings(self, &runtime)?;
        let script = self.config.app_root.join("scripts/maintenance/convert-anima-checkpoint.py");
        let mut command = crate::native_python::command(&settings.python, &script);
        command.arg("--profile").arg(model.conversion_profile.as_deref().unwrap())
            .arg("--checkpoint").arg(inputs.join("checkpoint.safetensors"))
            .arg("--transformer-config").arg(inputs.join("transformer/config.json"))
            .arg("--text-encoder").arg(inputs.join("text_encoder.safetensors"))
            .arg("--vae").arg(inputs.join("vae.safetensors"))
            .arg("--qwen-tokenizer").arg(inputs.join("tokenizer"))
            .arg("--t5-tokenizer").arg(inputs.join("t5_tokenizer"))
            .arg("--output-dir").arg(&output).arg("--apply")
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let value = self.run_setup_helper(&mut command, cancel, 3600, permit.clone(), Some(temporary.clone())).await?;
        if value["mode"] != "converted" || value["weightsStrictlyLoaded"] != true
            || value["savedKeyShapeDtypeVerified"] != true
            || value["profile"].as_str() != model.conversion_profile.as_deref()
            || value["outputDir"].as_str().is_none_or(|path| Path::new(path) != output) {
            return Err(ApiError::new(502, "NATIVE_CONVERSION_INCOMPLETE", "MiaoMiao 原生转换未完成，请查看准备日志"));
        }
        let outputs = parse_outputs(value["outputs"].clone())?;
        jobs::verify_files(&inputs, &model.files, cancel).await?;
        jobs::verify_model_files(&output, outputs, cancel).await?;
        self.validate_native_model(&settings, &output, &model.id, cancel, permit).await?;
        stopped(cancel)?;
        std::fs::copy(inputs.join("LICENSE.md"), output.join("LICENSE.md"))?;
        let receipt = json!({"schemaVersion":1,"modelId":model.id,"revision":model.revision,
            "scope":"fixed-inputs-sha256-strict-conversion-and-output-sha256","readyForGeneration":false,
            "sourceUrl":model.source_url,"conversionProfile":model.conversion_profile,"outputs":value["outputs"]});
        let bytes = serde_json::to_vec_pretty(&receipt)?;
        let target = target.to_owned();
        let published = target.clone();
        let token = cancel.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            use std::io::Write;
            let _temporary = temporary;
            let mut file = std::fs::File::create(output.join("huiyu-model.json"))?;
            file.write_all(&bytes)?; file.sync_all()?;
            plan::safe_directory(target.parent().unwrap())?;
            std::fs::create_dir_all(target.parent().unwrap())?;
            if std::fs::symlink_metadata(&target).is_ok() {
                return Err(ApiError::new(409, "MODEL_CONFLICT", "目标模型目录已出现，未覆盖；请重新检查"));
            }
            stopped(&token)?;
            std::fs::rename(output, target)?;
            Ok(())
        }).await.map_err(|_| ApiError::new(503, "MODEL_PUBLISH_FAILED", "模型发布未完成，请重试"))??;
        self.native_stage(operation, 3);
        self.native_progress(operation, json!({"result":{"modelId":model.id,"path":published,"verified":true}}));
        Ok(())
    }
}
