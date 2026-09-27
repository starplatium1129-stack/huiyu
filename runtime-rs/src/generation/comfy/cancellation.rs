use super::*;
fn code(job: &Job, suffix: &str) -> String {
    format!(
        "{}_{suffix}",
        if matches!(&job.execution,Execution::Comfy(p)if p.media_kind==MediaKind::Video) {
            "VIDEO"
        } else {
            "ANIMA"
        }
    )
}
fn contains(items: &Value, id: &str) -> bool {
    items.as_array().is_some_and(|items| {
        items.iter().any(|item| {
            if item.is_array() {
                item[1] == id
            } else {
                item["prompt_id"] == id
            }
        })
    })
}
fn queue_items<'a>(queue: &'a Value, primary: &str, secondary: &str) -> &'a Value {
    queue.get(primary).unwrap_or(&queue[secondary])
}
pub(super) async fn targeted(inner: &Inner, id: &str) -> Result<bool> {
    let (status, _) = inner
        .raw_json(
            "comfy",
            Method::POST,
            &format!("/api/jobs/{}/cancel", encode(id)),
            None,
            Duration::from_secs(10),
            &inner.cancel,
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
    let queue = inner
        .json(
            "comfy",
            Method::GET,
            "/queue",
            None,
            Duration::from_secs(10),
            &inner.cancel,
        )
        .await?;
    if contains(queue_items(&queue, "queue_pending", "pending"), id) {
        inner
            .json(
                "comfy",
                Method::POST,
                "/queue",
                Some(&json!({"delete":[id]})),
                Duration::from_secs(10),
                &inner.cancel,
            )
            .await?;
        return Ok(true);
    }
    if contains(queue_items(&queue, "queue_running", "running"), id) {
        return Err(ApiError::new(
            502,
            "COMFY_TARGETED_CANCEL_UNAVAILABLE",
            "当前 ComfyUI 不支持安全的定向运行中取消",
        ));
    }
    Ok(false)
}
pub(super) async fn request(inner: Arc<Inner>, job: Arc<Job>) {
    let id = {
        let mut state = job.state.lock().await;
        if state.interrupt_pending || state.upstream_id.is_empty() {
            return;
        }
        state.interrupt_pending = true;
        state.upstream_id.clone()
    };
    let worker = inner.clone();
    inner.tasks.spawn(async move {
        let acknowledged = targeted(&worker, &id).await.unwrap_or(false);
        let mut state = job.state.lock().await;
        state.interrupt_pending = false;
        state.cancel_acknowledged |= acknowledged;
        drop(state);
        job.notify.notify_waiters();
    });
}
pub(super) async fn cancel(inner: Arc<Inner>, job: Arc<Job>) -> Result<()> {
    let mut state = job.state.lock().await;
    if state.status == "succeeded" {
        if matches!(&job.execution,Execution::Comfy(p)if p.media_kind==MediaKind::Video) {
            return Ok(());
        }
        state.status = "cancelled".into();
        state.error = Some("任务已删除".into());
        state.code = Some(code(&job, "CANCELLED"));
        drop(state);
        jobs::discard_output(&job).await;
        return Ok(());
    }
    if (terminal(&state.status) && state.settled) || state.status == "cancelling" {
        return Ok(());
    }
    if state.status == "failed" && state.upstream_id.is_empty() {
        return Err(ApiError::new(
            409,
            "COMFY_CANCEL_UNKNOWN",
            "上游任务身份未知，无法确认定向取消",
        ));
    }
    if state.status == "queued" && state.upstream_id.is_empty() {
        state.status = "cancelled".into();
        state.settled = true;
        state.finished = Some(now());
        state.code = Some(code(&job, "CANCELLED"));
        state.error = Some("任务已取消".into());
        state.permit.take();
        return Ok(());
    }
    state.status = "cancelling".into();
    state.unknown = false;
    state.error = Some("任务取消中".into());
    state.code = Some(code(&job, "CANCELLING"));
    state.cancel_deadline = Some(Instant::now() + Duration::from_secs(30));
    state.cancel_checks = 0;
    state.cancel_acknowledged = false;
    drop(state);
    request(inner.clone(), job.clone()).await;
    job.notify.notify_waiters();
    loop {
        let notified = job.notify.notified();
        if !job.state.lock().await.interrupt_pending {
            return Ok(());
        }
        tokio::select! {_=notified=>{},_=inner.cancel.cancelled()=>return Err(closed())}
    }
}
pub(super) async fn confirm(inner: &Inner, job: &Job, id: &str) -> bool {
    if job
        .state
        .lock()
        .await
        .cancel_deadline
        .is_some_and(|deadline| Instant::now() > deadline)
    {
        let mut state = job.state.lock().await;
        state.status = "failed".into();
        state.error = Some("无法确认上游任务已安全取消".into());
        state.code = Some(code(job, "CANCEL_FAILED"));
        state.finished = Some(now());
        state.unknown = true;
        state.settled = false;
        return true;
    }
    enum Cancellation {
        Active,
        Absent,
        Terminal,
    }
    let observation = async {
        let queue = inner
            .json(
                "comfy",
                Method::GET,
                "/queue",
                None,
                Duration::from_secs(10),
                &inner.cancel,
            )
            .await?;
        if contains(queue_items(&queue, "queue_running", "running"), id)
            || contains(queue_items(&queue, "queue_pending", "pending"), id)
        {
            return Ok(Cancellation::Active);
        }
        let history = inner
            .json(
                "comfy",
                Method::GET,
                &format!("/history/{}", encode(id)),
                None,
                Duration::from_secs(10),
                &inner.cancel,
            )
            .await?;
        let entry = &history[id];
        Ok::<_, ApiError>(
            if matches!(
                entry["status"]["status_str"].as_str(),
                Some("success" | "error" | "failed")
            ) {
                Cancellation::Terminal
            } else if entry.is_null() {
                Cancellation::Absent
            } else {
                Cancellation::Active
            },
        )
    }
    .await;
    let mut state = job.state.lock().await;
    let terminal = match observation {
        Ok(Cancellation::Terminal) => true,
        Ok(Cancellation::Absent) if state.cancel_acknowledged => {
            state.cancel_checks += 1;
            false
        }
        _ => {
            state.cancel_checks = 0;
            false
        }
    };
    if !terminal && state.cancel_checks < 2 {
        return false;
    }
    state.status = "cancelled".into();
    state.settled = true;
    state.unknown = false;
    state.error = Some("任务已取消".into());
    state.code = Some(code(job, "CANCELLED"));
    state.finished = Some(now());
    state.permit.take();
    drop(state);
    jobs::discard_output(job).await;
    true
}
