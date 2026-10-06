use super::*;
use serde::Deserialize;
use std::process::Stdio;
use tokio::process::Command;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StartRequest {
    model_id: String,
    workspace_path: String,
}

impl ControlService {
    pub(crate) fn llama_auth(&self) -> (String, String) {
        let host = self.settings()["llamaHost"]
            .as_str()
            .unwrap_or("http://127.0.0.1:8000")
            .to_owned();
        (
            host.trim_end_matches('/').to_owned(),
            self.llama_secret.clone(),
        )
    }
    pub(super) async fn ensure_llama(self: &Arc<Self>, base_url: &str) -> Result<Value> {
        let host = self.settings()["llamaHost"]
            .as_str()
            .unwrap_or("http://127.0.0.1:8000")
            .to_owned();
        if base_url.trim_end_matches('/') != format!("{}/v1", host.trim_end_matches('/')) {
            return Err(ApiError::invalid("聊天地址与受管 llama.cpp 不一致"));
        }
        let owned = self
            .llama_process
            .lock()
            .await
            .as_ref()
            .is_some_and(|p| p.exited().ok() == Some(None));
        if owned
            && self
                .request(&host, "/health", None, 2)
                .await
                .is_ok_and(|(s, _)| (200..300).contains(&s))
        {
            return Ok(json!({"ok":true,"ready":true}));
        }
        let model = self.settings()["llamaModel"]
            .as_str()
            .unwrap_or("")
            .to_owned();
        if model.is_empty() {
            return Err(ApiError::new(
                409,
                "LLAMA_NOT_CONFIGURED",
                "请在首次配置中准备本地聊天模型",
            ));
        }
        self.start_llama(StartRequest {
            model_id: model,
            workspace_path: self.config.ai_workspace_root.to_string_lossy().into_owned(),
        })
    }

    pub(super) async fn llama_status(&self) -> Value {
        let host = self.settings()["llamaHost"]
            .as_str()
            .unwrap_or("http://127.0.0.1:8000")
            .to_owned();
        let online = self
            .request(&host, "/health", None, 2)
            .await
            .is_ok_and(|(status, _)| (200..300).contains(&status));
        let owned = self
            .llama_process
            .lock()
            .await
            .as_ref()
            .is_some_and(|process| process.exited().ok() == Some(None));
        let model = self.settings()["llamaModel"].clone();
        let label = model
            .as_str()
            .and_then(|id| setup_verify::model_source(id).ok())
            .and_then(|source| source["label"].as_str().map(str::to_owned))
            .unwrap_or_default();
        json!({"host":host,"online":online,"managed":owned,"model":model,"label":label})
    }

    pub(super) fn start_llama(self: &Arc<Self>, body: StartRequest) -> Result<Value> {
        if body.workspace_path != self.config.ai_workspace_root.to_string_lossy() {
            return Err(ApiError::new(
                409,
                "WORKSPACE_CHANGED",
                "工作区已改变，请重新检查",
            ));
        }
        let source = setup_verify::model_source(&body.model_id)?;
        if source["kind"] != "chat" {
            return Err(ApiError::invalid("请选择已登记的聊天模型"));
        }
        let operation = self.begin(
            "llama-start",
            &["正在检查聊天环境", "正在加载聊天模型", "正在确认连接"],
        )?;
        let response = json!({"ok":true,"operation":operation,"baseUrl":format!("{}/v1",self.settings()["llamaHost"].as_str().unwrap_or("http://127.0.0.1:8000")),"model":"huiyu-local"});
        let cancel = self.shutdown.child_token();
        *self.llama_cancel.lock().unwrap() = Some(cancel.clone());
        let service = self.clone();
        self.tasks.spawn(async move {
            let result = service
                .launch_llama(&body.model_id, &operation, &cancel)
                .await;
            service.llama_cancel.lock().unwrap().take();
            service.finish(&operation, result);
        });
        Ok(response)
    }

