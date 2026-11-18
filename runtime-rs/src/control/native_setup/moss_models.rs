use super::*;
use std::process::Stdio;

pub(super) fn is_moss(model: &ModelBundle) -> bool {
    crate::generation::native::adapters::model(&model.id)
        .is_some_and(|spec| spec["family"] == "moss-image")
}

pub(super) fn text_is_int8(model: &ModelBundle) -> bool {
    crate::generation::native::adapters::model(&model.id)
        .is_some_and(|spec| spec["managedPrecision"]["text_encoder"] == "int8")
}

pub(super) fn prepare_bundle(model: &mut ModelBundle) -> Result<()> {
    if !text_is_int8(model) {
        return Ok(());
    }
    let spec = &crate::generation::native::adapters::model(&model.id).unwrap()["mossTextInt8"];
    model
        .files
        .retain(|file| !file.path.starts_with("text_encoder/model"));
    model.files.push(serde_json::from_value(
        json!({"path":spec["path"], "url":spec["sourceUrl"],
        "bytes":spec["bytes"], "sha256":spec["sha256"]}),
    )?);
    model.required_bytes = model.files.iter().map(|file| file.bytes).sum();
    Ok(())
}

fn component_record(model: &ModelBundle, key: &str) -> Option<Value> {
    let spec = &crate::generation::native::adapters::model(&model.id)?[key];
    let path = spec["path"].as_str()?;
    model
        .files
        .iter()
        .any(|file| file.path == path && spec["sha256"] == file.sha256)
        .then(|| {
            json!({"schemaVersion":1,"modelId":model.id,"scope":"imported-files-sha256",
            "path":path,"bytes":spec["bytes"],"sha256":spec["sha256"]})
        })
}

pub(super) fn receipts(model: &ModelBundle) -> Vec<(&'static str, Value)> {
    [
        ("huiyu-moss-int8.json", "mossInt8"),
        ("huiyu-moss-text-int8.json", "mossTextInt8"),
    ]
    .into_iter()
    .filter_map(|(name, key)| component_record(model, key).map(|value| (name, value)))
    .collect()
}

pub(super) fn ready(root: &Path, model: &ModelBundle, receipt: &Value) -> bool {
    let legacy_text = text_is_int8(model)
        && receipt["mossTextPrecision"].is_null()
        && root
            .join("text_encoder/model.safetensors.index.json")
            .is_file();
    for (name, expected) in receipts(model) {
        if legacy_text && name == "huiyu-moss-text-int8.json" {
            continue;
        }
        let actual = std::fs::read(root.join(name))
            .ok()
            .filter(|bytes| bytes.len() < 4096)
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        if actual.as_ref() != Some(&expected) {
            return false;
        }
    }
    model
        .files
        .iter()
        .filter(|file| !legacy_text || !file.path.starts_with("text_encoder/qwen35_9b_int8"))
        .all(|file| {
            std::fs::symlink_metadata(root.join(&file.path))
                .is_ok_and(|meta| meta.is_file() && meta.len() == file.bytes)
        })
}

impl ControlService {
    pub(super) async fn convert_moss_checkpoint(
        &self,
        root: &Path,
        model: &ModelBundle,
        operation: &Value,
        cancel: &CancellationToken,
        permit: &Arc<OwnedSemaphorePermit>,
    ) -> Result<()> {
        self.native_progress(
            operation,
            json!({"phase":"converting","stage":"converting","currentFile":"",
            "message":"正在将作者权重适配为原生 MOSS 组件"}),
        );
        let held = self.hold_native_files(root, &model.files, cancel).await?;
        let runtime = image_models::runtime_for(Some(&model.id))?;
        let settings = image_models::settings(self, &runtime)?;
        let mut command = crate::native_python::command(&settings.python, &settings.worker);
        command
            .arg("--prepare-moss")
            .arg(root)
            .arg("--model-id")
            .arg(&model.id)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let report = self
            .run_setup_helper(
                &mut command,
                cancel,
                600,
                permit.clone(),
                Some(Arc::new(held)),
                Some(operation),
            )
            .await?;
        if report["preparedModel"] != model.id || report["weightsMapped"] != true {
            return Err(ApiError::new(
                502,
                "NATIVE_CONVERSION_INCOMPLETE",
                "MOSS 原生格式转换未完成",
            ));
        }
        Ok(())
    }
}
