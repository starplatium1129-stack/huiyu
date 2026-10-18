use super::*;
use std::process::Stdio;

impl ControlService {
    pub(super) async fn start_pixai_preparation(
        self: &Arc<Self>,
        body: Prepare,
        interrogate: Arc<crate::interrogate::InterrogateService>,
        admission: crate::host::OwnedWriteGuard,
    ) -> Result<Value> {
        if !body.reviewed
            || body.workspace_path != self.config.ai_workspace_root
            || body.plan_id != fingerprint(self)
        {
            return Err(ApiError::new(
                409,
                "WORKSPACE_CHANGED",
                "工作区或反推下载清单已改变，请重新检查后准备",
            ));
        }
        let permit = self.setup_permit()?;
        let admission = Arc::new(admission);
        let plan = self.pixai_setup_plan().await?;
        if plan["supported"] != true {
            return Err(ApiError::new(
                409,
                "PIXAI_SETUP_UNAVAILABLE",
                plan["reasons"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join("；"),
            ));
        }
        let mut operation = self.begin(
            "prepare-pixai",
            &[
                "检查设备与 AI 工作区",
                "下载独立运行库",
                "安装独立运行库",
                "运行库就绪",
                "下载 PixAI 模型与依赖",
                "核验模型与依赖",
                "启用图片反推",
                "反推准备完成",
            ],
        )?;
        operation["workspacePath"] = json!(body.workspace_path);
        operation["planId"] = json!(body.plan_id);
        operation["downloadedBytes"] = json!(0);
        operation["totalBytes"] = plan["downloadBytes"].clone();
        operation["cancelAllowed"] = json!(true);
        self.state.lock().unwrap().operation = Some(operation.clone());
        let cancel = self.shutdown.child_token();
        *self.environment_cancel.lock().unwrap() = Some(cancel.clone());
        let service = self.clone();
        let returned = operation.clone();
        self.tasks.spawn(async move {
            let work = service.prepare_pixai(&operation, &cancel, &interrogate, &permit, &admission);
            tokio::pin!(work);
            let result = match tokio::time::timeout(Duration::from_secs(8 * 3600), &mut work).await
            {
                Ok(result) => result,
                Err(_) => {
                    cancel.cancel();
                    // Keep both host and installer admission until disk/process
                    // cleanup has drained, including protected Windows installs.
                    match work.await {
                        Err(error) if error.code == "TERMINATION_UNCONFIRMED" => Err(error),
                        _ => Err(ApiError::new(
                            504,
                            "PIXAI_SETUP_TIMEOUT",
                            "反推准备超过八小时，已停止；已校验文件与续传下载保留",
                        )),
                    }
                }
            };
            service.environment_cancel.lock().unwrap().take();
            service.finish(&operation, result);
        });
        Ok(json!({"ok":true,"operation":returned}))
    }
    async fn prepare_pixai(
        &self,
        operation: &Value,
        cancel: &CancellationToken,
        interrogate: &crate::interrogate::InterrogateService,
        permit: &Arc<OwnedSemaphorePermit>,
        admission: &Arc<crate::host::OwnedWriteGuard>,
    ) -> Result<()> {
        stopped(cancel)?;
        let runtime = runtime_bundle()?;
        let manifest = load_manifest()?;
        let files = artifacts(&manifest)?;
        let root = self.config.ai_workspace_root.join("PixAI");
        let runtime_root = self
            .config
            .ai_workspace_root
            .join("inference")
            .join(&runtime.runtime_id);
        let installed = runtime_ready(&runtime_root, &runtime);
        if !installed {
            self.install_native_runtime(&runtime, operation, cancel, permit, Some(admission.clone()))
                .await?;
        } else {
            self.stage(operation, 3);
            self.native_progress(
                operation,
                json!({"message":"复用已安装的独立运行库，稍后重新检查依赖与显卡"}),
            );
        }
        stopped(cancel)?;
        self.stage(operation, 4);
        let mut model_operation = operation.clone();
        model_operation["downloadOffset"] =
            json!(if installed { 0 } else { runtime.download_bytes });
        self.download_native_files(&root, &files, &model_operation, cancel)
            .await?;
        stopped(cancel)?;
        self.stage(operation, 5);
        self.native_progress(
            operation,
            json!({"phase":"validating", "currentFile":"",
            "message":"核验模型 SHA-256、独立依赖和 CUDA/BF16，暂不加载模型"}),
        );
        let expected = expected_paths(self, &runtime, &manifest);
        let python = Path::new(expected["python"].as_str().unwrap());
        let mut command = tokio::process::Command::new(python);
        command
            .args(["-I", "-B", "-u", "-X", "utf8"])
            .arg(
                self.config
                    .app_root
                    .join("scripts/lib/prepare-pixai-runtime.py"),
            )
            .arg("--root")
            .arg(&root)
            .arg("--runtime-root")
            .arg(&runtime_root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env_remove("PYTHONPATH")
            .env_remove("PYTHONHOME")
            .env("HF_HUB_OFFLINE", "1")
            .env("TRANSFORMERS_OFFLINE", "1");
        let value = self.run_setup_helper(&mut command, cancel, 600, permit.clone(), Some(admission.clone())).await?;
        if value["schemaVersion"] != 1
            || value["engine"] != "pixai"
            || value["environment"]["cudaAvailable"] != true
            || value["environment"]["bf16Supported"] != true
            || value["environment"]["cpuOnly"] != false
            || value["environment"]["timmVersion"] != manifest.timm.version
            || !["python", "modelDir", "depsDir", "torchSitePackages"]
                .iter()
                .all(|key| {
                    value[key]
                        .as_str()
                        .zip(expected[key].as_str())
                        .is_some_and(|(a, b)| {
                            Path::new(a)
                                .canonicalize()
                                .ok()
                                .zip(Path::new(b).canonicalize().ok())
                                .is_some_and(|(a, b)| a == b)
                        })
                })
        {
            return Err(ApiError::new(
                502,
                "PIXAI_SETUP_PROTOCOL",
                "反推运行库未通过路径与依赖校验，未保存启用配置",
            ));
        }
        stopped(cancel)?;
        self.stage(operation, 6);
        // From this point a bounded atomic commit and live activation are one
        // operation. Cancelling earlier leaves the previous receipt untouched.
        {
            let mut state = self.state.lock().unwrap();
            stopped(cancel)?;
            let current = state
                .operation
                .as_mut()
                .filter(|value| value["id"] == operation["id"])
                .ok_or_else(|| ApiError::new(409, "OPERATION_CHANGED", "准备操作已改变"))?;
            current["cancelAllowed"] = json!(false);
            current["phase"] = json!("activating");
            current["message"] = json!("保存反推配置并刷新服务");
        }
        let receipt = self.config.runtime_root.join("pixai/runtime-config.json");
        let mut document = expected;
        document["schemaVersion"] = json!(1);
        document["engine"] = json!("pixai");
        document["environment"] = value["environment"].clone();
        document["modelRevision"] = json!(manifest.revision);
        let bytes = serde_json::to_vec_pretty(&document)?;
        tokio::task::spawn_blocking(move || -> Result<()> {
            use std::io::Write;
            let parent = receipt.parent().unwrap();
            plan::safe_directory(parent)?;
            std::fs::create_dir_all(parent)?;
            if std::fs::symlink_metadata(&receipt).is_ok() {
                let identity = crate::file_identity::path(&receipt, false)?;
                if identity.links != 1 {
                    return Err(ApiError::invalid("反推配置不能是链接文件"));
                }
            }
            let mut temp = tempfile::NamedTempFile::new_in(parent)?;
            temp.write_all(&bytes)?;
            temp.as_file().sync_all()?;
            temp.persist(&receipt)
                .map_err(|error| ApiError::from(error.error))?;
            Ok(())
        })
        .await
        .map_err(|_| ApiError::new(503, "PIXAI_SAVE_FAILED", "反推配置保存未确认，请重新检查"))??;
        let status = interrogate.reload(&self.config).await?;
        if status["available"] != true {
            return Err(ApiError::new(
                503,
                "PIXAI_ACTIVATION_FAILED",
                "反推配置已保存，服务启用未确认；请重启绘遇后重新检查",
            ));
        }
        self.stage(operation, 7);
        self.native_progress(
            operation,
            json!({"phase":"completed","cancelAllowed":true,
            "downloadedBytes":operation["totalBytes"],"result":document,
            "message":"图片反推已准备；首次使用时加载模型，需约 4 GiB 空闲显存"}),
        );
        Ok(())
    }
}
