use super::*;
use axum::{Extension, Json, Router, routing::post};
use serde::Deserialize;
use std::{path::{Path, PathBuf}, process::Stdio};
use tokio::{io::{AsyncRead, AsyncReadExt}, process::Command};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrepareRequest {
    base_python: PathBuf,
    wheelhouse: PathBuf,
    workspace_path: PathBuf,
    reviewed: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InspectRequest {
    model_id: String,
    source_dir: PathBuf,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportRequest {
    model_id: String,
    source_dir: PathBuf,
    models_root: PathBuf,
    reviewed: bool,
}

pub(super) fn routes() -> Router<crate::AppState> {
    Router::new()
        .route("/api/inference/runtime/prepare", post(prepare))
        .route("/api/inference/models/inspect", post(inspect))
        .route("/api/inference/models/import", post(import))
}
async fn prepare(Extension(s): Extension<Arc<ControlService>>, Json(body): Json<PrepareRequest>) -> Result<Json<Value>> {
    Ok(Json(s.prepare_inference(body)?))
}
async fn inspect(Extension(s): Extension<Arc<ControlService>>, Json(body): Json<InspectRequest>) -> Result<Json<Value>> {
    let _permit = s.setup_permit()?;
    let (mut command, target) = s.model_import_command(&body.model_id, &body.source_dir, None)?;
    let value = s.run_setup_helper(&mut command, &s.shutdown, 120).await?;
    validate_import_result(&value, true, &body.source_dir, &target)?;
    Ok(Json(value))
}
async fn import(Extension(s): Extension<Arc<ControlService>>, Json(body): Json<ImportRequest>) -> Result<Json<Value>> {
    if !body.reviewed { return Err(ApiError::invalid("请先确认目录导入清单")); }
    let (mut command, target) = s.model_import_command(&body.model_id, &body.source_dir, Some(&body.models_root))?;
    command.arg("--apply");
    let operation = s.start_inference_setup("import-inference-model", command,
        json!({"modelId":body.model_id,"sourceDir":body.source_dir,"modelsRoot":body.models_root,"targetDir":target}))?;
    Ok(Json(json!({"ok":true,"operation":operation})))
}

impl ControlService {
    fn setup_permit(&self) -> Result<tokio::sync::OwnedSemaphorePermit> {
        self.setup_verify_lock.clone().try_acquire_owned()
            .map_err(|_| ApiError::new(409, "SETUP_BUSY", "已有准备、导入、下载或校验正在进行"))
    }
    fn prepare_inference(self: &Arc<Self>, body: PrepareRequest) -> Result<Value> {
        if !body.reviewed || body.workspace_path != self.config.ai_workspace_root {
            return Err(ApiError::new(409, "WORKSPACE_CHANGED", "请确认当前工作区与离线准备清单"));
        }
        absolute(&body.workspace_path)?;
        existing(&body.base_python, false)?;
        existing(&body.wheelhouse, true)?;
        let script = self.config.app_root.join("scripts/maintenance/prepare-inference.py");
        existing(&script, false)?;
        let root = self.config.ai_workspace_root.join("inference");
        let paths = json!({"python":root.join(if cfg!(windows) {"venv/Scripts/python.exe"} else {"venv/bin/python"}),
            "worker":self.config.app_root.join("tools/inference/worker.py"),"modelsRoot":root.join("models"),"lorasRoot":root.join("loras")});
        let mut command = python_command(&body.base_python, &script);
        command.arg("--target-dir").arg(&root).arg("--apply").arg("--wheelhouse").arg(&body.wheelhouse);
        let operation = self.start_inference_setup("prepare-inference-runtime", command,
            json!({"basePython":body.base_python,"wheelhouse":body.wheelhouse,"workspacePath":body.workspace_path,"preparedPaths":paths}))?;
        Ok(json!({"ok":true,"operation":operation,"preparedPaths":paths}))
    }
    fn model_import_command(&self, model_id: &str, source: &Path, expected_root: Option<&Path>) -> Result<(Command, PathBuf)> {
        let catalog = crate::images::catalog();
        if catalog["MODELS"].get(model_id).is_none_or(|model| model["family"] != "anima") {
            return Err(ApiError::invalid("只可导入已登记的 Anima 模型目录"));
        }
        let configured = self.configured_inference()?;
        if expected_root.is_some_and(|root| root != configured.models_root) {
            return Err(ApiError::new(409, "MODELS_ROOT_CHANGED", "已保存的模型根目录已改变，请重新检查导入清单"));
        }
        existing(source, true)?;
        existing(&configured.python, false).map_err(|_| ApiError::new(503, "NATIVE_RUNTIME_UNAVAILABLE", "已保存的独立推理 Python 不存在，请先准备运行库并保存路径"))?;
        let script = self.config.app_root.join("scripts/maintenance/import-anima-directory.py");
        existing(&script, false)?;
        let target = configured.models_root.join(model_id);
        if std::fs::symlink_metadata(&target).is_ok() {
            return Err(ApiError::new(409, "MODEL_TARGET_EXISTS", "目标模型目录已存在，导入不会覆盖已有文件"));
        }
        let mut command = python_command(&configured.python, &script);
        command.arg("--source-dir").arg(source).arg("--target-dir").arg(&target);
        Ok((command, target))
    }
    fn start_inference_setup(self: &Arc<Self>, kind: &str, mut command: Command, details: Value) -> Result<Value> {
        let permit = self.setup_permit()?;
        let mut operation = self.begin(kind, &["正在执行离线准备或目录导入"])?;
        operation.as_object_mut().unwrap().extend(details.as_object().unwrap().clone());
        self.state.lock().unwrap().operation = Some(operation.clone());
        let cancel = self.shutdown.child_token();
        *self.environment_cancel.lock().unwrap() = Some(cancel.clone());
        let service = self.clone();
        let task_operation = operation.clone();
        self.tasks.spawn(async move {
            let _permit = permit;
            let result = async {
                if cancel.is_cancelled() { return Err(cancelled()); }
                let value = service.run_setup_helper(&mut command, &cancel, 3600).await?;
                if task_operation["kind"] == "import-inference-model" {
                    validate_import_result(&value, false, Path::new(task_operation["sourceDir"].as_str().unwrap()), Path::new(task_operation["targetDir"].as_str().unwrap()))?;
                } else {
                    validate_prepared_result(&value, &task_operation)?;
                }
                if let Some(op) = service.state.lock().unwrap().operation.as_mut().filter(|op| op["id"] == task_operation["id"]) {
                    op["result"] = value;
                }
                Ok(())
            }.await;
            service.environment_cancel.lock().unwrap().take();
            service.finish(&task_operation, result);
        });
        Ok(operation)
    }
    async fn run_setup_helper(&self, command: &mut Command, cancel: &CancellationToken, seconds: u64) -> Result<Value> {
        if cancel.is_cancelled() { return Err(cancelled()); }
        let process = self.processes.spawn(command)?;
        let (stdout, stderr) = process.take_output();
        let work = async {
            let (out, err) = tokio::try_join!(bounded_output(stdout, 131072), bounded_output(stderr, 32768))?;
            let success = loop {
                if let Some(success) = process.exited()? { break success; }
                tokio::time::sleep(Duration::from_millis(20)).await;
            };
            let value = serde_json::from_slice::<Value>(&out);
            if !success || value.as_ref().is_ok_and(|v| v["ok"] == false) {
                let detail = value.as_ref().ok().and_then(|v| v["error"]["message"].as_str())
                    .map(str::to_owned).unwrap_or_else(|| String::from_utf8_lossy(&err).into_owned());
                return Err(ApiError::new(503, "NATIVE_SETUP_FAILED", if detail.trim().is_empty() {
                    "离线准备或目录导入失败，请检查本地输入文件".into()
                } else { self.redact(&detail).chars().take(1500).collect::<String>() }));
            }
            let value = value.map_err(|_| protocol_error())?;
            if value["ok"] != true { return Err(protocol_error()); }
            Ok(value)
        };
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(cancelled()),
            result = tokio::time::timeout(Duration::from_secs(seconds), work) => result.unwrap_or_else(|_| Err(ApiError::new(504, "NATIVE_SETUP_TIMEOUT", "离线准备或目录检查超时，已请求停止"))),
        };
        // Keep the operation running until the owned child tree is stopped and reaped.
        process.stop().await?;
        result
    }
}
fn absolute(path: &Path) -> Result<()> {
    if !path.is_absolute() || path.to_str().is_none_or(|s| s.contains('\0')) {
        return Err(ApiError::invalid("准备和导入路径必须是有效的绝对路径"));
    }
    Ok(())
}
fn existing(path: &Path, directory: bool) -> Result<()> {
    absolute(path)?;
    if !std::fs::metadata(path).is_ok_and(|m| if directory { m.is_dir() } else { m.is_file() }) {
        return Err(ApiError::invalid("指定的本地文件或目录不存在或类型不符"));
    }
    Ok(())
}
fn python_command(python: &Path, script: &Path) -> Command {
    let mut command = Command::new(python);
    command.args(["-I", "-B", "-u"]).arg(script)
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .env_remove("PYTHONPATH").env_remove("PYTHONHOME")
        .env("HF_HUB_OFFLINE", "1").env("TRANSFORMERS_OFFLINE", "1");
    command
}
async fn bounded_output<R: AsyncRead + Unpin>(stream: Option<R>, limit: u64) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    stream.ok_or_else(protocol_error)?.take(limit + 1).read_to_end(&mut bytes).await?;
    if bytes.len() as u64 > limit { return Err(protocol_error()); }
    Ok(bytes)
}
fn matches_path(value: &Value, expected: &Path) -> bool {
    value.as_str().is_some_and(|path| Path::new(path) == expected)
}
fn validate_prepared_result(value: &Value, operation: &Value) -> Result<()> {
    let paths = &operation["preparedPaths"];
    if value["schemaVersion"] != 1 || value["engine"] != "native" || !value["environment"].is_object()
        || !matches_path(&value["root"], &Path::new(operation["workspacePath"].as_str().unwrap()).join("inference"))
        || ![ ("python", "python"), ("worker", "worker"), ("modelRoot", "modelsRoot") ].iter()
            .all(|(actual, expected)| matches_path(&value[actual], Path::new(paths[expected].as_str().unwrap()))) {
        return Err(protocol_error());
    }
    Ok(())
}
fn validate_import_result(value: &Value, plan: bool, source: &Path, target: &Path) -> Result<()> {
    if value["planOnly"] != plan || value["scope"] != "layout-only" || value["readyForInference"] != false
        || !matches_path(&value["sourceDir"], source) || !matches_path(&value["targetDir"], target)
        || value["published"] != !plan || value["downloads"] != false
        || value["fileCount"].as_u64().is_none() || value["totalBytes"].as_u64().is_none() {
        return Err(protocol_error());
    }
    Ok(())
}
fn protocol_error() -> ApiError { ApiError::new(502, "NATIVE_SETUP_PROTOCOL", "离线准备工具返回无效或过大的结果") }
fn cancelled() -> ApiError { ApiError::new(499, "CANCELLED", "离线准备或导入已取消；已有临时文件保留，请检查后再重试") }

