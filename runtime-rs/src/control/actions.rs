use super::*;
use std::{path::PathBuf, process::Stdio};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

async fn output<R: AsyncRead + Unpin>(stream: Option<R>, cancel: CancellationToken) -> Vec<u8> {
    let Some(mut stream) = stream else {
        return vec![];
    };
    let mut data = Vec::new();
    let mut buffer = [0u8; 4096];
    loop {
        let read = tokio::select! {r=stream.read(&mut buffer)=>r,_=cancel.cancelled()=>break};
        match read {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let remaining = (64 * 1024usize).saturating_sub(data.len());
                data.extend_from_slice(&buffer[..n.min(remaining)]);
            }
        }
    }
    data
}
impl ControlService {
    pub(super) fn script(&self, index: usize, start: bool) -> PathBuf {
        match index {
            0 => self.config.app_root.join("scripts/lib/managed-webui.ps1"),
            1 => self.config.app_root.join("scripts/lib/managed-comfyui.ps1"),
            _ => self.config.ai_workspace_root.join(if start {
                "Voice/Start-Voice.ps1"
            } else {
                "Voice/Stop-Voice.ps1"
            }),
        }
    }
    fn args(&self, index: usize, start: bool, settings: &Value) -> Vec<String> {
        let path = |s: &str| {
            self.config
                .ai_workspace_root
                .join(s)
                .to_string_lossy()
                .into_owned()
        };
        if index == 2 {
            return if start {
                vec!["-WaitSeconds".into(), "60".into()]
            } else {
                vec![]
            };
        }
        let mut args = vec![
            "-Action".into(),
            if start { "Start".into() } else { "Stop".into() },
            "-RuntimeRoot".into(),
            self.config.runtime_root.to_string_lossy().into_owned(),
        ];
        if index == 0 {
            args.extend([
                "-PackageRoot".into(),
                path("Data/Packages/Stable Diffusion WebUI reForge"),
                "-WebuiHost".into(),
                settings["sdHost"].as_str().unwrap_or("").into(),
                "-ImagesRoot".into(),
                path("Data/Images"),
                "-ControlNetRoot".into(),
                path("Data/Models/ControlNet"),
            ]);
        } else {
            args.extend([
                "-AIWorkspaceRoot".into(),
                self.config.ai_workspace_root.to_string_lossy().into_owned(),
                "-ComfyHost".into(),
                settings["comfyHost"].as_str().unwrap_or("").into(),
            ]);
        }
        args
    }
    pub(super) async fn run_script(
        &self,
        path: PathBuf,
        args: Vec<String>,
        seconds: u64,
    ) -> Result<Value> {
        if !path.is_file() {
            return Err(ApiError::new(
                503,
                "SCRIPT_UNAVAILABLE",
                "服务管理脚本未安装",
            ));
        }
        let mut command = Command::new("powershell.exe");
        command
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(path)
            .args(args)
            .current_dir(&self.config.app_root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        self.run_command(command, seconds).await
    }
    pub(super) async fn run_command(&self, mut command: Command, seconds: u64) -> Result<Value> {
        let process = self.processes.spawn(&mut command)?;
        let (stdout, stderr) = process.take_output();
        let stop = self.shutdown.child_token();
        let out = output(stdout, stop.clone());
        let err = output(stderr, stop.clone());
        let wait = async {
            let result = tokio::select! {
            r=tokio::time::timeout(Duration::from_secs(seconds),async {loop {if let Some(ok)=process.exited()?{break Ok::<bool,ApiError>(ok);}tokio::time::sleep(Duration::from_millis(40)).await;}})=>r.map_err(|_|ApiError::new(504,"CONTROL_TIMEOUT","服务操作超时")).and_then(|r|r),
            _=self.shutdown.cancelled()=>Err(ApiError::new(499,"ABORTED","服务操作已取消"))};
            if result.is_err() {
                let _ = process.stop().await;
            }
            // Descendants may inherit pipe handles after a successful script
            // exits. Drain briefly, then cancel readers instead of hanging.
            tokio::time::sleep(Duration::from_millis(30)).await;
            stop.cancel();
            result
        };
        let (out, err, result) = tokio::join!(out, err, wait);
        let ok = result?;
        let out = String::from_utf8_lossy(&out)
            .trim()
            .trim_start_matches('\u{feff}')
            .to_string();
        let parsed = serde_json::from_str::<Value>(&out)
            .ok()
            .or_else(|| {
                out.lines()
                    .rev()
                    .find_map(|line| serde_json::from_str(line).ok())
            })
            .unwrap_or(json!({}));
        if !ok || parsed["ok"] == false {
            return Err(ApiError::new(
                502,
                "CONTROL_FAILED",
                self.redact(if err.is_empty() {
                    &out
                } else {
                    std::str::from_utf8(&err).unwrap_or("服务脚本失败")
                }),
            ));
        }
        Ok(parsed)
    }
    pub(super) async fn service_action(&self, index: usize, start: bool, op: &Value) -> Result<()> {
        if index == 3 {
            tokio::select! {result=self.voice.prepare_translation()=>result?,_=self.shutdown.cancelled()=>return Err(ApiError::new(499,"ABORTED","翻译恢复已取消"))};
            if !self.online(3, &Value::Null).await {
                return Err(ApiError::new(
                    502,
                    "TRANSLATION_UNAVAILABLE",
                    "翻译服务未通过健康检查",
                ));
            }
            return Ok(());
        }
        let settings = self.settings();
        if !start {
            {
                let mut state = self.state.lock().unwrap();
                state.managed[index].desired = false;
                state.managed[index].next = None;
            }
            self.save_managed().await?;
        }
        if start && self.online(index, &settings).await {
            if !op["kind"]
                .as_str()
                .is_some_and(|kind| kind.starts_with("mode-"))
            {
                self.stage(op, 1);
            }
            return Ok(());
        }
        let seconds = match (index, start) {
            (0, true) => 360,
            (2, true) => 90,
            (2, false) => 30,
            _ => 120,
        };
        let result = self
            .run_script(
                self.script(index, start),
                self.args(index, start, &settings),
                seconds,
            )
            .await;
        if self.shutdown.is_cancelled() {
            return Err(ApiError::new(499, "ABORTED", "服务操作已取消"));
        }
        if !op["kind"]
            .as_str()
            .is_some_and(|kind| kind.starts_with("mode-"))
        {
            self.stage(op, 1);
        }
        let online = self.online(index, &settings).await;
        if online != start {
            return Err(result.err().unwrap_or_else(|| {
                ApiError::new(
                    502,
                    "SERVICE_STATE_UNCONFIRMED",
                    "脚本结束，但服务未达到目标状态",
                )
            }));
        }
        let owned = start
            && result
                .as_ref()
                .is_ok_and(|v| index == 2 || v["managed"] == true);
        {
            let mut state = self.state.lock().unwrap();
            let m = &mut state.managed[index];
            m.owned = owned;
            m.desired = owned;
            state.health_at = None;
        }
        self.save_managed().await?;
        self.log(if start {
            "服务已启动并通过健康检查"
        } else {
            "服务已停止"
        });
        Ok(())
    }
    async fn save_managed(&self) -> Result<()> {
        let managed = {
            let state = self.state.lock().unwrap();
            json!({"webui":state.managed[0].desired,"comfy":state.managed[1].desired})
        };
        self.patch(json!({"managedServices":managed})).await?;
        Ok(())
    }
    pub(super) async fn unload(&self) -> Result<()> {
        let settings = self.settings();
        let host = settings["ollamaHost"].as_str().unwrap_or("");
        let (status, data, _) = self.request(host, "/api/ps", None, 4).await?;
        if !(200..300).contains(&status) {
            return Err(ApiError::new(502, "OLLAMA_UNAVAILABLE", "Ollama 未响应"));
        }
        let data = data.unwrap_or(Value::Null);
        for model in data["models"].as_array().into_iter().flatten() {
            let Some(name) = model["name"].as_str().or_else(|| model["model"].as_str()) else {
                continue;
            };
            let (status, _, _) = self
                .request(
                    host,
                    "/api/generate",
                    Some(&json!({"model":name,"keep_alive":0,"stream":false})),
                    20,
                )
                .await?;
            if !(200..300).contains(&status) {
                return Err(ApiError::new(
                    502,
                    "OLLAMA_UNLOAD_FAILED",
                    "聊天模型未完成卸载",
                ));
            }
        }
        let (status, data, _) = self.request(host, "/api/ps", None, 4).await?;
        if !(200..300).contains(&status)
            || data
                .as_ref()
                .and_then(|v| v["models"].as_array())
                .is_none_or(|v| !v.is_empty())
        {
            return Err(ApiError::new(
                502,
                "OLLAMA_UNLOAD_UNCONFIRMED",
                "无法确认聊天模型已全部卸载",
            ));
        }
        Ok(())
    }
    pub(super) fn launch(self: &Arc<Self>, kind: String) -> Result<Value> {
        let stages = if kind == "mode-draw" {
            vec![
                "正在停止语音服务",
                "正在卸载聊天模型",
                "正在启动绘图服务",
                "正在验证绘图环境",
            ]
        } else if kind == "mode-chat" {
            vec!["正在释放受管 WebUI", "正在启动语音服务", "正在验证聊天环境"]
        } else {
            vec!["正在操作服务", "正在验证服务状态"]
        };
        let op = self.begin(&kind, &stages)?;
        let response = json!({"ok":true,"pending":true,"operation":op,"message":"操作已开始"});
        let service = self.clone();
        self.tasks.spawn(async move {
            let work = async {
                match kind.as_str() {
                    "ollama-unload" => service.unload().await,
                    "mode-draw" => {
                        service.service_action(2, false, &op).await?;
                        service.stage(&op, 1);
                        service.unload().await?;
                        service.stage(&op, 2);
                        service.service_action(0, true, &op).await?;
                        service.stage(&op, 3);
                        Ok(())
                    }
                    "mode-chat" => {
                        let owned = service.state.lock().unwrap().managed[0].owned;
                        if owned {
                            service.service_action(0, false, &op).await?;
                        }
                        service.stage(&op, 1);
                        service.service_action(2, true, &op).await?;
                        service.stage(&op, 2);
                        Ok(())
                    }
                    _ => {
                        let (name, action) = kind
                            .split_once('-')
                            .ok_or_else(|| ApiError::invalid("Invalid operation"))?;
                        let index = match name {
                            "webui" => 0,
                            "comfy" => 1,
                            _ => 2,
                        };
                        service.service_action(index, action == "start", &op).await
                    }
                }
            };
            let result = work.await;
            service.finish(&op, result);
        });
        Ok(response)
    }
}
