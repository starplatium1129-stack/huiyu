use super::*;

impl ControlService {
    pub(super) async fn start_native_preparation(self: &Arc<Self>, body: Request) -> Result<Value> {
        check_request(self, &body)?;
        let permit = self.setup_permit()?;
        let plan = self.native_setup_plan().await?;
        require_supported(&plan)?;
        let (runtime, models) = bundles()?;
        let model = models
            .into_iter()
            .find(|model| Some(&model.id) == body.model_id.as_ref())
            .ok_or_else(|| ApiError::invalid("请选择已登记的完整原生模型包"))?;
        let model_view = plan["models"]
            .as_array()
            .unwrap()
            .iter()
            .find(|value| value["id"] == model.id)
            .unwrap();
        let required = if plan["runtime"]["installed"] == true {
            0
        } else {
            plan["runtime"]["requiredBytes"].as_u64().unwrap()
        }
        .saturating_add(model_view["requiredBytes"].as_u64().unwrap());
        require_space(plan["freeBytes"].as_u64(), required)?;
        let mut operation = self.begin(
            "prepare-native-engine",
            &[
                "检查设备与工作区",
                "下载运行库",
                "安装运行库",
                "运行库就绪",
                "下载完整模型",
                "校验模型",
                "模型就绪",
                "启用原生引擎",
                "准备完成",
            ],
        )?;
        operation["workspacePath"] = json!(body.workspace_path);
        operation["planId"] = json!(body.plan_id);
        operation["modelId"] = json!(model.id);
        operation["flowStep"] = json!("runtime");
        operation["stage"] = json!("checking");
        operation["cancelAllowed"] = json!(true);
        operation["downloadedBytes"] = json!(0);
        operation["totalBytes"] = json!(
            runtime
                .download_bytes
                .saturating_add(model.files.iter().map(|file| file.bytes).sum::<u64>())
        );
        self.state.lock().unwrap().operation = Some(operation.clone());
        let cancel = self.shutdown.child_token();
        *self.environment_cancel.lock().unwrap() = Some(cancel.clone());
        let service = self.clone();
        let returned = operation.clone();
        self.tasks.spawn(async move {
            let work = service.prepare_native_chain(body, runtime, model, &operation, &cancel, &permit);
            tokio::pin!(work);
            let result = match tokio::time::timeout(Duration::from_secs(8 * 3600), &mut work).await
            {
                Ok(result) => result,
                Err(_) => {
                    cancel.cancel();
                    // Drain owned writes and the system-installer handoff before
                    // releasing admission; closing the page never stops this task.
                    match work.await {
                        Err(error) if error.code == "TERMINATION_UNCONFIRMED" => Err(error),
                        _ => Err(ApiError::new(
                            504,
                            "NATIVE_SETUP_TIMEOUT",
                            "准备超时，已停止；已完成文件保留，请检查后重试",
                        )),
                    }
                }
            };
            let completed = result.is_ok();
            service.environment_cancel.lock().unwrap().take();
            service.finish(&operation, result);
            if completed {
                service.native_progress(
                    &operation,
                    json!({"flowStep":"activate","message":"原生配置已保存，请按重启提示继续"}),
                );
            }
        });
        Ok(json!({"ok":true,"operation":returned}))
    }

    async fn prepare_native_chain(
        self: &Arc<Self>,
        body: Request,
        runtime: RuntimeBundle,
        model: ModelBundle,
        operation: &Value,
        cancel: &CancellationToken,
        permit: &Arc<OwnedSemaphorePermit>,
    ) -> Result<()> {
        stopped(cancel)?;
        let current = self.native_setup_plan().await?;
        require_supported(&current)?;
        let runtime_bytes = runtime.download_bytes;
        let model_bytes = model.files.iter().map(|file| file.bytes).sum::<u64>();
        let mut runtime_operation = operation.clone();
        runtime_operation["flowStep"] = json!("runtime");
        runtime_operation["downloadOffset"] = json!(0);
        if current["runtime"]["installed"] != true {
            require_space(
                current["freeBytes"].as_u64(),
                current["runtime"]["requiredBytes"].as_u64().unwrap(),
            )?;
            self.install_native_runtime(&runtime, &runtime_operation, cancel, permit, None)
                .await?;
        }
        self.stage(operation, 3);
        self.native_progress(
            &runtime_operation,
            json!({"downloadedBytes":runtime_bytes,"message":"运行库已就绪"}),
        );
        stopped(cancel)?;
        let workspace = self.config.ai_workspace_root.clone();
        let app = self.config.app_root.clone();
        let model_copy = model.clone();
        let (free, needed) = tokio::task::spawn_blocking(move || -> Result<_> {
            let free = plan::safe_workspace(&workspace, &app)?;
            Ok((
                free,
                plan::model_needed(&workspace.join("inference"), &model_copy),
            ))
        })
        .await
        .map_err(|_| ApiError::new(503, "WORKSPACE_CHECK_FAILED", "工作区检查未完成"))??;
        require_space(Some(free), needed)?;
        let mut model_operation = operation.clone();
        model_operation["flowStep"] = json!("model");
        model_operation["downloadOffset"] = json!(runtime_bytes);
        self.native_progress(&model_operation, json!({"stage":"checking","phase":"checking","currentFile":"","message":"准备完整模型"}));
        let model_root = self
            .config
            .ai_workspace_root
            .join("inference/models")
            .join(&model.id);
        if !receipt_matches(&model_root, &model) {
            self.install_native_model(&model, &model_operation, cancel, permit)
                .await?;
        }
        self.stage(operation, 6);
        self.native_progress(
            &model_operation,
            json!({"downloadedBytes":model_bytes,"message":"模型组件已就绪"}),
        );
        stopped(cancel)?;
        let mut activation = operation.clone();
        activation["flowStep"] = json!("activate");
        self.native_stage(&activation, 0);
        let saved = self
            .activate_native_settings(body, &activation, cancel, permit)
            .await?;
        if saved["configured"]["engine"] != "native" {
            return Err(ApiError::new(
                502,
                "NATIVE_ACTIVATION_INCOMPLETE",
                "原生引擎配置未确认，请重新检查",
            ));
        }
        self.stage(operation, 8);
        let paths = json!({"python":saved["configured"]["python"],"worker":saved["configured"]["worker"],
            "modelsRoot":saved["configured"]["modelsRoot"],"lorasRoot":saved["configured"]["lorasRoot"]});
        self.native_progress(&activation, json!({"stage":"prepared","phase":"prepared", "currentFile":"",
            "preparedPaths":paths,"result":{"engine":"native","modelId":model.id,
                "restartRequired":saved["restartRequired"],"active":saved["active"],"configured":saved["configured"],
                "generationVerified":false}}));
        Ok(())
    }
}

fn require_supported(plan: &Value) -> Result<()> {
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
    Ok(())
}
fn require_space(free: Option<u64>, required: u64) -> Result<()> {
    if free.is_none_or(|free| free < required) {
        return Err(ApiError::new(
            409,
            "ENOSPC",
            format!("当前工作区空间不足，至少需要 {required} 字节；请释放空间或另选磁盘后继续"),
        ));
    }
    Ok(())
}
