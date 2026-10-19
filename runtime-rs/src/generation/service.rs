use super::*;

pub(super) async fn submit(
    inner: Arc<Inner>,
    prepared: Prepared,
    owner: String,
    hooks: Option<Arc<dyn ExecutionHooks>>,
) -> Result<Value> {
    if inner.closed.load(Ordering::Relaxed) || inner.cancel.is_cancelled() {
        return Err(closed());
    }
    if owner.is_empty() {
        return Err(ApiError::new(401, "UNAUTHORIZED", "生成任务需要有效所有者"));
    }
    snapshots::initialize(inner.clone()).await?;
    let job = jobs::create(prepared, owner, hooks);
    inner
        .state
        .lock()
        .await
        .jobs
        .insert(job.id.clone(), job.clone());
    if let Err(error) = snapshots::save(&inner, &job).await {
        eprintln!("generation snapshot: {}", error.code);
    }
    if let Some(hooks) = &job.hooks
        && let Err(error) = hooks
            .checkpoint(
                json!({"gatewayJobId":job.id,"provider":job.provider,"effectiveInput":job.input.as_ref()}),
            )
            .await
    {
        jobs::remove(&inner, &job).await;
        return Err(error);
    }
    if inner.closed.load(Ordering::Relaxed) {
        jobs::remove(&inner, &job).await;
        return Err(closed());
    }
    if job.provider == "native" {
        native::submit(inner.clone(), job.clone()).await;
    } else if job.provider == "webui" {
        let mut state = inner.state.lock().await;
        state.queue.push_back(job.clone());
        if !state.runner {
            state.runner = true;
            inner.tasks.spawn(webui::run_queue(inner.clone()));
        }
    } else {
        comfy::submit(inner.clone(), job.clone()).await?;
    }
    jobs::public(&job).await
}

pub(super) async fn status(inner: Arc<Inner>) -> Result<Value> {
    let (webui, comfy_online) = tokio::join!(
        probe::webui_status(&inner, false, &inner.cancel),
        probe::comfy_status(&inner, &inner.cancel)
    );
    let root = inner.config.ai_workspace_root.join("ComfyUI/models");
    let local = tokio::task::spawn_blocking(move || resources::local_status(root, comfy_online))
        .await
        .map_err(|_| ApiError::new(503, "SD_STATUS_UNAVAILABLE", "生成资源状态暂不可用"))?;
    let comfy = local.comfy;
    let web = webui.online && webui.wai_available;
    let super_res = local.super_res;
    let mut hires = Vec::new();
    if comfy
        || (web
            && (webui.upscalers.is_empty()
                || webui.upscalers.iter().any(|s| s == "R-ESRGAN 4x+ Anime6B")))
    {
        hires.push("Auto".to_string());
    }
    if comfy {
        hires.extend(local.upscalers.into_iter().map(str::to_owned));
    }
    if comfy || webui.upscalers.iter().any(|s| s == "Latent") {
        hires.extend(["Latent".into(), "Latent (nearest-exact)".into()]);
    }
    if web {
        for name in &webui.upscalers {
            if constants::UPSCALERS.contains(&name.as_str()) && !hires.contains(name) {
                hires.push(name.clone());
            }
        }
    }
    let jobs = inner
        .state
        .lock()
        .await
        .jobs
        .values()
        .cloned()
        .collect::<Vec<_>>();
    let (mut web_pending, mut comfy_pending) = (0, 0);
    for job in jobs {
        if job.state.lock().await.permit.is_some() {
            if job.provider == "webui" {
                web_pending += 1
            } else {
                comfy_pending += 1
            }
        }
    }
    let mut result = json!({"online":web||comfy,"provider":if comfy{Some("comfy")}else if web{Some("webui")}else{None},"webuiOnline":web,"comfyFallbackOnline":comfy,"checkpoint":if !webui.checkpoint.is_empty(){webui.checkpoint}else if comfy{constants::CHECKPOINT.into()}else{String::new()},"samplers":null,"schedulers":null,"models":null,"loras":null,"capabilities":{"basic":web||comfy,"hires":web||comfy,"hiresUpscalers":null,"faceDetailer":web,"superResModel":super_res},"pending":constants::MAX_PENDING-inner.admission.available_permits(),"maxPending":constants::MAX_PENDING,"webuiPending":web_pending,"comfyPending":comfy_pending});
    result["samplers"] = webui.samplers.into();
    result["schedulers"] = webui.schedulers.into();
    result["models"] = webui.models.into();
    result["loras"] = Value::Array(local.loras);
    result["capabilities"]["hiresUpscalers"] = hires.into();
    Ok(result)
}

pub(super) async fn close(inner: Arc<Inner>) {
    if inner.closed.swap(true, Ordering::Relaxed) {
        inner.tasks.wait().await;
        inner.decoder.close().await;
        inner.native.close().await;
        return;
    }
    inner.admission.close();
    inner.cancel.cancel();
    inner.tasks.close();
    inner.tasks.wait().await;
    inner.decoder.close().await;
    inner.native.close().await;
    let monitor = inner
        .initialized
        .get()
        .and_then(|initialized| initialized.progress.lock().unwrap().take());
    if let Some(monitor) = monitor {
        monitor.close().await;
    }
    let jobs = std::mem::take(&mut inner.state.lock().await.jobs);
    for job in jobs.values() {
        let preserve = matches!(job.provider, "webui" | "native") && job.state.lock().await.collection_pending;
        if !preserve { jobs::discard_output(job).await; }
        job.state.lock().await.release_capacity();
        if !preserve {
            snapshots::remove(&inner, &job.id).await;
        }
    }
}
