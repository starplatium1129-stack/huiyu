use super::*;
use std::process::Stdio;

impl ControlService {
    pub(super) async fn start_native_setup(
        self: &Arc<Self>,
        body: Request,
        model_download: bool,
    ) -> Result<Value> {
        check_request(self, &body)?;
        let plan = self.native_setup_plan(body.model_id.as_deref()).await?;
        if plan["supported"] != true {
            return Err(ApiError::new(
                409,
                "NATIVE_DEVICE_UNSUPPORTED",
                plan["reasons"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join("；"),
            ));
        }
        let (_, models) = bundles()?;
        let runtime = image_models::runtime_for(body.model_id.as_deref())?;
        let model = if model_download {
            Some(
                models
                    .into_iter()
                    .find(|m| Some(&m.id) == body.model_id.as_ref())
                    .ok_or_else(|| ApiError::invalid("请选择已登记的完整原生模型包"))?,
            )
        } else {
            None
        };
        let required = if let Some(model) = &model {
            plan["models"]
                .as_array()
                .unwrap()
                .iter()
                .find(|value| value["id"] == model.id)
                .unwrap()["requiredBytes"]
                .as_u64()
                .unwrap()
        } else {
            plan["runtime"]["requiredBytes"].as_u64().unwrap()
        };
        if plan["freeBytes"]
            .as_u64()
            .is_none_or(|free| free < required)
        {
            return Err(ApiError::new(
                409,
                "ENOSPC",
                format!(
                    "当前工作区剩余空间不足，此阶段至少需要 {required} 字节；请释放空间或另选磁盘后重试"
                ),
            ));
        }
        if model_download && plan["runtime"]["installed"] != true {
            return Err(ApiError::new(
                409,
                "NATIVE_RUNTIME_UNAVAILABLE",
                "请先完成运行库准备，再下载并校验模型",
            ));
        }
        let permit = self.setup_permit()?;
        let kind = if model_download {
            "download-native-model"
        } else {
            "install-native-runtime"
        };
        let mut operation = self.begin_with_id(
            kind,
            &[
                "检查设备和目标目录",
                "下载并核对固定文件",
                "安装或校验组件",
                "发布可用版本",
            ],
            body.operation_id.as_deref(),
        )?;
        operation["workspacePath"] = json!(body.workspace_path);
        operation["planId"] = json!(body.plan_id);
        operation["modelId"] = json!(body.model_id);
        operation["downloadedBytes"] = json!(0);
        operation["totalBytes"] = json!(
            model
                .as_ref()
                .map(|m| m.files.iter().map(|file| file.bytes).sum::<u64>())
                .unwrap_or(runtime.download_bytes)
        );
        if !model_download && !image_models::is_adapter_runtime(&runtime) {
            operation["preparedPaths"] = runtime_paths(self, &runtime);
        }
        self.publish_operation(operation.clone())?;
        let cancel = self.shutdown.child_token();
        *self.environment_cancel.lock().unwrap() = Some(cancel.clone());
        let service = self.clone();
        let returned = operation.clone();
        self.tasks.spawn(async move {
            let result = async {
                let work = async {
                    if let Some(model) = model {
                        let target = service
                            .config
                            .ai_workspace_root
                            .join("inference/models")
                            .join(&model.id);
                        let imported = if receipt_matches(&target, &model) {
                            None
                        } else {
                            checkpoint_models::stage_checkpoint(
                                &service,
                                &model,
                                body.checkpoint_path.as_deref(),
                                &cancel,
                            )
                            .await?
                        };
                        service
                            .install_native_model(
                                &model,
                                &operation,
                                &cancel,
                                &permit,
                                body.hf_token.as_deref(),
                                imported.as_deref(),
                                None,
                            )
                            .await
                    } else {
                        service
                            .install_native_runtime(&runtime, &operation, &cancel, &permit, None)
                            .await
                    }
                };
                tokio::pin!(work);
                match tokio::time::timeout(Duration::from_secs(4 * 3600), &mut work).await {
                    Ok(result) => result,
                    Err(_) => {
                        cancel.cancel();
                        // Drain owned download writes and terminate/reap any installer
                        // before unlocking another preparation operation.
                        match work.await {
                            Err(error) if error.code == "TERMINATION_UNCONFIRMED" => Err(error),
                            _ => Err(ApiError::new(
                                504,
                                "NATIVE_SETUP_TIMEOUT",
                                "准备超过四小时，已停止；请检查网络或磁盘后继续",
                            )),
                        }
                    }
                }
            }
            .await;
            service.environment_cancel.lock().unwrap().take();
            service.finish(&operation, result);
        });
        Ok(json!({"ok":true,"operation":returned}))
    }

    pub(super) async fn install_native_runtime(
        &self,
        runtime: &RuntimeBundle,
        operation: &Value,
        cancel: &CancellationToken,
        permit: &Arc<OwnedSemaphorePermit>,
        keep_alive: Option<Arc<dyn Send + Sync>>,
    ) -> Result<()> {
        let workspace = &self.config.ai_workspace_root;
        let cache = workspace
            .join("inference/.downloads")
            .join(&runtime.runtime_id);
        plan::safe_directory(&cache)?;
        self.native_stage(operation, 1);
        self.download_native_files(&cache, &runtime.files, operation, cancel)
            .await?;
        stopped(cancel)?;
        self.native_stage(operation, 2);
        let mut command = tokio::process::Command::new("powershell.exe");
        command
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(crate::file_paths::absolute(
                &self
                    .config
                    .app_root
                    .join("scripts/lib/prepare-native-runtime.ps1"),
            )?)
            .arg("-Workspace")
            .arg(crate::file_paths::absolute(workspace)?)
            .arg("-RuntimeId")
            .arg(&runtime.runtime_id)
            .arg("-CacheDir")
            .arg(crate::file_paths::absolute(&cache)?)
            .arg("-ManagedProtocol")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let value = self
            .run_native_installer(&mut command, cancel, operation, permit.clone(), keep_alive)
            .await?;
        let paths = runtime_paths(self, runtime);
        if value["engine"] != "native"
            || value["schemaVersion"] != 1
            || !["python", "worker"].iter().all(|key| {
                value[key]
                    .as_str()
                    .zip(paths[key].as_str())
                    .is_some_and(|(actual, expected)| {
                        Path::new(actual)
                            .canonicalize()
                            .ok()
                            .zip(Path::new(expected).canonicalize().ok())
                            .is_some_and(|(a, b)| a == b)
                    })
            })
            || value["environment"]["cudaAvailable"] != true
        {
            return Err(ApiError::new(
                502,
                "NATIVE_SETUP_PROTOCOL",
                "运行库未通过发布校验，请查看准备日志后重试",
            ));
        }
        stopped(cancel)?;
        self.native_stage(operation, 3);
        let mut progress = json!({"result":value});
        if !image_models::is_adapter_runtime(runtime) {
            progress["preparedPaths"] = paths;
        }
        self.native_progress(operation, progress);
        Ok(())
    }

    pub(super) async fn install_native_model(
        &self,
        model: &ModelBundle,
        operation: &Value,
        cancel: &CancellationToken,
        permit: &Arc<OwnedSemaphorePermit>,
        hf_token: Option<&str>,
        imported: Option<&str>,
        resolved: Option<Vec<Artifact>>,
    ) -> Result<()> {
        let workspace = &self.config.ai_workspace_root;
        let target = workspace.join("inference/models").join(&model.id);
        if receipt_matches(&target, model) {
            return Ok(());
        }
        if model.conversion_profile.is_some() {
            return self
                .install_anima_checkpoint(model, &target, imported, operation, cancel, permit)
                .await;
        }
        let staged = workspace
            .join("inference/.staging")
            .join(format!("{}-{}", model.id, model.revision));
        let existed = target.exists();
        let root = if existed { &target } else { &staged };
        plan::safe_directory(root)?;
        self.native_stage(operation, 1);
        // Reuses matching files and downloads only missing components; a corrupt
        // user-owned file is a conflict, never silently replaced.
        let files = match resolved {
            Some(files) => files,
            None => image_models::resolve_files(self, model, root, hf_token, cancel).await?,
        };
        let pending: Vec<_> = files
            .into_iter()
            .filter(|file| imported != Some(file.path.as_str()))
            .collect();
        self.download_native_files_authorized(
            root,
            &pending,
            operation,
            cancel,
            hf_token,
            !model.requires_access,
        )
        .await?;
        self.native_stage(operation, 2);
        stopped(cancel)?;
        self.native_stage(operation, 3);
        let document = json!({"schemaVersion":1,"modelId":model.id,"revision":model.revision,
            "scope":"downloaded-files-sha256","readyForGeneration":false});
        let bytes = serde_json::to_vec_pretty(&document)?;
        let root = root.clone();
        let target_copy = target.clone();
        let token = cancel.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            use std::io::Write;
            plan::safe_directory(&root)?;
            stopped(&token)?;
            let mut temp = tempfile::NamedTempFile::new_in(&root)?;
            temp.write_all(&bytes)?;
            temp.as_file().sync_all()?;
            temp.persist(root.join("huiyu-model.json"))
                .map_err(|e| ApiError::from(e.error))?;
            if !existed {
                plan::safe_directory(target_copy.parent().unwrap())?;
                std::fs::create_dir_all(target_copy.parent().unwrap())?;
                if std::fs::symlink_metadata(&target_copy).is_ok() {
                    return Err(ApiError::new(
                        409,
                        "MODEL_CONFLICT",
                        "目标目录已出现，未覆盖；请检查后重试",
                    ));
                }
                stopped(&token)?;
                std::fs::rename(root, target_copy)?;
            }
            Ok(())
        })
        .await
        .map_err(|_| ApiError::new(503, "MODEL_PUBLISH_FAILED", "模型发布未完成，请重试"))??;
        self.native_progress(
            operation,
            json!({"result":{"modelId":model.id,"path":target,"verified":true}}),
        );
        Ok(())
    }

    pub(super) fn native_stage(&self, operation: &Value, index: usize) {
        if operation["kind"] != "prepare-native-engine" {
            self.stage(operation, index);
            return;
        }
        let (global, stage) = match operation["flowStep"].as_str() {
            Some("runtime") => (
                index,
                if index == 1 {
                    "downloading"
                } else {
                    "installing"
                },
            ),
            Some("model") => (
                index + 3,
                if index == 1 {
                    "downloading"
                } else {
                    "validating"
                },
            ),
            _ => (7, "activating"),
        };
        self.stage(operation, global);
        self.native_progress(operation, json!({"stage":stage,"phase":stage}));
    }

    pub(super) fn native_progress(&self, operation: &Value, mut update: Value) {
        if matches!(
            operation["kind"].as_str(),
            Some("prepare-native-engine" | "prepare-pixai")
        ) {
            if update.get("flowStep").is_none() {
                update["flowStep"] = operation["flowStep"].clone();
            }
            if let Some(bytes) = update["downloadedBytes"].as_u64() {
                update["downloadedBytes"] =
                    json!(bytes.saturating_add(operation["downloadOffset"].as_u64().unwrap_or(0)));
            }
        }
        let mut state = self.state.lock().unwrap();
        if let Some(value) = state
            .operation
            .as_mut()
            .filter(|value| value["id"] == operation["id"])
        {
            value
                .as_object_mut()
                .unwrap()
                .extend(update.as_object().unwrap().clone());
        }
        self.checkpoint_operation(
            &mut state,
            update.get("stage").is_some() || update.get("cancelAllowed").is_some(),
        );
    }
}
