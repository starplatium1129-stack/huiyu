use super::*;
use crate::task_contract::{ResultState, TaskKind, TaskRecord, TaskStatus};
use reqwest::Method;
use sha2::{Digest, Sha256};

pub(crate) struct RecoveryTask<'a> {
    pub task_id: &'a str,
    pub principal_id: &'a str,
    pub kind: TaskKind,
    pub provider: &'a str,
    pub upstream_id: Option<&'a str>,
    pub status: &'static str,
    pub cancel_requested: bool,
    pub result_available: bool,
    pub metadata: &'a serde_json::Map<String, Value>,
    pub checkpoint: Option<&'a Value>,
}
impl<'a> From<&'a TaskRecord> for RecoveryTask<'a> {
    fn from(task: &'a TaskRecord) -> Self {
        Self {
            task_id: &task.task_id,
            principal_id: &task.principal_id,
            kind: task.kind,
            provider: &task.provider,
            upstream_id: task.upstream_id.as_deref(),
            status: match task.status {
                TaskStatus::Queued => "queued",
                TaskStatus::Submitting => "submitting",
                TaskStatus::Running => "running",
                TaskStatus::Cancelling => "cancelling",
                TaskStatus::Succeeded => "succeeded",
                TaskStatus::Failed => "failed",
                TaskStatus::Cancelled => "cancelled",
            },
            cancel_requested: task.cancel_requested_at.is_some(),
            result_available: task.result_state == ResultState::Available,
            metadata: &task.metadata,
            checkpoint: task.checkpoint.as_deref(),
        }
    }
}