    pub(super) async fn stop_llama(&self) -> Result<()> {
        if let Some(cancel) = self.llama_cancel.lock().unwrap().as_ref() {
            cancel.cancel();
        }
        if let Some(process) = self.llama_process.lock().await.take() {
            process.stop().await?;
        }
        Ok(())
    }

    async fn launch_llama(
        &self,
        id: &str,
        operation: &Value,
        cancel: &CancellationToken,
    ) -> Result<()> {
        if let Some(process) = self.llama_process.lock().await.take() {
            process.stop().await?;
        }
        let settings = self.settings();
        let host = settings["llamaHost"]
            .as_str()
            .unwrap_or("http://127.0.0.1:8000");
        let endpoint = crate::upstream::local_url(host)?;
        if self.request(host, "/health", None, 2).await.is_ok() {
            return Err(ApiError::new(
                409,
                "LLAMA_EXTERNAL_RUNNING",
                "此地址已有服务，请在自定义 API 中连接，或先关闭原服务",
            ));
        }
        self.release_comfy_models().await?;
        let root = self.config.ai_workspace_root.join("Chat");
        let executable = root.join("runtime/llama-server.exe");
        let spec = setup_verify::model_file(id)?;
        let model = root.join("models").join(&spec.path);
        if !executable.is_file() {
            return Err(ApiError::new(
                409,
                "LLAMA_RUNTIME_MISSING",
                "请先一键准备本地聊天运行环境",
            ));
        }
        if std::fs::metadata(&model).map_or(true, |m| !m.is_file() || m.len() != spec.bytes) {
            return Err(ApiError::new(
                409,
                "LLAMA_MODEL_MISSING",
                "聊天模型未完整准备，请下载并校验",
            ));
        }
        let log_root = self.config.runtime_root.join("logs");
        tokio::fs::create_dir_all(&log_root).await?;
        let log = std::fs::File::create(log_root.join("llama-server.log"))?;
        let mut command = Command::new(executable);
        command
            .current_dir(root.join("runtime"))
            .env("LLAMA_API_KEY", &self.llama_secret)
            .arg("--model")
            .arg(model)
            .args([
                "--alias",
                "huiyu-local",
                "--host",
                endpoint.host_str().unwrap_or("127.0.0.1"),
                "--port",
            ])
            .arg(endpoint.port_or_known_default().unwrap_or(8000).to_string())
            .args([
                "--ctx-size",
                "4096",
                "--n-gpu-layers",
                "999",
                "--fit",
                "on",
                "--jinja",
                "--reasoning",
                "off",
                "--chat-template-kwargs",
                "{\"enable_thinking\":false}",
                "--sleep-idle-seconds",
                "300",
                "--no-webui",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::from(log.try_clone()?))
            .stderr(Stdio::from(log));
        self.stage(operation, 1);
        let process = self.processes.spawn(&mut command)?;
        let deadline = Instant::now() + Duration::from_secs(180);
        loop {
            if cancel.is_cancelled() || Instant::now() >= deadline {
                process.stop().await?;
                return Err(ApiError::new(
                    if cancel.is_cancelled() { 499 } else { 504 },
                    "LLAMA_LOAD_STOPPED",
                    "聊天模型加载已停止；可选择更小模型或 API，详情见 llama-server.log",
                ));
            }
            if process.exited()?.is_some() {
                return Err(ApiError::new(
                    503,
                    "LLAMA_LOAD_FAILED",
                    "聊天服务已退出，请查看 llama-server.log 并核对驱动与显存",
                ));
            }
            if self
                .request(host, "/health", None, 2)
                .await
                .is_ok_and(|(s, _)| (200..300).contains(&s))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        let mut owner = self.llama_process.lock().await;
        if cancel.is_cancelled() {
            process.stop().await?;
            return Err(ApiError::new(499, "CANCELLED", "聊天模型加载已取消"));
        }
        *owner = Some(process);
        drop(owner);
        self.patch(json!({"llamaModel":id})).await?;
        self.settings.write().unwrap()["llamaModel"] = json!(id);
        self.stage(operation, 2);
        Ok(())
    }
}
