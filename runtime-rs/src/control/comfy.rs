use super::*;
use std::process::Stdio;
use tokio::process::Command;

impl ControlService {
    pub(super) fn comfy_root(&self) -> std::path::PathBuf {
        let existing = self.config.ai_workspace_root.join("ComfyUI");
        if existing.join("main.py").is_file() {
            existing
        } else {
            self.config
                .ai_workspace_root
                .join(".runtimes/comfy/ComfyUI")
        }
    }

    pub(super) fn saved_comfy_intent(&self) -> bool {
        let saved = self.saved.read().unwrap();
        let managed = &saved["managedServices"];
        let host = managed["comfyHost"]
            .as_str()
            .or_else(|| saved["comfyHost"].as_str())
            .unwrap_or("http://127.0.0.1:8188");
        managed["comfy"] == true
            && crate::upstream::local_url(host).ok()
                == crate::upstream::local_url(&self.config.comfy_host).ok()
            && managed["comfyRoot"]
                .as_str()
                .is_none_or(|root| std::path::Path::new(root) == self.comfy_root())
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
        if !self.comfy_start_available() {
            return Err(ApiError::new(
                503,
                "COMFY_UNAVAILABLE",
                "ComfyUI 未连接，请先在控制面板准备并启动受管环境",
            ));
        }
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
                    if current["status"] == "completed" && self.online(1, &self.settings()).await {
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
        let settings = self.settings();
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
        let settings = self.settings();
        let host = settings["comfyHost"]
            .as_str()
            .unwrap_or("http://127.0.0.1:8188");
        let endpoint = crate::upstream::local_url(host)?;
        let input = self.config.ai_workspace_root.join("ComfyUI/input");
        tokio::fs::create_dir_all(&input).await?;
        let logs = self.config.runtime_root.join("logs");
        tokio::fs::create_dir_all(&logs).await?;
        let output = std::fs::File::create(logs.join("comfyui.log"))?;
        let mut command = Command::new(python);
        command
            .current_dir(&root)
            .args(["-s", "-u"])
            .arg(root.join("main.py"))
            .args([
                "--listen",
                endpoint.host_str().unwrap_or("127.0.0.1"),
                "--port",
            ])
            .arg(endpoint.port_or_known_default().unwrap_or(8188).to_string())
            .args(["--disable-auto-launch", "--input-directory"])
            .arg(&input)
            .stdin(Stdio::null())
            .stdout(Stdio::from(output.try_clone()?))
            .stderr(Stdio::from(output));
        if cancel.is_cancelled() {
            return Err(ApiError::new(499, "CANCELLED", "启动已取消"));
        }
        self.stop_llama().await?;
        let process = self.processes.spawn(&mut command)?;
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            if cancel.is_cancelled() || Instant::now() >= deadline {
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
            if self.online(1, &settings).await {
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
        let settings = self.settings();
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
}

#[cfg(test)]
mod tests;
