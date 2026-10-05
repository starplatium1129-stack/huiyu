use super::*;

fn next_delay(state: &JobState, checks: u64) -> Duration {
    if state
        .history_finishing
        .is_some_and(|until| until > tokio::time::Instant::now())
    {
        Duration::from_millis(250)
    } else if state.progress_live && state.execution_started {
        Duration::from_secs(3)
    } else if state.progress_live {
        Duration::from_secs(1)
    } else {
        Duration::from_millis(checks.saturating_mul(500).clamp(500, 2000))
    }
}

async fn wait(inner: &Inner, job: &Job, delay: Duration) -> bool {
    let notified = job.notify.notified();
    tokio::pin!(notified);
    notified.as_mut().enable();
    let urgent = {
        let mut state = job.state.lock().await;
        std::mem::take(&mut state.history_urgent)
    };
    if urgent {
        return !inner.cancel.is_cancelled();
    }
    tokio::select! {
        biased;
        _ = inner.cancel.cancelled() => false,
        _ = notified => true,
        _ = tokio::time::sleep(delay) => true,
    }
}

pub(super) async fn run(inner: Arc<Inner>, job: Arc<Job>) {
    let Execution::Comfy(plan) = &job.execution else {
        unreachable!()
    };
    let mut failures = 0_u32;
    let mut result_failures = 0_u32;
    let mut completed: Option<Value> = None;
    let mut checks = 0_u64;
    let mut delay = Duration::ZERO;
    loop {
        if !wait(&inner, &job, delay).await {
            return;
        }
        let (status, id, pending, settled) = {
            let state = job.state.lock().await;
            (
                state.status.clone(),
                state.upstream_id.clone(),
                state.interrupt_pending,
                state.settled,
            )
        };
        if terminal(&status) && settled {
            watch(&inner, &id, false);
            return;
        }
        if status == "cancelling" {
            if !pending && cancellation::confirm(&inner, &job, &id).await {
                if job.state.lock().await.settled {
                    watch(&inner, &id, false);
                    return;
                }
                delay = Duration::from_secs(3);
                continue;
            }
            delay = Duration::from_millis(250);
            continue;
        }
        // A known completed prompt is no longer subject to generation timeout.
        if completed.is_none()
            && status != "failed"
            && now() - job.created > plan.timeout.as_millis() as i64
        {
            let _ = cancellation::targeted(&inner, &id).await;
            jobs::fail(
                &job,
                ApiError::new(
                    504,
                    if plan.media_kind == MediaKind::Video {
                        "VIDEO_TIMEOUT"
                    } else {
                        "ANIMA_TIMEOUT"
                    },
                    "生成超时",
                ),
                true,
            )
            .await;
            watch(&inner, &id, false);
            delay = Duration::from_secs(3);
            continue;
        }
        if !job.state.lock().await.observed {
            if let Some(hooks) = &job.hooks {
                let mut metadata = job.state.lock().await.metadata.clone();
                metadata["gatewayJobId"] = json!(job.id);
                if hooks.observed(id.clone(), metadata).await.is_err() {
                    delay = Duration::from_millis(500);
                    continue;
                }
            }
            let mut state = job.state.lock().await;
            state.observed = true;
            if state.status != "failed" {
                state.unknown = false;
            }
        }
        let image = if let Some(image) = &completed {
            image.clone()
        } else {
            let history = match inner
                .json(
                    "comfy",
                    Method::GET,
                    &format!("/history/{}", encode(&id)),
                    None,
                    Duration::from_secs(10),
                    &inner.cancel,
                )
                .await
            {
                Ok(history) => {
                    failures = 0;
                    history
                }
                Err(error) => {
                    failures = failures.saturating_add(1);
                    if failures >= 60 {
                        jobs::fail(&job, error, true).await;
                    }
                    delay = retry_delay(failures);
                    continue;
                }
            };
            checks = checks.saturating_add(1);
            let current = job.state.lock().await;
            delay = next_delay(&current, checks);
            if current.status != "running" && !(current.status == "failed" && !current.settled) {
                continue;
            }
            drop(current);
            let entry = &history[&id];
            let status = entry["status"]["status_str"].as_str().unwrap_or("");
            if matches!(status, "error" | "failed") {
                jobs::fail(
                    &job,
                    ApiError::new(502, "COMFY_EXECUTION_FAILED", execution_error(entry)),
                    false,
                )
                .await;
                continue;
            }
            if status != "success" {
                continue;
            }
            // Result transport/storage retries must not retain GPU admission.
            jobs::release(&job).await;
            let node = &entry["outputs"][plan.output_node];
            let image = if plan.media_kind == MediaKind::Video {
                node.get("videos")
                    .or_else(|| node.get("gifs"))
                    .unwrap_or(&node["images"])
            } else {
                &node["images"]
            }
            .as_array()
            .and_then(|a| a.first());
            let Some(image) = image else {
                jobs::fail(
                    &job,
                    ApiError::new(
                        502,
                        if plan.media_kind == MediaKind::Video {
                            "COMFY_NO_VIDEO"
                        } else {
                            "COMFY_NO_IMAGE"
                        },
                        "ComfyUI 未返回生成结果",
                    ),
                    false,
                )
                .await;
                continue;
            };
            // Retain only the confirmed output reference, not an unbounded history.
            // Comfy may evict history before a local/transport retry can complete.
            completed = Some(image.clone());
            image.clone()
        };
        {
            let mut state = job.state.lock().await;
            if state.status == "failed" && !state.settled {
                state.status = "running".into();
                state.unknown = false;
            }
        }
        match materialize(&inner, &job, &image).await {
            Ok(output) => jobs::succeed(&inner, &job, output).await,
            Err(error) => {
                if error.code == "ABORT_ERR" {
                    delay = Duration::ZERO;
                    continue;
                }
                result_failures = result_failures.saturating_add(1);
                delay = retry_delay(result_failures);
                match error.code.as_str() {
                    "RESULT_SAVE_FAILED" => jobs::fail(&job, error, true).await,
                    "INVALID_RESULT" | "COMFY_NO_IMAGE" => jobs::fail(&job, error, false).await,
                    _ if result_failures >= 60 => jobs::fail(&job, error, true).await,
                    _ => {}
                }
            }
        }
    }
}
fn retry_delay(failures: u32) -> Duration {
    Duration::from_millis((500 * u64::from(failures)).min(3000))
}
async fn materialize(inner: &Inner, job: &Job, image: &Value) -> Result<Output> {
    let Execution::Comfy(plan) = &job.execution else {
        unreachable!()
    };
    let transfer = async {
        if plan.media_kind == MediaKind::Video {
            video_output::materialize(
                &inner.transport,
                &inner.config.comfy_host,
                &inner.config.runtime_root.join("outputs/video"),
                &job.id,
                image,
                &inner.cancel,
            )
            .await
        } else {
            output::materialize(inner, job, image).await
        }
    };
    tokio::pin!(transfer);
    loop {
        let notified = job.notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if matches!(
            job.state.lock().await.status.as_str(),
            "cancelling" | "cancelled"
        ) {
            return Err(ApiError::new(499, "ABORT_ERR", "结果读取已取消"));
        }
        // Progress notifications must not restart an in-flight request.
        tokio::select! { biased;
            _ = inner.cancel.cancelled() => return Err(closed()),
            _ = notified => {},
            result = &mut transfer => return result,
        }
    }
}

#[cfg(test)]
mod tests;
