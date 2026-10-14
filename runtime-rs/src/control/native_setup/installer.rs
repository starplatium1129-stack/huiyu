use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

impl ControlService {
    pub(super) async fn run_native_installer(
        &self,
        command: &mut tokio::process::Command,
        cancel: &CancellationToken,
        operation: &Value,
    ) -> Result<Value> {
        stopped(cancel)?;
        let process = self.processes.spawn(command)?;
        let mut input = process
            .take_input()
            .ok_or_else(|| ApiError::invalid("安装器输入通道不可用"))?;
        let (stdout, stderr) = process.take_output();
        let protected = AtomicBool::new(false);
        let work = async {
            let output = async {
                let mut bytes = Vec::new();
                stdout
                    .ok_or_else(|| ApiError::invalid("安装器输出通道不可用"))?
                    .take(131073)
                    .read_to_end(&mut bytes)
                    .await?;
                if bytes.len() > 131072 {
                    return Err(ApiError::invalid("安装器返回过大的结果"));
                }
                Ok::<_, ApiError>(bytes)
            };
            let progress = async {
                let mut reader = BufReader::new(
                    stderr.ok_or_else(|| ApiError::invalid("安装器进度通道不可用"))?,
                );
                let mut error = String::new();
                let mut bytes = Vec::new();
                let mut total = 0;
                loop {
                    bytes.clear();
                    let count = (&mut reader)
                        .take(8193)
                        .read_until(b'\n', &mut bytes)
                        .await?;
                    if count == 0 {
                        break;
                    }
                    total += count;
                    if bytes.len() > 8192 || total > 65536 {
                        return Err(ApiError::invalid("安装器进度超过限制"));
                    }
                    let line = String::from_utf8_lossy(&bytes).trim().to_owned();
                    if line == "HUIYU:VC_BEGIN" {
                        // The acknowledgement closes the cancel/UAC race: the
                        // Windows installer cannot launch before the state lock
                        // disables app cancellation and checks any earlier intent.
                        {
                            let mut state = self.state.lock().unwrap();
                            stopped(cancel)?;
                            let current = state
                                .operation
                                .as_mut()
                                .filter(|value| value["id"] == operation["id"])
                                .ok_or_else(|| {
                                    ApiError::new(409, "OPERATION_CHANGED", "准备操作已改变")
                                })?;
                            current["cancelAllowed"] = json!(false);
                            current["message"] =
                                json!("Windows 正在安装 VC++ 共享组件；请在安装器中取消或等待结束");
                            protected.store(true, Ordering::Release);
                        }
                        input.write_all(b"continue\n").await?;
                        input.flush().await?;
                    } else if line == "HUIYU:VC_END" {
                        protected.store(false, Ordering::Release);
                        self.native_progress(operation, json!({"cancelAllowed":true}));
                        stopped(cancel)?;
                    } else if !line.is_empty() {
                        error.push_str(&line);
                        error.push('\n');
                        let phase = if line.contains("校验") {
                            "validating"
                        } else {
                            "installing"
                        };
                        self.native_progress(
                            operation,
                            json!({"stage":phase,"message":self.redact(&line)}),
                        );
                    }
                }
                Ok::<_, ApiError>(error)
            };
            let (out, error) = tokio::try_join!(output, progress)?;
            let success = loop {
                if let Some(success) = process.exited()? {
                    break success;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            };
            if !success {
                return Err(ApiError::new(
                    503,
                    "NATIVE_INSTALL_FAILED",
                    self.redact(&error)
                        .chars()
                        .rev()
                        .take(2000)
                        .collect::<String>()
                        .chars()
                        .rev()
                        .collect::<String>(),
                ));
            }
            let value: Value = serde_json::from_slice(&out)?;
            if value["engine"] != "native" || value["environment"]["cudaAvailable"] != true {
                return Err(ApiError::new(
                    502,
                    "NATIVE_SETUP_PROTOCOL",
                    "安装器未返回可用环境记录",
                ));
            }
            Ok(value)
        };
        tokio::pin!(work);
        let result = tokio::select! {
            result = &mut work => result,
            _ = cancel.cancelled() => {
                if protected.load(Ordering::Acquire) { let _ = (&mut work).await; }
                Err(ApiError::new(499,"CANCELLED","准备已取消，已安装的系统共享 VC++ 组件保留，未完成运行库不标记可用"))
            }
            _ = tokio::time::sleep(Duration::from_secs(3600)) => {
                if protected.load(Ordering::Acquire) { let _ = (&mut work).await; }
                Err(ApiError::new(504,"NATIVE_INSTALL_TIMEOUT","运行库安装超时，请检查 Windows 安装器或磁盘后重试"))
            }
        };
        process.stop().await?;
        self.native_progress(operation, json!({"cancelAllowed":true}));
        result
    }
}
