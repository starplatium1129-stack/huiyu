use super::*;

pub(super) async fn prepare(
    inner: Arc<Inner>,
    raw: Value,
    direct_local: bool,
    cancel: CancellationToken,
) -> Result<Prepared> {
    if inner.closed.load(Ordering::Relaxed) || inner.cancel.is_cancelled() {
        return Err(closed());
    }
    let mut input = validation::validate(&raw, direct_local)?;
    let permit =
        inner.admission.clone().try_acquire_owned().map_err(|_| {
            ApiError::new(503, "GENERATION_QUEUE_FULL", "WAI 任务队列已满，请稍后再试")
        })?;
    let work = async {
        let (webui, comfy_online) = tokio::join!(
            probe::webui_status(&inner, true, &cancel),
            probe::comfy_status(&inner, &cancel)
        );
        let webui_usable = webui.online && webui.wai_available;
        let comfy_usable = comfy_online && resources::usable(&inner.config, &input).await;
        let supports_sampler = webui.samplers.is_empty() || webui.samplers.contains(&input.sampler);
        let supports_scheduler = input.webui_scheduler.is_empty()
            || webui.schedulers.is_empty()
            || webui.schedulers.contains(&input.webui_scheduler)
            || (input.webui_scheduler == "karras"
                && webui.schedulers.iter().any(|s| s == "Karras"));
        let supports_anime = webui.upscalers.is_empty()
            || webui.upscalers.iter().any(|s| s == "R-ESRGAN 4x+ Anime6B");
        let supports_upscaler = !input.hires_fix
            || input.auto_hires
            || webui.upscalers.is_empty()
            || webui.upscalers.contains(&input.hires_upscaler);
        let provider = if input.auto_hires
            && webui_usable
            && supports_sampler
            && supports_scheduler
            && supports_anime
        {
            input.auto_hires = false;
            input.hires_upscaler = "R-ESRGAN 4x+ Anime6B".into();
            input.comfy_hires = false;
            input.comfy_unsupported = true;
            "webui"
        } else if comfy_usable && !input.face_detailer && !input.comfy_unsupported {
            let requested = input
                .super_res_wanted
                .then_some(input.hires_upscaler.as_str());
            let model = resources::super_res(&inner.config, requested).await;
            if input.auto_hires {
                input.auto_hires = false;
                input.hires_upscaler = model
                    .as_deref()
                    .and_then(resources::super_res_name)
                    .unwrap_or("Latent (nearest-exact)")
                    .into();
                input.super_res_model = model;
                input.comfy_hires = true;
                input.comfy_unsupported = false;
            } else if input.super_res_wanted {
                if model.is_none() {
                    return Err(ApiError::new(
                        503,
                        "SUPER_RES_MODEL_UNAVAILABLE",
                        format!(
                            "Comfy 本地未安装所选 {} 超分模型，请改用已安装模型或 Latent",
                            input.hires_upscaler
                        ),
                    ));
                }
                input.super_res_model = model;
                input.comfy_hires = true;
                input.comfy_unsupported = false;
            }
            "comfy"
        } else {
            if webui_usable && (!supports_sampler || !supports_scheduler) {
                return Err(ApiError::new(
                    400,
                    "WEBUI_CAPABILITY_UNAVAILABLE",
                    "WebUI 不支持当前采样器或调度器",
                ));
            }
            if webui_usable && !supports_upscaler {
                return Err(ApiError::new(
                    400,
                    "WEBUI_UPSCALER_UNAVAILABLE",
                    "WebUI 未安装所选放大器",
                ));
            }
            if webui_usable {
                if input.auto_hires {
                    input.auto_hires = false;
                    input.hires_fix = false;
                    input.comfy_hires = false;
                    input.comfy_unsupported = false;
                }
                "webui"
            } else {
                if input.face_detailer {
                    return Err(ApiError::new(
                        503,
                        "WEBUI_RESOURCES_UNAVAILABLE",
                        "当前功能需要包含 WAI checkpoint 的 SD WebUI / reForge",
                    ));
                }
                if !comfy_usable {
                    return Err(ApiError::new(
                        503,
                        "COMFY_RESOURCES_UNAVAILABLE",
                        "WAI checkpoint 或角色 LoRA 资源不可用，未选择 ComfyUI",
                    ));
                }
                if input.comfy_unsupported {
                    return Err(ApiError::new(
                        503,
                        "COMFY_CAPABILITY_UNAVAILABLE",
                        "当前请求不符合 ComfyUI 能力，请启用 WebUI 或改用 Latent hires",
                    ));
                }
                "comfy"
            }
        };
        if inner.closed.load(Ordering::Relaxed) || inner.cancel.is_cancelled() {
            return Err(closed());
        }
        Ok(Prepared {
            input: serde_json::to_value(&input)?,
            provider: provider.into(),
            execution: if provider == "webui" {
                Execution::Webui(Box::new(input))
            } else {
                Execution::Comfy(Box::new(plan::wai(input, &inner.config)?))
            },
            selected: provider,
            permit,
        })
    };
    tokio::select! {result=work=>result,_=cancel.cancelled()=>Err(ApiError::new(499,"ABORT_ERR","生成请求已取消")),_=inner.cancel.cancelled()=>Err(closed())}
}

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
                json!({"gatewayJobId":job.id,"provider":job.provider,"effectiveInput":job.input}),
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
    let comfy = comfy_online
        && resources::available(&inner.config, "checkpoints", constants::CHECKPOINT).await;
    let web = webui.online && webui.wai_available;
    let super_res = resources::super_res(&inner.config, None).await;
    let mut hires = Vec::new();
    if comfy
        || (web
            && (webui.upscalers.is_empty()
                || webui.upscalers.iter().any(|s| s == "R-ESRGAN 4x+ Anime6B")))
    {
        hires.push("Auto".to_string());
    }
    if comfy {
        for name in constants::SUPER_RES {
            if resources::super_res(&inner.config, Some(name))
                .await
                .is_some()
            {
                hires.push((*name).into());
            }
        }
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
    let mut loras = Vec::new();
    for (id, file, character) in constants::LORAS {
        loras.push(json!({"id":id,"character":character,"available":resources::available(&inner.config,"loras",file).await}));
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
    Ok(
        json!({"online":web||comfy,"provider":if comfy{Some("comfy")}else if web{Some("webui")}else{None},"webuiOnline":web,"comfyFallbackOnline":comfy,"checkpoint":if !webui.checkpoint.is_empty(){webui.checkpoint}else if comfy{constants::CHECKPOINT.into()}else{String::new()},"samplers":webui.samplers,"schedulers":webui.schedulers,"models":webui.models,"loras":loras,"capabilities":{"basic":web||comfy,"hires":web||comfy,"hiresUpscalers":hires,"faceDetailer":web,"superResModel":if comfy{super_res}else{None}},"pending":constants::MAX_PENDING-inner.admission.available_permits(),"maxPending":constants::MAX_PENDING,"webuiPending":web_pending,"comfyPending":comfy_pending}),
    )
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
        let preserve = job.provider == "webui" && job.state.lock().await.collection_pending;
        jobs::discard_output(job).await;
        job.state.lock().await.permit.take();
        if !preserve {
            snapshots::remove(&inner, &job.id).await;
        }
    }
}
