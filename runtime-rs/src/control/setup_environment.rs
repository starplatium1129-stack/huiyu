use super::setup_verify::{inspect, model_file, model_root};
use super::*;
use serde::Deserialize;
use std::process::Stdio;
use tokio::process::Command;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct EnvironmentRequest {
    workspace_path: String,
    reviewed: bool,
}

impl ControlService {
    pub(super) fn prepare_environment(
        self: &Arc<Self>,
        environment: String,
        body: EnvironmentRequest,
    ) -> Result<Value> {
        if !body.reviewed || body.workspace_path != self.config.ai_workspace_root.to_string_lossy()
        {
            return Err(ApiError::new(
                409,
                "WORKSPACE_CHANGED",
                "请确认当前工作区与准备清单",
            ));
        }
        let mut files = match environment.as_str() {
            "llama-cuda" => vec!["runtime-llama-cuda", "runtime-llama-cudart"],
            "llama-vulkan" => vec!["runtime-llama-vulkan"],
            "comfy-nvidia" => vec![
                "runtime-comfy-nvidia",
                "runtime-kjnodes",
                "runtime-anima-teacache",
            ],
            "comfy-cu126" => vec![
                "runtime-comfy-cu126",
                "runtime-kjnodes",
                "runtime-anima-teacache",
            ],
            _ => return Err(ApiError::invalid("未知受管环境")),
        };
        if environment.starts_with("comfy-") && self.comfy_root().join("main.py").is_file() {
            files.remove(0);
        }
        let permit = self
            .setup_verify_lock
            .clone()
            .try_acquire_owned()
            .map_err(|_| ApiError::new(409, "SETUP_BUSY", "已有准备、下载或校验正在进行"))?;
        let operation = self.begin(
            "prepare-environment",
            &["正在校验运行包", "正在解压与准备依赖", "正在确认环境"],
        )?;
        let response = json!({"ok":true,"operation":operation});
        let cancel = self.shutdown.child_token();
        *self.environment_cancel.lock().unwrap() = Some(cancel.clone());
        let service = self.clone();
        self.tasks.spawn(async move {
            let _permit = permit;
            let work = service
                .install_environment(&environment, &files, &operation, &cancel)
                .await;
            service.environment_cancel.lock().unwrap().take();
            service.finish(&operation, work);
        });
        Ok(response)
    }

    pub(super) fn cancel_environment(&self, operation_id: Option<&str>) -> Result<Value> {
        if let Some(id) = operation_id {
            if self
                .state
                .lock()
                .unwrap()
                .operation
                .as_ref()
                .is_none_or(|operation| operation["id"] != id)
            {
                return Err(ApiError::new(
                    409,
                    "OPERATION_CHANGED",
                    "原准备操作已结束或改变",
                ));
            }
        }
        if let Some(cancel) = self.environment_cancel.lock().unwrap().as_ref() {
            cancel.cancel();
        }
        if let Some(cancel) = self.comfy_cancel.lock().unwrap().as_ref() {
            cancel.cancel();
        }
        if let Some(cancel) = self.llama_cancel.lock().unwrap().as_ref() {
            cancel.cancel();
        }
        Ok(json!({"ok":true}))
    }

    async fn install_environment(
        &self,
        environment: &str,
        ids: &[&str],
        operation: &Value,
        cancel: &CancellationToken,
    ) -> Result<()> {
        #[cfg(not(windows))]
        return Err(ApiError::new(
            400,
            "WINDOWS_REQUIRED",
            "自动环境准备适用于 Windows 桌面",
        ));
        #[cfg(windows)]
        {
            let path_for = |id: &str| -> Result<std::path::PathBuf> {
                Ok(model_root(&self.config.ai_workspace_root, id)?.join(model_file(id)?.path))
            };
            for id in ids {
                let root = model_root(&self.config.ai_workspace_root, id)?;
                let spec = model_file(id)?;
                let token = cancel.clone();
                let identity = (*id).to_owned();
                let verified = tokio::task::spawn_blocking(move || {
                    let (sender, _receiver) = tokio::sync::mpsc::unbounded_channel();
                    // Keep a receiver alive during inspection; no synthetic download progress.
                    inspect(&root, &spec, &identity, &sender, &token)
                })
                .await
                .map_err(|_| ApiError::new(503, "ENVIRONMENT_VERIFY_FAILED", "运行包校验未完成"))?;
                if verified["state"] != "sha256-match" {
                    return Err(ApiError::new(
                        409,
                        "ENVIRONMENT_PACKAGE_MISSING",
                        format!("请先下载或重新校验 {id}"),
                    ));
                }
            }
            if cancel.is_cancelled() {
                return Err(ApiError::new(499, "CANCELLED", "环境准备已取消"));
            }
            self.stage(operation, 1);
            let mut command = Command::new("powershell.exe");
            command
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                ])
                .arg(
                    self.config
                        .app_root
                        .join("scripts/lib/prepare-ai-environment.ps1"),
                )
                .arg("-Workspace")
                .arg(&self.config.ai_workspace_root)
                .arg("-Environment")
                .arg(environment)
                .arg("-Archive")
                .arg(path_for(&format!("runtime-{environment}"))?)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            if environment == "llama-cuda" {
                command
                    .arg("-CudaArchive")
                    .arg(path_for("runtime-llama-cudart")?);
            }
            if environment.starts_with("comfy-") {
                command
                    .arg("-KjArchive")
                    .arg(path_for("runtime-kjnodes")?)
                    .arg("-TeaArchive")
                    .arg(path_for("runtime-anima-teacache")?);
            }
            let process = self.processes.spawn(&mut command)?;
            let (stdout, stderr) = process.take_output();
            let output_token = cancel.child_token();
            let (out, err) = match tokio::time::timeout(Duration::from_secs(3600), async {
                tokio::join!(
                    actions::output(stdout, output_token.clone()),
                    actions::output(stderr, output_token)
                )
            })
            .await
            {
                Ok(output) => output,
                Err(_) => {
                    process.stop().await?;
                    return Err(ApiError::new(
                        504,
                        "ENVIRONMENT_TIMEOUT",
                        "环境准备超过一小时，已停止，请查看控制室日志",
                    ));
                }
            };
            if cancel.is_cancelled() {
                process.stop().await?;
                return Err(ApiError::new(
                    499,
                    "CANCELLED",
                    "环境准备已取消，已有文件保留",
                ));
            }
            let mut status = process.exited()?;
            let exit_deadline = Instant::now() + Duration::from_secs(2);
            while status.is_none() && Instant::now() < exit_deadline {
                tokio::time::sleep(Duration::from_millis(20)).await;
                status = process.exited()?;
            }
            if status != Some(true) {
                self.log(&String::from_utf8_lossy(&err));
                process.stop().await?;
                return Err(ApiError::new(
                    503,
                    "ENVIRONMENT_PREPARE_FAILED",
                    self.redact(
                        &String::from_utf8_lossy(&err)
                            .chars()
                            .take(1000)
                            .collect::<String>(),
                    ),
                ));
            }
            self.log(&String::from_utf8_lossy(&out));
            self.stage(operation, 2);
            Ok(())
        }
    }
}
