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

    pub(super) async fn run_comfy(&self, start: bool) -> Result<Value> {
        if !start {
            if let Some(cancel) = self.comfy_cancel.lock().unwrap().as_ref() {
                cancel.cancel();
            }
            if let Some(process) = self.comfy_process.lock().await.take() {
                process.stop().await?;
            }
            return Ok(json!({"managed":false}));
        }
        let workspace = &self.config.ai_workspace_root;
        let root = self.comfy_root();
        let embedded = root
            .parent()
            .unwrap_or(workspace)
            .join("python_embeded/python.exe");
        let python = if embedded.is_file() {
            embedded
        } else {
            root.join("venv/Scripts/python.exe")
        };
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
            .args(["--disable-auto-launch"])
            .stdin(Stdio::null())
            .stdout(Stdio::from(output.try_clone()?))
            .stderr(Stdio::from(output));
        let cancel = self.shutdown.child_token();
        *self.comfy_cancel.lock().unwrap() = Some(cancel.clone());
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
        if self.comfy_process.lock().await.is_none() {
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
