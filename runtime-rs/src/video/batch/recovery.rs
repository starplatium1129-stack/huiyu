use super::*;
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
async fn saved_output(
    service: &Service,
    value: &Value,
    reference: Option<&Value>,
) -> Result<Option<Output>> {
    let Some(reference) = reference else {
        return Ok(None);
    };
    let Some(raw) = value["path"].as_str() else {
        return Ok(None);
    };
    let path = PathBuf::from(raw);
    let root = service.config.runtime_root.join("outputs/video");
    let Ok(canonical) = tokio::fs::canonicalize(&path).await else {
        return Ok(None);
    };
    let Ok(root) = tokio::fs::canonicalize(root).await else {
        return Ok(None);
    };
    if !canonical.starts_with(root)
        || !matches!(
            path.extension().and_then(|s| s.to_str()),
            Some("mp4" | "webm" | "mov")
        )
    {
        return Ok(None);
    }
    let mut file = tokio::fs::File::open(&path).await?;
    let bytes = file.metadata().await?.len();
    if bytes == 0 || reference["bytes"].as_u64() != Some(bytes) {
        return Ok(None);
    }
    let mut hash = Sha256::new();
    let mut buffer = vec![0; 1024 * 1024];
    loop {
        let n = file.read(&mut buffer).await?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    if reference["sha256"] != hex::encode(hash.finalize()) {
        return Ok(None);
    }
    Ok(Some(Output::File {
        path,
        mime: reference["mime"].as_str().unwrap_or("video/mp4").into(),
        bytes,
    }))
}
impl Service {
    pub async fn recover_batch(
        &self,
        task: &Value,
        hooks: Arc<dyn ExecutionHooks>,
        cancellations: &mut HashMap<usize, Option<u8>>,
    ) -> Result<(Observation, Value)> {
        let owner = task["principalId"]
            .as_str()
            .ok_or_else(|| error(409, "BATCH_RECOVERY_REVIEW", "持久分镜缺少所有者"))?;
        let id = task["checkpoint"]["gatewayJobId"]
            .as_str()
            .filter(|s| {
                !s.is_empty()
                    && s.len() <= 80
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            })
            .ok_or_else(|| error(409, "BATCH_CHECKPOINT_PENDING", "持久分镜缺少网关身份"))?;
        let existing = self
            .batches
            .lock()
            .await
            .get(id)
            .filter(|b| b.owner == owner)
            .cloned();
        if let Some(batch) = &existing
            && batch.serial.try_lock().is_err()
        {
            return Ok((
                Observation {
                    status: "running".into(),
                    settled: false,
                    unknown: false,
                    error_code: None,
                    metadata: json!({"gatewayJobId":id,"family":"video-batch"}),
                    outputs: Vec::new(),
                },
                batch.checkpoint().await,
            ));
        }
        let checkpoint = if let Some(batch) = &existing {
            batch.checkpoint().await
        } else {
            task["checkpoint"].clone()
        };
        let rows = checkpoint["shots"]
            .as_array()
            .filter(|a| !a.is_empty() && a.len() <= 30)
            .ok_or_else(|| error(409, "BATCH_CHECKPOINT_PENDING", "持久分镜检查点未就绪"))?;
        let references = task["resultRefs"].as_array();
        let reference = |index: usize| {
            references.and_then(|a| a.iter().find(|r| r["index"].as_u64() == Some(index as u64)))
        };
        let mut shots = Vec::with_capacity(rows.len());
        let (mut unknown, mut active, mut pending, mut failed) = (false, false, false, false);
        for (index, row) in rows.iter().enumerate() {
            if row["index"].as_u64() != Some(index as u64 + 1) {
                return Err(error(409, "BATCH_CHECKPOINT_INVALID", "分镜检查点索引无效"));
            }
            let mut shot = Shot {
                input: row["input"].clone(),
                status: row["status"].as_str().unwrap_or("pending").into(),
                attempts: row["attempts"].as_u64().unwrap_or(0),
                upstream: row["upstreamId"].as_str().map(str::to_owned),
                intent: row["submissionIntentAt"].as_i64(),
                gateway: row["gatewayJobId"].as_str().map(str::to_owned),
                tail: row["tailFrame"].as_str().map(str::to_owned),
                result: None,
                code: row["errorCode"].as_str().map(str::to_owned),
                error: None,
            };
            if shot.intent.is_none() {
                if task["cancelRequestedAt"].is_number() {
                    shot.status = "cancelled".into();
                } else {
                    shot.status = "pending".into();
                    pending = true;
                }
                shots.push(shot);
                continue;
            }
            if let Some(output) = saved_output(self, &row["result"], reference(index)).await? {
                shot.result = Some(output);
                shot.status = "succeeded".into();
                shots.push(shot);
                continue;
            }
            let mut single = task.clone();
            single["kind"] = json!("video");
            single["provider"] = json!("comfy");
            single["taskId"] = json!(format!(
                "{}-{}",
                task["taskId"].as_str().unwrap_or(id),
                index + 1
            ));
            single["upstreamId"] = json!(shot.upstream);
            single["input"] = shot.input.clone();
            single["resultState"] = json!("none");
            let observation = self
                .backend
                .recover_task(&single, cancellations.entry(index).or_default())
                .await?;
            if let Some(output) = observation.outputs.first() {
                hooks.collect_indexed(vec![(index, output.clone())]).await?;
                shot.result = Some(output.clone());
            }
            if observation.settled {
                shot.status = observation.status.clone();
                shot.code = observation.error_code.clone();
            }
            unknown |= observation.unknown;
            active |= !observation.settled;
            failed |= observation.status == "failed";
            if observation.settled && task["cancelRequestedAt"].is_number() && shot.result.is_none()
            {
                shot.status = "cancelled".into();
            }
            if observation.status == "succeeded"
                && shot.result.is_none()
                && !task["cancelRequestedAt"].is_number()
            {
                unknown = true;
                active = true;
                shot.status = "running".into();
            }
            shots.push(shot);
        }
        let concat = saved_output(self, &checkpoint["concat"], reference(shots.len())).await?;
        let all_success = shots.iter().all(|s| s.status == "succeeded");
        let cancelled = task["cancelRequestedAt"].is_number() && !active && !unknown && !pending;
        let code = if unknown {
            Some("BATCH_UPSTREAM_UNKNOWN".to_owned())
        } else if pending && !active {
            Some("BATCH_AWAITING_EXPLICIT_CONTINUE".to_owned())
        } else {
            None
        };
        let status = if all_success {
            "done"
        } else if cancelled {
            "cancelled"
        } else {
            "paused"
        };
        let batch = if let Some(batch) = existing {
            let _gate = batch
                .serial
                .try_lock()
                .map_err(|_| error(409, "BATCH_RECOVERY_REVIEW", "分镜仍在执行，不能替换检查点"))?;
            {
                let mut s = batch.state.lock().await;
                s.shots = shots;
                s.status = status.into();
                s.unknown = unknown || active;
                s.error_code = code.clone();
                if concat.is_some() {
                    s.concat = concat;
                    s.concat_stage = "available";
                }
            }
            drop(_gate);
            batch
        } else {
            let mut input = task
                .get("effectiveInput")
                .filter(|i| i.is_object())
                .unwrap_or(&task["input"])
                .clone();
            for key in ["modelId", "aspectRatio", "quality", "linkLastFrame"] {
                input[key] = checkpoint[key].clone();
            }
            let cancel = self.shutdown.child_token();
            if cancelled {
                cancel.cancel();
            }
            Arc::new(Batch {
                id: id.into(),
                owner: owner.into(),
                input,
                created: task["createdAt"].as_i64().unwrap_or_else(now),
                hooks: Some(hooks),
                state: Mutex::new(State {
                    status: status.into(),
                    shots,
                    concat_stage: if concat.is_some() {
                        "available"
                    } else {
                        "none"
                    },
                    concat,
                    unknown: unknown || active,
                    error_code: code.clone(),
                    cancel,
                }),
                serial: Mutex::new(()),
                checkpoint_serial: Mutex::new(()),
                concat_serial: Mutex::new(()),
            })
        };
        batch.save().await?;
        let checkpoint = batch.checkpoint().await;
        self.batches.lock().await.insert(batch.id.clone(), batch);
        Ok((
            Observation {
                status: if all_success {
                    "succeeded"
                } else if cancelled {
                    "cancelled"
                } else if !active && !pending && failed {
                    "failed"
                } else {
                    "running"
                }
                .into(),
                settled: !active && !pending && !unknown,
                unknown: unknown || (pending && !active),
                error_code: code,
                metadata: json!({"gatewayJobId":id,"family":"video-batch"}),
                outputs: Vec::new(),
            },
            checkpoint,
        ))
    }
}
