mod listener;
mod model_paths;
use super::*;
use std::process::Stdio;
use tokio::process::Command;

impl ControlService {
    pub(super) fn comfy_root(&self) -> std::path::PathBuf {
        let managed = self
            .config
            .ai_workspace_root
            .join(".runtimes/comfy/ComfyUI");
        if managed.join("main.py").is_file() {
            return managed;
        }
        let existing = self.config.ai_workspace_root.join("ComfyUI");
        if existing.join("main.py").is_file() {
            existing
        } else {
            managed
        }
    }

    pub(super) fn saved_comfy_intent(&self) -> bool {
        let saved = self.saved.read().unwrap();
        let managed = &saved["managedServices"];
        let (Some(host), Some(root)) =
            (managed["comfyHost"].as_str(), managed["comfyRoot"].as_str())
        else {
            // Legacy booleans cannot prove ownership after a workspace change.
            // One explicit start records the current installation identity.
            return false;
        };
        managed["comfy"] == true
            && crate::upstream::local_url(host)
                .ok()
                .zip(crate::upstream::local_url(&self.config.comfy_host).ok())
                .is_some_and(|(saved, active)| saved == active)
            && std::path::Path::new(root) == self.comfy_root()
    }

    pub(crate) fn comfy_start_available(&self) -> bool {
        !self.shutdown.is_cancelled()
            && self.state.lock().unwrap().managed[1].desired
            && self.comfy_root().join("main.py").is_file()
            && self.comfy_python().is_file()
    }

    fn comfy_python(&self) -> std::path::PathBuf {
        let root = self.comfy_root();
        let embedded = root
            .parent()
            .unwrap_or(&self.config.ai_workspace_root)
            .join("python_embeded/python.exe");
        if embedded.is_file() {
            embedded
        } else {
            root.join("venv/Scripts/python.exe")
        }
    }

    pub(super) async fn comfy_owned(&self) -> bool {
        self.comfy_process
            .lock()
            .await
            .as_ref()
            .is_some_and(|process| process.exited().ok() == Some(None))
    }

    pub(crate) async fn ensure_comfy(self: &Arc<Self>, cancel: &CancellationToken) -> Result<()> {
        if cancel.is_cancelled() {
            return Err(ApiError::new(499, "ABORT_ERR", "生成请求已取消"));
        }
        if self.online(1, &self.runtime_settings()).await {
            // Drawing already releases our local chat from the UI. Keep the
            // same owned-only memory handoff for direct and durable API callers.
            self.stop_llama().await?;
            return Ok(());
        }
        if !self.comfy_start_available() {
            return Err(ApiError::new(
                503,
                "COMFY_UNAVAILABLE",
                "ComfyUI 未连接，请先在控制面板准备并启动受管环境",
            ));
        }
        self.stop_llama().await?;
        // Join an existing start instead of creating another process. Operations
        // remain tracked when the requesting job is cancelled or disconnected.
        let operation = {
            let state = self.state.lock().unwrap();
            state
                .operation
                .as_ref()
                .filter(|op| op["status"] == "running")
                .cloned()
        };
        let operation = if let Some(op) = operation {
            if !matches!(op["kind"].as_str(), Some("comfy-start" | "mode-draw"))
                && !(op["kind"] == "watchdog" && self.comfy_cancel.lock().unwrap().is_some())
            {
                return Err(ApiError::new(
                    409,
                    "CONTROL_BUSY",
                    "已有服务操作，请等待完成",
                ));
            }
            op
        } else {
            match self.launch("comfy-start".into()) {
                Ok(response) => response["operation"].clone(),
                Err(error) if error.code == "CONTROL_BUSY" => {
                    let current = self.state.lock().unwrap().operation.clone();
                    match current
                        .filter(|op| op["status"] == "running" && op["kind"] == "comfy-start")
                    {
                        Some(op) => op,
                        None => return Err(error),
                    }
                }
                Err(error) => return Err(error),
            }
        };
        loop {
            let current = self.state.lock().unwrap().operation.clone();
            if let Some(current) = current {
                if current["id"] != operation["id"] {
                    return Err(ApiError::new(
                        409,
                        "OPERATION_CHANGED",
                        "服务操作已改变，请重新提交生成",
                    ));
                }
                if current["status"] != "running" {
                    if current["status"] == "completed"
                        && self.online(1, &self.runtime_settings()).await
                    {
                        return Ok(());
                    }
                    return Err(ApiError::new(
                        503,
                        "COMFY_START_FAILED",
                        current["error"]
                            .as_str()
                            .filter(|s| !s.is_empty())
                            .unwrap_or("ComfyUI 启动未完成，请检查控制面板"),
                    ));
                }
            }
            tokio::select! {
                _ = cancel.cancelled() => return Err(ApiError::new(499, "ABORT_ERR", "生成请求已取消")),
                _ = self.shutdown.cancelled() => return Err(ApiError::new(503, "SHUTTING_DOWN", "运行时正在退出")),
                _ = tokio::time::sleep(Duration::from_millis(100)) => {}
            }
        }
    }

