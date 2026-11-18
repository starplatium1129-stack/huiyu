use super::*;
pub(super) fn wai_metadata(input: &Input, provider: &str) -> Value {
    let loras = input
        .loras
        .iter()
        .map(|l| json!({"id":l.id,"strength":l.strength}))
        .collect::<Vec<_>>();
    let mut metadata = json!({"engine":"sd","provider":provider,"modelId":input.model_id,"profileId":input.profile,"loras":loras,"loraId":input.loras.first().map(|l|&l.id),"loraStrength":input.loras.first().map(|l|l.strength),"width":input.width,"height":input.height,"steps":input.steps,"cfg":input.cfg,"sampler":input.sampler,"scheduler":input.scheduler,"seed":input.seed,"hiresFix":input.hires_fix,"hiresUpscaler":if input.hires_fix{Some(&input.hires_upscaler)}else{None},"hiresScale":input.hires_fix.then_some(input.hires_scale)});
    if let Some(requested) = &input.requested_hires_upscaler {
        metadata["requestedHiresUpscaler"] = json!(requested);
    }
    if let Some(model) = &input.super_res_model {
        metadata["superResModel"] = json!(model);
    }
    if provider == "comfy" {
        metadata["prompt"] = json!(input.prompt);
        metadata["negative"] = json!(input.negative);
        metadata["character"] = input.character.clone();
        metadata["hiresSteps"] = json!(input.hires_steps);
        metadata["denoisingStrength"] = json!(input.denoising_strength);
        metadata["faceDetailer"] = json!(input.face_detailer);
    }
    metadata
}
pub(super) fn create(
    mut prepared: Prepared,
    owner: String,
    hooks: Option<Arc<dyn ExecutionHooks>>,
) -> Arc<Job> {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let created = now();
    let provider = prepared.provider();
    // Release the caller's ledger copy before rebuilding from private execution.
    drop(prepared.input);
    let input = prepared.execution.input();
    let mut metadata = match &mut prepared.execution {
        Execution::Webui(input) => wai_metadata(input, "webui"),
        Execution::Comfy(plan) => std::mem::take(&mut plan.metadata),
        Execution::Native(plan) => {
            let mut metadata = plan.input.as_ref().clone();
            metadata["engine"] = if plan.input["mediaKind"] == "video" {
                json!("video")
            } else {
                plan.input["family"].clone()
            };
            metadata
        }
    };
    metadata["id"] = json!(id);
    if provider == "comfy" {
        metadata["createdAt"] = json!(created);
    }
    Arc::new(Job {
        id,
        owner,
        input,
        execution: prepared.execution,
        provider,
        created,
        started_at: AtomicI64::new(0),
        state: Mutex::new(JobState {
            status: "queued".into(),
            result: None,
            result_sha256: None,
            error: None,
            code: None,
            metadata: metadata.into(),
            upstream_id: String::new(),
            progress: None,
            current_node: None,
            progress_text: if provider == "native" {
                "等待独立推理"
            } else {
                "等待提交到 ComfyUI…"
            }
            .into(),
            history_urgent: false,
            history_finishing: None,
            progress_live: false,
            execution_started: false,
            finished: None,
            settled: false,
            unknown: false,
            observed: false,
            collection_pending: false,
            interrupt_pending: false,
            cancel_acknowledged: false,
            cancel_deadline: None,
            cancel_checks: 0,
            permit: Some(prepared.permit),
            gpu: prepared.gpu,
        }),
        collection: Mutex::new(()),
        notify: Notify::new(),
        hooks,
    })
}
pub(super) async fn find(
    inner: &Arc<Inner>,
    id: &str,
    owner: &str,
    result: bool,
) -> Result<Arc<Job>> {
    find_scoped(inner, id, owner, result, None).await
}
pub(super) async fn find_scoped(
    inner: &Arc<Inner>,
    id: &str,
    owner: &str,
    result: bool,
    family: Option<&str>,
) -> Result<Arc<Job>> {
    snapshots::initialize(inner.clone()).await?;
    let state = inner.state.lock().await;
    if let Some(job) = state.jobs.get(id).filter(|j| j.owner == owner) {
        if family.is_none_or(|family| job.input["family"] == family) {
            return Ok(job.clone());
        }
    } else if state.lost.get(id).is_some_and(|stored| {
        stored.owner == owner
            && family.is_none_or(|family| stored.family.as_deref() == Some(family))
    }) {
        return Err(ApiError::new(
            410,
            "JOB_LOST",
            "网关重启导致该生成任务中断；请重新提交",
        ));
    }
    Err(ApiError::new(
        404,
        if result {
            "RESULT_NOT_FOUND"
        } else {
            "JOB_NOT_FOUND"
        },
        if result {
            "结果不存在"
        } else if family.is_some() {
            "生成任务不存在"
        } else {
            "任务不存在"
        },
    ))
}
pub(super) async fn public(job: &Job) -> Result<Value> {
    let state = job.state.lock().await;
    let metadata = state.metadata.clone();
    let available =
        state.status == "succeeded" && state.result.as_ref().is_some_and(|r| !r.is_empty());
    let result_url =
        available.then(|| format!("{}/jobs/{}/result", job.execution.route_base(), job.id));
    let seed = metadata["seed"]
        .as_u64()
        .filter(|s| *s <= 9_007_199_254_740_991)
        .unwrap_or(job.input["seed"].as_u64().unwrap_or(0));
    let mut public = json!({"id":job.id,"status":state.status,"provider":job.provider,"seed":seed,"resultAvailable":available,"resultUrl":result_url,"metadata":null,"error":state.error,"code":state.code});
    public["resultBytes"] = json!(state.result.as_ref().filter(|_| available).map(Output::len));
    public["resultSha256"] = json!(state.result_sha256.as_ref().filter(|_| available));
    public["upstreamSettled"] = json!(state.settled && !state.collection_pending);
    public["unknown"] = json!(state.unknown);
    let tracked = matches!(job.provider, "comfy" | "native");
    if tracked {
        public["progress"] = if state.status == "succeeded" {
            json!(1)
        } else if state.status == "queued" {
            json!(0)
        } else {
            json!(state.progress)
        };
        public["elapsedSeconds"] =
            json!((state.finished.unwrap_or_else(now) - job.created).max(0) / 1000);
        let started = job.started_at.load(Ordering::Relaxed);
        public["finishedAt"] = json!(state.finished);
        public["generationMs"] = json!(
            state
                .finished
                .filter(|_| started > 0)
                .map(|end| (end - started).max(0))
        );
        public["currentNode"] = json!(state.current_node);
        public["progressText"] = json!(state.progress_text);
    }
    drop(state);
    public["metadata"] = Arc::unwrap_or_clone(metadata);
    public["metadata"]["provider"] = json!(job.provider);
    if tracked {
        public["modelId"] = job.input["modelId"].clone();
        if let Some(character) = job.input.get("character") {
            public["character"] = character.clone();
        }
        if let Some(lora) = job.input.get("loraId") {
            public["loraId"] = lora.clone();
        }
        public["createdAt"] = json!(job.created);
        public["metadata"]["resultUrl"] = json!(result_url);
    }
    Ok(public)
}
pub(super) async fn observe(inner: &Arc<Inner>, id: &str, owner: &str) -> Result<Observation> {
    let job = find(inner, id, owner, false).await?;
    // A later reconciliation can finish an earlier failed durable collection.
    // The collection mutex also releases the claim if this query is dropped.
    if job.state.lock().await.collection_pending {
        try_collect(inner, &job).await;
    }
    let state = job.state.lock().await;
    let snapshot = state.metadata.clone();
    let manga = (job.input["family"] == "manga-screen")
        .then(|| (state.progress, state.progress_text.clone()));
    let finished = state.finished;
    let mut observation = Observation {
        status: if state.collection_pending && state.status == "succeeded" {
            "running".into()
        } else {
            state.status.clone()
        },
        settled: state.settled && !state.collection_pending,
        unknown: state.unknown,
        error_code: state.code.clone(),
        metadata: Value::Null,
        outputs: if state.status == "succeeded" {
            state.result.clone().into_iter().collect()
        } else {
            Vec::new()
        },
    };
    drop(state);
    let mut metadata = Arc::unwrap_or_clone(snapshot);
    metadata["gatewayJobId"] = json!(job.id);
    if let Some((progress, text)) = manga {
        metadata["progress"] = json!(progress);
        metadata["progressText"] = text.into();
    }
    if let Some(finished) = finished {
        // Durable task adapters also need the frozen engine duration. Do not
        // persist a ticking duration and rewrite SQLite on every live poll.
        metadata["elapsedSeconds"] = json!((finished - job.created).max(0) / 1000);
    }
    observation.metadata = metadata;
    Ok(observation)
}
pub(super) async fn result(
    inner: &Arc<Inner>,
    id: &str,
    owner: &str,
    family: Option<&str>,
) -> Result<Output> {
    let job = find_scoped(inner, id, owner, family.is_none(), family).await?;
    let state = job.state.lock().await;
    if state.status != "succeeded" {
        if family.is_some() {
            return Err(ApiError::new(
                if state.status == "failed" { 502 } else { 409 },
                state.code.as_deref().unwrap_or("RESULT_NOT_READY"),
                state.error.as_deref().unwrap_or("结果尚未就绪"),
            ));
        }
        return Err(ApiError::new(404, "RESULT_NOT_FOUND", "结果不存在"));
    }
    state
        .result
        .clone()
        .ok_or_else(|| ApiError::new(404, "RESULT_NOT_FOUND", "结果不存在"))
}
pub(super) async fn release(job: &Job) {
    job.state.lock().await.release_capacity();
}
pub(super) async fn discard_output(job: &Job) {
    let result = {
        let mut state = job.state.lock().await;
        state.collection_pending = false;
        state.result.take()
    };
    if let Some(Output::File { path, .. }) = result {
        native::manga::discard(job, &path).await;
        let _ = tokio::fs::remove_file(&path).await;
        if job.provider == "native" {
            native::recovery::forget(&path).await;
        }
    }
}
pub(super) async fn remove(inner: &Inner, job: &Job) {
    discard_output(job).await;
    release(job).await;
    inner.state.lock().await.jobs.remove(&job.id);
    snapshots::remove(inner, &job.id).await;
}
pub(super) async fn fail(job: &Job, error: ApiError, unknown: bool) {
    let mut state = job.state.lock().await;
    if state.status == "cancelled"
        || (state.status == "cancelling"
            && (!unknown || (job.provider == "comfy" && !state.upstream_id.is_empty())))
    {
        return;
    }
    state.status = "failed".into();
    state.finished = Some(now());
    state.error = Some(error.message);
    state.code = Some(error.code);
    state.unknown = unknown;
    state.settled = !unknown;
    if !unknown {
        state.release_capacity();
    }
    drop(state);
    job.notify.notify_waiters();
    if !unknown {
        notify_settled(job);
    }
}
pub(super) fn notify_settled(job: &Job) {
    // Unknown may have stopped the runtime watcher. Call without provider locks.
    if let Some(hooks) = &job.hooks {
        hooks.observation_changed();
    }
}