#[cfg(test)]
mod tests {
    use super::*;
    const MODEL: &str = "anima-base-v1.0";
    fn inputs(s: &ControlService) -> (PrepareRequest, PathBuf) {
        let root = &s.config.app_root;
        std::fs::create_dir_all(root.join("scripts/maintenance")).unwrap();
        for name in ["prepare-inference.py", "import-anima-directory.py"] {
            std::fs::write(root.join("scripts/maintenance").join(name), "# fixture helper\n").unwrap();
        }
        let python = root.join("fake-python");
        std::fs::write(&python, "fixture").unwrap();
        let wheels = root.join("offline wheels;literal");
        let source = root.join("source directory;literal");
        std::fs::create_dir(&wheels).unwrap();
        std::fs::create_dir(&source).unwrap();
        let mut configured = s.inference.as_ref().unwrap().clone();
        configured.python = python.clone();
        s.saved.write().unwrap()["inference"] = serde_json::to_value(configured).unwrap();
        (PrepareRequest { base_python:python, wheelhouse:wheels, workspace_path:s.config.ai_workspace_root.clone(), reviewed:true }, source)
    }
    #[cfg(unix)]
    fn executable(path: &Path, body: &str) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    #[cfg(unix)]
    fn prepare_receipt(s: &ControlService) -> Value {
        let root = s.config.ai_workspace_root.join("inference");
        json!({"ok":true,"schemaVersion":1,"engine":"native","root":root,
            "python":root.join("venv/bin/python"),"worker":s.config.app_root.join("tools/inference/worker.py"),
            "modelRoot":root.join("models"),"environment":{}})
    }
    #[cfg(unix)]
    async fn settled(s: &ControlService) -> Value {
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                let op = s.state.lock().unwrap().operation.clone().unwrap();
                if op["status"] != "running" { return op; }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.unwrap()
    }
    #[tokio::test]
    async fn strict_review_path_catalog_and_saved_root_guards() {
        let (_temp, s) = super::super::tests::fixture(json!({}));
        let (mut request, source) = inputs(&s);
        request.reviewed = false;
        assert_eq!(s.prepare_inference(request).unwrap_err().code, "WORKSPACE_CHANGED");
        assert!(absolute(Path::new("relative/python")).is_err());
        assert!(existing(&source, false).is_err());
        assert!(s.model_import_command("../escape", &source, None).is_err());
        assert!(s.model_import_command("krea2-turbo-fp8", &source, None).is_err());
        assert_eq!(s.model_import_command(MODEL, &source, Some(&s.config.app_root)).unwrap_err().code, "MODELS_ROOT_CHANGED");
        let (command, target) = s.model_import_command(MODEL, &source, None).unwrap();
        let args: Vec<_> = command.as_std().get_args().map(|s| s.to_string_lossy().into_owned()).collect();
        assert_eq!(args, vec!["-I".to_owned(), "-B".into(), "-u".into(), s.config.app_root.join("scripts/maintenance/import-anima-directory.py").to_string_lossy().into_owned(), "--source-dir".into(), source.to_string_lossy().into_owned(), "--target-dir".into(), target.to_string_lossy().into_owned()]);
        std::fs::create_dir_all(&target).unwrap();
        assert_eq!(s.model_import_command(MODEL, &source, None).unwrap_err().code, "MODEL_TARGET_EXISTS");
        for value in [json!({"modelId":MODEL,"sourceDir":source,"extra":true}), json!({"modelId":MODEL})] {
            assert!(serde_json::from_value::<InspectRequest>(value).is_err());
        }
        assert!(serde_json::from_value::<PrepareRequest>(json!({"basePython":"/python","wheelhouse":"/wheels","workspacePath":"/workspace","reviewed":true,"args":["-c"]})).is_err());
        assert!(serde_json::from_value::<ImportRequest>(json!({"modelId":MODEL,"sourceDir":source,"modelsRoot":"/models"})).is_err());
        assert!(s.state.lock().unwrap().operation.is_none());
        s.close().await;
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn preparation_uses_fixed_arguments_and_preserves_configuration() {
        let (_temp, s) = super::super::tests::fixture(json!({"unrelated":true}));
        let (request, _) = inputs(&s);
        let args_path = s.config.app_root.join("arguments");
        executable(&request.base_python, &format!("printf '%s\\n' \"$@\" > '{}'\nprintf '%s\\n' '{}'", args_path.display(), prepare_receipt(&s)));
        let saved = s.saved.read().unwrap().clone();
        let active = s.inference.as_ref().unwrap().clone();
        let root = s.config.ai_workspace_root.join("inference");
        let expected = vec!["-I".into(), "-B".into(), "-u".into(), s.config.app_root.join("scripts/maintenance/prepare-inference.py").display().to_string(), "--target-dir".into(), root.display().to_string(), "--apply".into(), "--wheelhouse".into(), request.wheelhouse.display().to_string()];
        let response = s.prepare_inference(request).unwrap();
        let operation = settled(&s).await;
        assert_eq!(operation["status"], "completed");
        assert_eq!(operation["preparedPaths"], response["preparedPaths"]);
        assert_eq!(operation["result"]["ok"], true);
        let mut invalid = operation["result"].clone();
        invalid["python"] = json!("/unexpected/python");
        assert!(validate_prepared_result(&invalid, &operation).is_err());
        assert_eq!(std::fs::read_to_string(args_path).unwrap().lines().map(str::to_owned).collect::<Vec<_>>(), expected);
        assert_eq!(*s.saved.read().unwrap(), saved);
        assert_eq!(s.inference.as_ref().unwrap(), &active);
        assert!(s.setup_permit().is_ok());
        s.close().await;
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn inspection_is_read_only_and_import_has_layout_only_result() {
        let (_temp, s) = super::super::tests::fixture(json!({}));
        let (request, source) = inputs(&s);
        let models_root = s.configured_inference().unwrap().models_root;
        let result = json!({"ok":true,"planOnly":true,"sourceDir":source,"targetDir":models_root.join(MODEL),"scope":"layout-only","readyForInference":false,"fileCount":8,"totalBytes":100,"published":false,"downloads":false});
        executable(&request.base_python, &format!("printf '%s\\n' '{}'", result));
        let Json(plan) = inspect(Extension(s.clone()), Json(InspectRequest {model_id:MODEL.into(), source_dir:source.clone()})).await.unwrap();
        assert_eq!(plan, result);
        assert!(!models_root.exists());
        let mut applied = result.clone();
        applied["planOnly"] = json!(false);
        applied["published"] = json!(true);
        executable(&request.base_python, &format!("printf '%s\\n' '{}'", applied));
        let Json(response) = import(Extension(s.clone()), Json(ImportRequest {model_id:MODEL.into(), source_dir:source.clone(), models_root:models_root.clone(), reviewed:true})).await.unwrap();
        let op = settled(&s).await;
        assert_eq!(op["status"], "completed");
        assert_eq!(op["id"], response["operation"]["id"]);
        assert_eq!(op["modelsRoot"], json!(models_root));
        assert_eq!(op["result"], applied);
        assert!(!models_root.exists(), "only the helper may create the destination after its path/layout checks");
        s.close().await;
    }
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn cancellation_stops_owned_child_tree_before_releasing_operation() {
        let (_temp, s) = super::super::tests::fixture(json!({}));
        let (request, _) = inputs(&s);
        let pids = s.config.app_root.join("pids");
        executable(&request.base_python, &format!("sleep 30 &\nprintf '%s %s' \"$$\" \"$!\" > '{}'\nwait", pids.display()));
        let response = s.prepare_inference(request).unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while !pids.exists() { tokio::time::sleep(Duration::from_millis(10)).await; }
        }).await.unwrap();
        assert_eq!(s.setup_permit().unwrap_err().code, "SETUP_BUSY");
        assert_eq!(s.cancel_environment(Some("old-operation")).unwrap_err().code, "OPERATION_CHANGED");
        s.cancel_environment(response["operation"]["id"].as_str()).unwrap();
        assert_eq!(settled(&s).await["status"], "failed");
        let ids = std::fs::read_to_string(pids).unwrap();
        let ids: Vec<_> = ids.split_whitespace().collect();
        assert!(!PathBuf::from(format!("/proc/{}", ids[0])).exists(), "direct child must be reaped");
        if let Ok(state) = std::fs::read_to_string(format!("/proc/{}/stat", ids[1])) {
            assert!(state.split_once(") ").unwrap().1.starts_with('Z'), "descendant must no longer run");
        }
        assert!(s.setup_permit().is_ok());
        s.close().await;
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn helper_errors_are_redacted_and_stdout_is_bounded() {
        let (_temp, s) = super::super::tests::fixture(json!({}));
        let (request, _) = inputs(&s);
        executable(&request.base_python, &format!("printf '%s' '{}fixture-secret-token token=fixture' >&2\nexit 1", "x".repeat(1490)));
        s.prepare_inference(request).unwrap();
        let op = settled(&s).await;
        assert_eq!(op["status"], "failed");
        assert!(!op["error"].as_str().unwrap().contains("fixture"));
        assert!(bounded_output(Some(&b"12345"[..]), 4).await.is_err());
        assert_eq!(bounded_output(Some(&b"1234"[..]), 4).await.unwrap(), b"1234");
        s.close().await;
    }
}