    pub(super) async fn run_comfy(&self, start: bool) -> Result<Value> {
        if !start {
            if let Some(cancel) = self.comfy_cancel.lock().unwrap().as_ref() {
                cancel.cancel();
            }
            let _action = self.comfy_action.lock().await;
            if let Some(process) = self.comfy_process.lock().await.take() {
                process.stop().await?;
            }
            return Ok(json!({"managed":false}));
        }
        let _action = self.comfy_action.lock().await;
        let images = self.images.read().unwrap().upgrade();
        let _gpu = if self.native_gpu_owned() {
            Some(
                images
                    .ok_or_else(|| {
                        ApiError::new(
                            503,
                            "NATIVE_RUNTIME_UNAVAILABLE",
                            "独立推理服务未接入，无法确认显存释放",
                        )
                    })?
                    .native_engine()
                    .comfy_handoff()
                    .await?,
            )
        } else {
            None
        };
        if self.shutdown.is_cancelled() {
            return Err(ApiError::new(503, "SHUTTING_DOWN", "运行时正在退出"));
        }
        let cancel = {
            let mut current = self.comfy_cancel.lock().unwrap();
            current
                .get_or_insert_with(|| self.shutdown.child_token())
                .clone()
        };
        if cancel.is_cancelled() {
            return Err(ApiError::new(499, "CANCELLED", "启动已取消"));
        }
        let settings = self.runtime_settings();
        if self.online(1, &settings).await {
            return Ok(json!({"managed":self.comfy_owned().await}));
        }
        // Only replace our own failed/unhealthy child; never discover or kill
        // external processes by their executable name or port.
        if let Some(process) = self.comfy_process.lock().await.take() {
            process.stop().await?;
        }
        let root = self.comfy_root();
        let python = self.comfy_python();
        if !python.is_file() || !root.join("main.py").is_file() {
            return Err(ApiError::new(
                409,
                "COMFY_ENVIRONMENT_MISSING",
                "请先一键准备 Portable 环境；外部环境可从原入口启动后连接",
            ));
        }
        let operation = self
            .state
            .lock()
            .unwrap()
            .operation
            .clone()
            .unwrap_or(Value::Null);
        if operation["kind"] == "comfy-start" {
            self.stage(&operation, 1);
        }
        self.work_progress(&operation, 0, 0, "正在启动 Python 并加载绘图节点…");
        let settings = self.runtime_settings();
        let host = settings["comfyHost"]
            .as_str()
            .unwrap_or("http://127.0.0.1:8188");
        let endpoint = crate::upstream::local_url(host)?;
        let input = self.config.ai_workspace_root.join("ComfyUI/input");
        tokio::fs::create_dir_all(&input).await?;
        let logs = self.config.runtime_root.join("logs");
        tokio::fs::create_dir_all(&logs).await?;
        let output = std::fs::File::create(logs.join("comfyui.log"))?;
        let model_paths =
            model_paths::create(&self.config.ai_workspace_root, &self.config.runtime_root)?;
        let mut command = Command::new(python);
        command
            .current_dir(&root)
            .args(["-s", "-u", "-B"])
            .arg(root.join("main.py"))
            .args([
                "--listen",
                endpoint.host_str().unwrap_or("127.0.0.1"),
                "--port",
            ])
            .arg(endpoint.port_or_known_default().unwrap_or(8188).to_string())
            .args(["--disable-auto-launch", "--input-directory"])
            .arg(&input)
            .arg("--extra-model-paths-config")
            .arg(&model_paths)
            .stdin(Stdio::null())
            .stdout(Stdio::from(output.try_clone()?))
            .stderr(Stdio::from(output));
        if super::setup_environment::managed_comfy_environment(&root)["environment"] == "comfy-amd"
        {
            // Split attention bypasses the upstream AOTriton flash capability
            // probe, which stalls startup on the accepted 880M/ROCm 7.2.1 host.
            // Keep model offload conservative for shared-memory APUs.
            command.args(["--use-split-cross-attention", "--lowvram"]);
            self.log("AMD 实验性绘图环境：分块注意力 / 低显存模式，真实出图与速度需在本机确认");
        }
        if cancel.is_cancelled() {
            return Err(ApiError::new(499, "CANCELLED", "启动已取消"));
        }
        self.stop_llama().await?;
        let process = self.processes.spawn(&mut command)?;
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            if cancel.is_cancelled() {
                process.stop().await?;
                self.comfy_cancel.lock().unwrap().take();
                return Err(ApiError::new(499, "CANCELLED", "启动已取消"));
            }
            if Instant::now() >= deadline {
                process.stop().await?;
                self.comfy_cancel.lock().unwrap().take();
                return Err(ApiError::new(
                    504,
                    "COMFY_START_STOPPED",
                    "ComfyUI 启动已停止，请查看 comfyui.log",
                ));
            }
            if process.exited()?.is_some() {
                self.comfy_cancel.lock().unwrap().take();
                return Err(ApiError::new(
                    503,
                    "COMFY_START_FAILED",
                    "ComfyUI 已退出，请查看 comfyui.log 与驱动条件",
                ));
            }
            let online = tokio::select! {
                biased;
                _ = cancel.cancelled() => continue,
                online = self.online(1, &settings) => online,
            };
            if online {
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        let mut owner = self.comfy_process.lock().await;
        if cancel.is_cancelled() {
            process.stop().await?;
            return Err(ApiError::new(499, "CANCELLED", "启动已取消"));
        }
        *owner = Some(process);
        self.comfy_cancel.lock().unwrap().take();
        Ok(json!({"managed":true}))
    }

    pub(super) async fn release_comfy_models(&self) -> Result<()> {
        if !self.comfy_owned().await {
            return Ok(());
        }
        let settings = self.runtime_settings();
        let host = settings["comfyHost"].as_str().unwrap_or("");
        let (status, queue) = self.request(host, "/queue", None, 3).await?;
        if !(200..300).contains(&status)
            || queue.as_ref().is_none_or(|q| {
                ["queue_running", "queue_pending"]
                    .iter()
                    .any(|key| q[*key].as_array().is_none_or(|items| !items.is_empty()))
            })
        {
            return Err(ApiError::new(
                409,
                "DRAWING_BUSY",
                "绘图任务尚未结束，请稍后开启本地聊天或改用 API",
            ));
        }
        let (status, _) = self
            .request(
                host,
                "/free",
                Some(&json!({"unload_models":true,"free_memory":true})),
                5,
            )
            .await?;
        if !(200..300).contains(&status) {
            return Err(ApiError::new(
                503,
                "COMFY_RELEASE_FAILED",
                "绘图显存释放未确认，请查看控制室",
            ));
        }
        Ok(())
    }
    pub(super) fn native_gpu_owned(&self) -> bool {
        self.images
            .read()
            .unwrap()
            .upgrade()
            .is_some_and(|images| images.native_gpu_owned())
    }
    pub(super) async fn stop_comfy_for_native(&self) -> Result<()> {
        // /free acknowledges a queued request; it is not proof of CUDA release.
        // The retained managed process handle can positively confirm termination.
        if let Some(cancel) = self.comfy_cancel.lock().unwrap().as_ref() {
            cancel.cancel();
        }
        let _action = self.comfy_action.lock().await;
        self.comfy_cancel.lock().unwrap().take();
        let managed = {
            let owner = self.comfy_process.lock().await;
            owner.as_ref().map(|process| process.exited()).transpose()?
        };
        if matches!(managed, Some(None)) {
            let settings = self.runtime_settings();
            let (status, queue) = self
                .request(
                    settings["comfyHost"].as_str().unwrap_or(""),
                    "/queue",
                    None,
                    3,
                )
                .await?;
            if !(200..300).contains(&status)
                || queue.as_ref().is_none_or(|queue| {
                    ["queue_running", "queue_pending"]
                        .iter()
                        .any(|key| queue[*key].as_array().is_none_or(|items| !items.is_empty()))
                })
            {
                return Err(ApiError::new(
                    409,
                    "DRAWING_BUSY",
                    "ComfyUI 仍有任务，暂不能切换独立推理",
                ));
            }
        }
        if managed.is_some() {
            if let Some(process) = self.comfy_process.lock().await.take() {
                process.stop().await?;
            }
        }
        let settings = self.runtime_settings();
        let host = settings["comfyHost"].as_str().unwrap_or("").to_owned();
        let listening = tokio::task::spawn_blocking(move || listener::present(&host))
            .await
            .ok()
            .flatten();
        if listening != Some(false) && self.online(1, &settings).await {
            return Err(ApiError::new(
                409,
                "COMFY_RELEASE_UNCONFIRMED",
                "外部 ComfyUI 仍在运行，无法确认显存释放；请先停止它再切换独立推理",
            ));
        }
        Ok(())
    }
}
