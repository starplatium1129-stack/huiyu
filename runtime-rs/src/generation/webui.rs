use super::*;
use reqwest::Method;

pub(super) fn payload(input: &Input) -> Value {
    let mut payload = json!({"prompt":input.prompt,"negative_prompt":input.negative,"width":input.width,"height":input.height,"cfg_scale":input.cfg,"steps":input.steps,"sampler_name":input.sampler,"seed":input.seed,"batch_size":1,"n_iter":1,"send_images":true,"save_images":false,"override_settings":{"sd_model_checkpoint":constants::CHECKPOINT},"override_settings_restore_afterwards":true});
    if !input.webui_scheduler.is_empty() {
        payload["scheduler"] = json!(input.webui_scheduler);
    }
    if input.hires_fix {
        payload["enable_hr"] = json!(true);
        payload["hr_scale"] = json!(input.hires_scale);
        payload["hr_upscaler"] = json!(input.hires_upscaler);
        payload["hr_second_pass_steps"] = json!(input.hires_steps);
        payload["denoising_strength"] = json!(input.denoising_strength);
    }
    if input.face_detailer {
        payload["alwayson_scripts"] = json!({"ADetailer":{"args":[true,false,{"ad_model":"face_yolov8s.pt","ad_prompt":"detailed eyes, clean face, character-accurate facial features","ad_negative_prompt":"deformed face, asymmetrical eyes, cross-eyed","is_api":true},{"ad_model":"hand_yolov8n.pt","ad_prompt":"detailed hands, five fingers, natural fingers","ad_negative_prompt":"extra fingers, missing fingers, fused fingers, malformed hands","is_api":true}]}});
    }
    payload
}
pub(super) async fn run_queue(inner: Arc<Inner>) {
    loop {
        let job = {
            let mut state = inner.state.lock().await;
            match state.queue.pop_front() {
                Some(job) => job,
                None => {
                    state.runner = false;
                    return;
                }
            }
        };
        if inner.cancel.is_cancelled() {
            jobs::release(&job).await;
            continue;
        }
        if job.state.lock().await.status == "cancelled" {
            continue;
        }
        if let Some(hooks) = &job.hooks
            && let Err(error) = hooks.submitting("webui".into(), String::new()).await
        {
            jobs::fail(&job, error, false).await;
            jobs::release(&job).await;
            continue;
        }
        {
            let mut state = job.state.lock().await;
            if state.status == "cancelled" {
                continue;
            }
            state.status = "running".into();
        }
        let result = inner
            .json(
                "webui",
                Method::POST,
                "/sdapi/v1/txt2img",
                Some(&payload(match &job.execution {
                    Execution::Webui(input) => input,
                    Execution::Comfy(_) => unreachable!("WebUI queue owns only WebUI plans"),
                })),
                Duration::from_secs(20 * 60),
                &inner.cancel,
            )
            .await;
        let result = match result {
            Ok(value) => complete(&inner, &job, value).await,
            Err(error) => Err(error),
        };
        if let Err(error) = result {
            jobs::fail(&job, error, true).await;
        }
        // /interrupt is global: both the original generation and its interrupt
        // must settle before the next queued request can acquire the WebUI slot.
        loop {
            let notified = job.notify.notified();
            if !job.state.lock().await.interrupt_pending {
                break;
            }
            tokio::select! {_=notified=>{},_=inner.cancel.cancelled()=>break}
        }
        let mut state = job.state.lock().await;
        if state.status == "cancelling" {
            state.status = "failed".into();
            state.unknown = true;
            state.settled = false;
        }
        if matches!(state.status.as_str(), "cancelled" | "succeeded") {
            state.settled = true;
            state.unknown = false;
        }
        state.finished = Some(now());
        state.permit.take();
        job.notify.notify_waiters();
    }
}
async fn complete(inner: &Arc<Inner>, job: &Arc<Job>, value: Value) -> Result<()> {
    if job.state.lock().await.status != "running" {
        return Ok(());
    }
    let decoded = inner.decoder.image(value, &inner.cancel).await?;
    let output = Output::Bytes {
        bytes: Arc::new(decoded.bytes),
        mime: "image/png".into(),
    };
    {
        let mut state = job.state.lock().await;
        if state.status != "running" {
            return Ok(());
        }
        state.metadata["seed"] = json!(
            decoded
                .seed
                .unwrap_or(job.input["seed"].as_u64().unwrap_or(0))
        );
    }
    jobs::succeed(inner, job, output).await;
    Ok(())
}
pub(super) async fn cancel(inner: Arc<Inner>, job: Arc<Job>) -> Result<()> {
    let start = {
        let mut state = job.state.lock().await;
        if terminal(&state.status) {
            return Ok(());
        }
        if state.status == "queued" {
            state.status = "cancelled".into();
            state.code = Some("WEBUI_CANCELLED".into());
            state.settled = true;
            state.finished = Some(now());
            state.permit.take();
            job.notify.notify_waiters();
            return Ok(());
        }
        if state.interrupt_pending {
            false
        } else {
            state.status = "cancelling".into();
            state.interrupt_pending = true;
            true
        }
    };
    if start {
        let worker = inner.clone();
        let target = job.clone();
        inner.tasks.spawn(async move {
            let result = worker
                .json(
                    "webui",
                    Method::POST,
                    "/sdapi/v1/interrupt",
                    Some(&json!({})),
                    Duration::from_secs(10),
                    &worker.cancel,
                )
                .await;
            let mut state = target.state.lock().await;
            state.interrupt_pending = false;
            if state.status == "cancelling" {
                if result.is_ok() {
                    state.status = "cancelled".into();
                    state.code = Some("WEBUI_CANCELLED".into());
                    state.error = Some("任务已取消".into());
                } else {
                    state.code = Some("WEBUI_CANCEL_FAILED".into());
                    state.error = Some("未能确认上游取消，等待原任务结束后释放队列".into());
                }
            }
            target.notify.notify_waiters();
        });
    }
    loop {
        let notified = job.notify.notified();
        if !job.state.lock().await.interrupt_pending {
            return Ok(());
        }
        tokio::select! {_=notified=>{},_=inner.cancel.cancelled()=>return Err(closed())}
    }
}
