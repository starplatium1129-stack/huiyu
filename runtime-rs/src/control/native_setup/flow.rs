use super::*;

impl ControlService {
    pub(super) async fn start_native_preparation(self: &Arc<Self>, body: Request) -> Result<Value> {
        check_request(self, &body)?;
        let permit = self.setup_permit()?;
        let plan = self.native_setup_plan(body.model_id.as_deref()).await?;
        require_supported(&plan)?;
        let active = self.active_inference()?;
        if !body.model_id.as_deref().is_some_and(image_models::is_video)
            && active.engine != "native"
            && active
                .environment_overrides
                .iter()
                .any(|key| key == "engine")
        {
            return Err(ApiError::new(
                409,
                "CONFIG_ENV_OVERRIDE",
                "当前引擎由启动环境指定，请移除覆盖并重启绘遇后再准备原生引擎",
            ));
        }
        let (_, models) = bundles()?;
        let runtime = image_models::runtime_for(body.model_id.as_deref())?;
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
        let local_import = local_adapters::selected(model_view, body.local_video_import)?;
        let required = if plan["runtime"]["installed"] == true {
            0
        } else {
            plan["runtime"]["requiredBytes"].as_u64().unwrap()
        }
        .saturating_add(
            model_view[if body.checkpoint_path.is_some() {
                "requiredBytesWithCheckpoint"
            } else {
                "requiredBytes"
            }]
            .as_u64()
            .unwrap(),
        );
        require_space(plan["freeBytes"].as_u64(), required)?;
        let mut operation = self.begin_with_id(
            "prepare-native-engine",
            &[
                "检查设备与工作区",
                "下载运行库",
                "安装运行库",
                "运行库就绪",
                "准备模型文件",
                "登记模型组件",
                "模型就绪",
                "启用原生引擎",
                "准备完成",
            ],
            body.operation_id.as_deref(),
        )?;
        operation["workspacePath"] = json!(body.workspace_path);
        operation["planId"] = json!(body.plan_id);
        operation["modelId"] = json!(model.id);
        operation["flowStep"] = json!("runtime");
        operation["stage"] = json!("checking");
        operation["cancelAllowed"] = json!(true);
        operation["downloadedBytes"] = json!(0);
        let runtime_bytes = if plan["runtime"]["installed"] == true { 0 } else { plan["runtime"]["downloadBytes"].as_u64().unwrap_or(0) };
        let model_bytes = if model_view["installed"] == true { 0 } else { model_view["downloadBytes"].as_u64().unwrap_or(0) };
        operation["totalBytes"] = json!(runtime_bytes.saturating_add(model_bytes));
        self.publish_operation(operation.clone())?;
        let cancel = self.shutdown.child_token();
        *self.environment_cancel.lock().unwrap() = Some(cancel.clone());
        let service = self.clone();
        let returned = operation.clone();
        self.tasks.spawn(async move {
            let work = service
                .prepare_native_chain(body, runtime, model, plan, local_import, &operation, &cancel, &permit);
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
                let restart_required = service
                    .inference_view()
                    .ok()
                    .and_then(|view| view["restartRequired"].as_bool())
                    .unwrap_or(true);
                let message = if restart_required {
                    "原生配置已保存，请按重启提示继续"
                } else {
                    "原生引擎已准备并启用，可直接进入画室创作"
                };
                service.native_progress(
                    &operation,
                    json!({"flowStep":"activate","message":message}),
                );
            }
        });
        Ok(json!({"ok":true,"operation":returned}))
    }

    async fn prepare_native_chain(
        self: &Arc<Self>,
        body: Request,
        runtime: Arc<RuntimeBundle>,
        model: Arc<ModelBundle>,
        current: Value,
        local_import: Option<&local_adapters::VideoImport>,
        operation: &Value,
        cancel: &CancellationToken,
        permit: &Arc<OwnedSemaphorePermit>,
    ) -> Result<()> {
        stopped(cancel)?;
        let target = self
            .config
            .ai_workspace_root
            .join("inference/models")
            .join(&model.id);
        let installed = receipt_matches(&target, &model);
        let imported = if installed {
            None
        } else {
            checkpoint_models::stage_checkpoint(
                self,
                &model,
                body.checkpoint_path.as_deref(),
                operation,
                cancel,
            )
            .await?
        };
        let resolved = if model.requires_access && !installed {
            Some(
                image_models::resolve_files(
                    self,
                    &model,
                    &target,
                    body.hf_token.as_deref(),
                    cancel,
                )
                .await?,
            )
        } else {
            None
        };
        let runtime_bytes = if current["runtime"]["installed"] == true { 0 } else { current["runtime"]["downloadBytes"].as_u64().unwrap_or(0) };
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
        let mut model_operation = operation.clone();
        model_operation["flowStep"] = json!("model");
        model_operation["downloadOffset"] = json!(runtime_bytes);
        self.native_progress(&model_operation, json!({"stage":"checking","phase":"checking","currentFile":"","message":"准备完整模型"}));
        if !installed {
            self.install_native_model(
                &model,
                &model_operation,
                cancel,
                permit,
                body.hf_token.as_deref(),
                imported.as_ref(),
                resolved,
                local_import,
            )
            .await?;
        }
        self.stage(operation, 6);
        let mut progress = json!({"message":"模型组件已就绪"});
        if !installed && local_import.is_none() {
            progress["downloadedBytes"] = json!(model.files.iter().map(|file| file.bytes).sum::<u64>());
        }
        self.native_progress(&model_operation, progress);
        stopped(cancel)?;
        let mut activation = operation.clone();
        activation["flowStep"] = json!("activate");
        self.native_stage(&activation, 0);
        let saved = self
            .activate_native_settings(body, &activation, cancel, permit)
            .await?;
        let engine_key = if image_models::is_video(&model.id) {
            "videoEngine"
        } else {
            "engine"
        };
        if saved["configured"][engine_key] != "native" {
            return Err(ApiError::new(
                502,
                "NATIVE_ACTIVATION_INCOMPLETE",
                "原生引擎配置未确认，请重新检查",
            ));
        }
        self.stage(operation, 8);
        let paths = json!({"python":saved["configured"]["python"],"worker":saved["configured"]["worker"],
            "modelsRoot":saved["configured"]["modelsRoot"],"lorasRoot":saved["configured"]["lorasRoot"]});
        let mut progress = json!({"stage":"prepared","phase":"prepared", "currentFile":"",
            "result":{"engine":"native","modelId":model.id,
                "restartRequired":saved["restartRequired"],
                "active":{"engine":saved["active"]["engine"],"videoEngine":saved["active"]["videoEngine"]},
                "configured":{"engine":saved["configured"]["engine"],"videoEngine":saved["configured"]["videoEngine"]},
                "generationVerified":false}});
        if !image_models::is_adapter_runtime(&runtime) {
            progress["preparedPaths"] = paths;
        }
        self.native_progress(&activation, progress);
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
pub(super) fn require_space(free: Option<u64>, required: u64) -> Result<()> {
    if free.is_none_or(|free| free < required) {
        return Err(ApiError::new(
            409,
            "ENOSPC",
            format!("当前工作区空间不足，至少需要 {required} 字节；请释放空间或另选磁盘后继续"),
        ));
    }
    Ok(())
}