impl Service {
    pub(crate) async fn resume_prepared(
        &self,
        frozen: Value,
        provider: &str,
        cancel: CancellationToken,
    ) -> Result<Prepared> {
        let input: Input = serde_json::from_value(frozen)
            .map_err(|_| ApiError::new(409, "TASK_RESUME_UNSAFE", "已保存的生成参数不能恢复"))?;
        if provider == "comfy" {
            return self
                .prepare_comfy(plan::wai(input, &self.inner.config)?, cancel)
                .await;
        }
        if provider != "webui" {
            return Err(ApiError::new(
                409,
                "TASK_RESUME_UNSAFE",
                "已保存的生成提供方无效",
            ));
        }
        if self.inner.cancel.is_cancelled() {
            return Err(closed());
        }
        let status = probe::webui_status(&self.inner, true, &cancel).await;
        let available = status.online
            && status.wai_available
            && (status.samplers.is_empty() || status.samplers.contains(&input.sampler))
            && (input.webui_scheduler.is_empty()
                || status.schedulers.is_empty()
                || status
                    .schedulers
                    .iter()
                    .any(|s| s.eq_ignore_ascii_case(&input.webui_scheduler)))
            && (!input.hires_fix
                || status.upscalers.is_empty()
                || status.upscalers.contains(&input.hires_upscaler));
        if !available {
            return Err(ApiError::new(
                503,
                "WEBUI_CAPABILITY_UNAVAILABLE",
                "当前 WebUI 无法执行已保存的参数",
            ));
        }
        let permit = self
            .inner
            .admission
            .clone()
            .try_acquire_owned()
            .map_err(|_| ApiError::new(429, "GENERATION_QUEUE_FULL", "生成队列已满"))?;
        Ok(Prepared {
            input: serde_json::to_value(&input)?,
            provider: provider.into(),
            execution: Execution::Webui(Box::new(input)),
            selected: "webui",
            permit,
            gpu: None,
        })
    }
    /// This is the same installation identity used by the Node task provider.
    /// An address alone cannot prove that a restarted server owns an old prompt.
    pub(crate) fn provider_identity(&self, unbound_epoch: &str) -> Value {
        // A native image task belongs to this frozen engine configuration. It
        // has no Comfy/WebUI installation or address dependency.
        if self.inner.native_images {
            return json!({"native":self.inner.native_settings});
        }
        let root = self.inner.config.ai_workspace_root.join("ComfyUI");
        let identity = (|| {
            let metadata = std::fs::metadata(&root).ok()?;
            if !metadata.is_dir() { return None; }
            let created = metadata.created().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?;
            let inode = crate::file_identity::path(&root,true).ok()?.ino;
            let canonical = std::fs::canonicalize(&root).ok()?;
            let root = canonical.to_string_lossy();
            let root = root.strip_prefix(r"\\?\").unwrap_or(&root);
            Some(json!({"root":root,"created":created.as_secs() as f64*1000.0+created.subsec_nanos() as f64/1_000_000.0,"inode":inode as f64}))
        })().unwrap_or_else(|| json!({"unboundEpoch":unbound_epoch}));
        json!({"comfy":self.inner.config.comfy_host,"webui":self.inner.config.sd_host,"identity":identity})
    }

    pub(crate) async fn recover_task(
        &self,
        task: RecoveryTask<'_>,
        cancellation: &mut Option<u8>,
    ) -> Result<Observation> {
        let initial = || Observation {
            status: task.status.into(),
            settled: false,
            unknown: false,
            error_code: None,
            metadata: Value::Object(task.metadata.clone()),
            outputs: vec![],
        };
        if task.provider == "webui" {
            snapshots::initialize(self.inner.clone()).await?;
            if let Some(recovered) = webui_results::recover(&self.inner, &task).await? {
                return Ok(recovered);
            }
            let mut result = initial();
            result.unknown = true;
            result.error_code = Some("WEBUI_RESTART_INTERRUPTED".into());
            return Ok(result);
        }
        let mut result = initial();
        if task.provider == "native" {
            if let Some(recovered) = native::recovery::recover(&self.inner, &task).await? {
                return Ok(recovered);
            }
            result.status = "failed".into();
            result.settled = true;
            result.error_code = Some("NATIVE_RESTART_INTERRUPTED".into());
            return Ok(result);
        }
        let Some(id) = task.upstream_id.filter(|s| !s.is_empty()) else {
            result.unknown = true;
            result.error_code = Some("UPSTREAM_ID_UNKNOWN".into());
            return Ok(result);
        };
        if task.cancel_requested && cancellation.is_none() && self.cancel_recovered(id).await? {
            *cancellation = Some(0);
        }
        let encoded = percent_encoding::utf8_percent_encode(id, percent_encoding::NON_ALPHANUMERIC)
            .to_string();
        let history = self
            .inner
            .json(
                "comfy",
                Method::GET,
                &format!("/history/{encoded}"),
                None,
                Duration::from_secs(10),
                &self.inner.cancel,
            )
            .await?;
        let entry = &history[id];
        match entry["status"]["status_str"].as_str() {
            Some("error" | "failed") => {
                result.status = "failed".into();
                result.settled = true;
                result.error_code = Some("COMFY_EXECUTION_FAILED".into());
            }
            Some("success") => {
                result.status = "succeeded".into();
                result.settled = true;
                if !task.result_available && !task.cancel_requested {
                    let kind = task.kind;
                    let (node, prefix, namespace) = match kind {
                        TaskKind::Generation => ("10", "wai_app", "wai"),
                        TaskKind::Anima => ("10", "anima_app", "anima"),
                        TaskKind::Creative => ("10", "creative_app", "anima"),
                        TaskKind::Video => ("11", "video_app", "video"),
                        _ => {
                            return Err(ApiError::new(
                                501,
                                "TASK_RECOVERY_UNAVAILABLE",
                                "该任务的结果恢复尚未接入",
                            ));
                        }
                    };
                    let output = &entry["outputs"][node];
                    let outputs = if kind == TaskKind::Video {
                        output
                            .get("videos")
                            .or_else(|| output.get("gifs"))
                            .or_else(|| output.get("images"))
                    } else {
                        output.get("images").or_else(|| output.get("videos"))
                    };
                    if let Some(reference) =
                        outputs.and_then(Value::as_array).and_then(|a| a.first())
                    {
                        let target = format!(
                            "recovered-{}",
                            hex::encode(Sha256::digest(task.task_id.as_bytes()))
                        );
                        let result_output = if kind == TaskKind::Video {
                            video_output::materialize(
                                &self.inner.transport,
                                &self.inner.config.comfy_host,
                                &self.inner.config.runtime_root.join("outputs/video"),
                                &target,
                                reference,
                                &self.inner.cancel,
                            )
                            .await?
                        } else {
                            output::materialize_scoped(
                                &self.inner,
                                &target,
                                prefix,
                                namespace,
                                reference,
                            )
                            .await?
                        };
                        result.outputs.push(result_output);
                    } else {
                        result.error_code = Some("RESULT_UNAVAILABLE".into());
                    }
                }
            }
            _ => {
                let queue = self
                    .inner
                    .json(
                        "comfy",
                        Method::GET,
                        "/queue",
                        None,
                        Duration::from_secs(10),
                        &self.inner.cancel,
                    )
                    .await?;
                if queued(&queue, "queue_running", "running", id)
                    || queued(&queue, "queue_pending", "pending", id)
                {
                    if let Some(count) = cancellation {
                        *count = 0;
                    }
                    result.status = if task.cancel_requested {
                        "cancelling"
                    } else {
                        "running"
                    }
                    .into();
                } else if let Some(count) = cancellation {
                    *count = count.saturating_add(1);
                    result.status = if *count >= 2 {
                        result.settled = true;
                        "cancelled"
                    } else {
                        "cancelling"
                    }
                    .into();
                } else {
                    result.unknown = true;
                    result.error_code = Some("COMFY_HISTORY_MISSING".into());
                }
            }
        }
        if result.settled {
            *cancellation = None;
        }
        Ok(result)
    }

    async fn cancel_recovered(&self, id: &str) -> Result<bool> {
        let encoded = percent_encoding::utf8_percent_encode(id, percent_encoding::NON_ALPHANUMERIC)
            .to_string();
        let (status, _) = self
            .inner
            .raw_json(
                "comfy",
                Method::POST,
                &format!("/api/jobs/{encoded}/cancel"),
                None,
                Duration::from_secs(10),
                &self.inner.cancel,
            )
            .await?;
        if (200..300).contains(&status) {
            return Ok(true);
        }
        if !matches!(status, 404 | 405) {
            return Err(ApiError::new(
                502,
                "COMFY_UPSTREAM_ERROR",
                "ComfyUI 定向取消失败",
            ));
        }
        let queue = self
            .inner
            .json(
                "comfy",
                Method::GET,
                "/queue",
                None,
                Duration::from_secs(10),
                &self.inner.cancel,
            )
            .await?;
        if queued(&queue, "queue_pending", "pending", id) {
            self.inner
                .json(
                    "comfy",
                    Method::POST,
                    "/queue",
                    Some(&json!({"delete":[id]})),
                    Duration::from_secs(10),
                    &self.inner.cancel,
                )
                .await?;
            return Ok(true);
        }
        // A missing queue entry is not an acknowledgment of cancellation.
        Ok(false)
    }
}
fn queued(queue: &Value, primary: &str, fallback: &str, id: &str) -> bool {
    queue
        .get(primary)
        .unwrap_or(&queue[fallback])
        .as_array()
        .is_some_and(|items| {
            items.iter().any(|item| {
                if item.is_array() {
                    item[1] == id
                } else {
                    item["prompt_id"] == id
                }
            })
        })
}