/// Upstream completion and durable result collection are distinct facts. Keep
/// the successful result even if the workspace write fails, and retry only the
/// idempotent collection hook, never a generation request.
pub(super) async fn succeed(inner: &Arc<Inner>, job: &Arc<Job>, output: Output) {
    // A cancellation can win before publication; hold the same claim as native
    // cancel only while committing the durable copy and terminal transition.
    let archive = inner.archive_for(job);
    let _publication = if archive.is_some() {
        Some(job.collection.lock().await)
    } else {
        None
    };
    let digest = if let Some(archive) = archive.filter(|_| !inner.cancel.is_cancelled()) {
        let running = job.state.lock().await.status == "running";
        if running {
            match archive.publish(job, &output).await {
                Ok(digest) => Some(digest),
                Err(error) => {
                    // Preserve the existing live result if the archive drive
                    // is full. The history explains the retention failure.
                    archive
                        .finish(job, "succeeded", Some(&error.message), Some(&error.code))
                        .await;
                    None
                }
            }
        } else {
            None
        }
    } else {
        None
    };
    {
        let mut state = job.state.lock().await;
        if state.status != "running" {
            drop(state);
            if matches!(job.provider, "webui" | "native") {
                snapshots::remove(inner, &job.id).await;
            }
            if let Output::File { path, .. } = output {
                native::manga::discard(job, &path).await;
                let _ = tokio::fs::remove_file(&path).await;
                if job.provider == "native" {
                    native::recovery::forget(&path).await;
                }
            }
            return;
        }
        state.result = Some(output);
        state.result_sha256 = digest;
        state.status = "succeeded".into();
        state.settled = true;
        state.unknown = false;
        state.finished = Some(now());
        state.error = None;
        state.code = None;
        state.progress = Some(1.);
        state.progress_text = "生成完成".into();
        state.collection_pending = job.hooks.is_some();
        // The GPU has completed; storage retries must not retain GPU capacity.
        state.release_capacity();
    }
    drop(_publication);
    job.notify.notify_waiters();
    if job.hooks.is_none() {
        return;
    }
    let worker = inner.clone();
    let job = job.clone();
    // Keep completion above in the queue runner so a late cancel sees a terminal
    // job. Even the first storage attempt must not block the next WebUI request.
    inner.tasks.spawn(async move {
        if try_collect(&worker, &job).await {
            return;
        }
        for seconds in [1, 2, 4] {
            tokio::select! {_=worker.cancel.cancelled()=>return,_=tokio::time::sleep(Duration::from_secs(seconds))=>{}}
            if try_collect(&worker, &job).await {
                return;
            }
        }
        // No permanent worker: explicit/active query can retry once under the
        // same claim after the finite background budget has been used.
    });
}
async fn try_collect(inner: &Inner, job: &Job) -> bool {
    let Ok(_claim) = job.collection.try_lock() else {
        return false;
    };
    let output = {
        let state = job.state.lock().await;
        if !state.collection_pending || state.status != "succeeded" {
            return true;
        }
        let Some(output) = state.result.clone() else {
            return false;
        };
        output
    };
    let result = if let Some(hooks) = &job.hooks {
        // Applies to the first attempt, retries and query reconciliation. Drop
        // the hook future/claim on shutdown before tracked workers can finish.
        tokio::select! {
            biased;
            _ = inner.cancel.cancelled() => return true,
            result = native::manga::collect(job, hooks.as_ref(), output.clone()) => result,
        }
    } else {
        Ok(())
    };
    let mut state = job.state.lock().await;
    if state.status != "succeeded" {
        state.collection_pending = false;
        return true;
    }
    match result {
        Ok(()) => {
            state.collection_pending = false;
            state.code = None;
            state.error = None;
            Arc::make_mut(&mut state.metadata)["resultCollectionError"] = Value::Null;
        }
        Err(error) => {
            state.code = Some("RESULT_COLLECTION_PENDING".into());
            state.error = Some("生成已完成，结果保存等待重试".into());
            Arc::make_mut(&mut state.metadata)["resultCollectionError"] = json!(error.code);
        }
    }
    let complete = !state.collection_pending;
    drop(state);
    job.notify.notify_waiters();
    // The collect hook has committed. Filesystem cleanup only needs the
    // collection claim, so status and progress reads can already proceed.
    if complete {
        if job.provider == "native"
            && let Output::File { path, .. } = &output
        {
            native::recovery::forget(path).await;
        }
        if matches!(job.provider, "webui" | "native") {
            snapshots::remove(inner, &job.id).await;
        }
    }
    complete
}
