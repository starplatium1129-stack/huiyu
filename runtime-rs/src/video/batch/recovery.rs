use super::saved_output::{Proofs, saved_output};
use super::*;
use crate::task_contract::TaskRecord;
use std::borrow::Cow;
#[derive(Default)]
pub(crate) struct BatchRecovery {
    cancellations: HashMap<usize, Option<u8>>,
    outputs: Option<Arc<Proofs>>,
}
impl Service {
    pub(crate) async fn recover_batch(
        &self,
        task: &TaskRecord,
        hooks: Arc<dyn ExecutionHooks>,
        recovery: &mut BatchRecovery,
    ) -> Result<Observation> {
        let owner = task.principal_id.as_str();
        let id = task.checkpoint.as_ref()
            .and_then(|checkpoint| checkpoint["gatewayJobId"].as_str())
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
            let _gate = batch.checkpoint_serial.lock().await;
            hooks.checkpoint(batch.checkpoint().await).await?;
            return Ok(Observation {
                status: "running".into(),
                settled: false,
                unknown: false,
                error_code: None,
                metadata: json!({"gatewayJobId":id,"family":"video-batch"}),
                outputs: Vec::new(),
            });
        }
        let checkpoint = if let Some(batch) = &existing {
            Cow::Owned(batch.checkpoint().await)
        } else {
            Cow::Borrowed(task.checkpoint.as_ref().unwrap())
        };
        let rows = checkpoint["shots"]
            .as_array()
            .filter(|a| !a.is_empty() && a.len() <= 30)
            .ok_or_else(|| error(409, "BATCH_CHECKPOINT_PENDING", "持久分镜检查点未就绪"))?;
        // The task's operation state survives a failed/abandoned first recovery,
        // before a complete Batch is available to retain these per-file proofs.
        let proofs = recovery.outputs.get_or_insert_with(|| {
            existing
                .as_ref()
                .map(|batch| batch.recovered_outputs.clone())
                .unwrap_or_else(|| Arc::new(Proofs::default()))
        }).clone();
        let reference = |index: usize| task.result_refs.iter().find(|r| r.index == index as u64);
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
                if task.cancel_requested_at.is_some() {
                    shot.status = "cancelled".into();
                } else {
                    shot.status = "pending".into();
                    pending = true;
                }
                shots.push(shot);
                continue;
            }
            if let Some(output) =
                saved_output(self, &row["result"], reference(index), &proofs, index).await?
            {
                shot.result = Some(output);
                shot.status = "succeeded".into();
                shots.push(shot);
                continue;
            }
            // Comfy recovery observes this shot's upstream identity and recorded
            // status/cancellation/metadata. The batch input, checkpoint and
            // other result references have no consumer in recover_task.
            let task_id = format!("{}-{}", task.task_id, index + 1);
            let single = generation::RecoveryTask {
                kind: crate::task_contract::TaskKind::Video,
                provider: "comfy",
                result_available: false,
                task_id: &task_id,
                upstream_id: shot.upstream.as_deref(),
                checkpoint: None,
                ..generation::RecoveryTask::from(task)
            };
            let observation = self
                .backend
                .recover_task(single, recovery.cancellations.entry(index).or_default())
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
            if observation.settled && task.cancel_requested_at.is_some() && shot.result.is_none()
            {
                shot.status = "cancelled".into();
            }
            if observation.status == "succeeded"
                && shot.result.is_none()
                && task.cancel_requested_at.is_none()
            {
                unknown = true;
                active = true;
                shot.status = "running".into();
            }
            shots.push(shot);
        }
        let concat = saved_output(
            self,
            &checkpoint["concat"],
            reference(shots.len()),
            &proofs,
            shots.len(),
        )
        .await?;
        let all_success = shots.iter().all(|s| s.status == "succeeded");
        let cancelled = task.cancel_requested_at.is_some() && !active && !unknown && !pending;
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
            // Recipes were restored into shots; the batch only consumes settings.
            let mut input = json!({"steps":task.input.get("steps")});
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
                created: i64::try_from(task.created_at).unwrap_or_else(|_| now()),
                hooks: Some(hooks.clone()),
                state: Mutex::new(State {
                    cancel_generation: 0,
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
                recovered_outputs: proofs,
            })
        };
        {
            // Save once through this recovery's task hook, which also registers
            // its gateway identity. Existing batches may have no/older hooks.
            // Take the snapshot under the save gate so it cannot overtake a
            // newer checkpoint while waiting for another writer.
            let _gate = batch.checkpoint_serial.lock().await;
            hooks.checkpoint(batch.checkpoint().await).await?;
        }
        self.batches.lock().await.insert(batch.id.clone(), batch);
        Ok(Observation {
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
        })
    }
}
