use super::*;
pub(super) fn wai_metadata(input: &Input, provider: &str) -> Value {
    let loras = input
        .loras
        .iter()
        .map(|l| json!({"id":l.id,"strength":l.strength}))
        .collect::<Vec<_>>();
    let mut metadata = json!({"engine":"sd","provider":provider,"modelId":input.model_id,"profileId":input.profile,"loras":loras,"loraId":input.loras.first().map(|l|&l.id),"loraStrength":input.loras.first().map(|l|l.strength),"width":input.width,"height":input.height,"steps":input.steps,"cfg":input.cfg,"sampler":input.sampler,"scheduler":input.scheduler,"seed":input.seed,"hiresFix":input.hires_fix,"hiresUpscaler":if input.hires_fix{Some(&input.hires_upscaler)}else{None},"hiresScale":input.hires_fix.then_some(input.hires_scale)});
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
    prepared: Prepared,
    owner: String,
    hooks: Option<Arc<dyn ExecutionHooks>>,
) -> Arc<Job> {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let created = now();
    let input = prepared.execution.input();
    let mut metadata = match &prepared.execution {
        Execution::Webui(input) => wai_metadata(input, "webui"),
        Execution::Comfy(plan) => plan.metadata.clone(),
    };
    metadata["id"] = json!(id);
    if prepared.selected == "comfy" {
        metadata["createdAt"] = json!(created);
    }
    Arc::new(Job {
        id,
        owner,
        input,
        execution: prepared.execution,
        provider: prepared.selected,
        created,
        state: Mutex::new(JobState {
            status: "queued".into(),
            result: None,
            error: None,
            code: None,
            metadata,
            upstream_id: String::new(),
            progress: None,
            current_node: None,
            progress_text: "等待提交到 ComfyUI…".into(),
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
    snapshots::initialize(inner.clone()).await?;
    let state = inner.state.lock().await;
    if let Some(job) = state.jobs.get(id).filter(|j| j.owner == owner) {
        return Ok(job.clone());
    }
    if state
        .lost
        .get(id)
        .is_some_and(|stored| stored.owner == owner)
    {
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
        } else {
            "任务不存在"
        },
    ))
}
pub(super) async fn public(job: &Job) -> Result<Value> {
    let state = job.state.lock().await;
    let available =
        state.status == "succeeded" && state.result.as_ref().is_some_and(|r| !r.is_empty());
    let result_url =
        available.then(|| format!("{}/jobs/{}/result", job.execution.route_base(), job.id));
    let seed = state.metadata["seed"]
        .as_u64()
        .filter(|s| *s <= 9_007_199_254_740_991)
        .unwrap_or(job.input["seed"].as_u64().unwrap_or(0));
    let mut metadata = state.metadata.clone();
    metadata["provider"] = json!(job.provider);
    let mut public = json!({"id":job.id,"status":state.status,"provider":job.provider,"seed":seed,"resultAvailable":available,"resultUrl":result_url,"metadata":metadata,"error":state.error,"code":state.code});
    if job.provider == "comfy" {
        public["progress"] = if state.status == "succeeded" {
            json!(1)
        } else if state.status == "queued" {
            json!(0)
        } else {
            json!(state.progress)
        };
        public["elapsedSeconds"] =
            json!((state.finished.unwrap_or_else(now) - job.created).max(0) / 1000);
        public["currentNode"] = json!(state.current_node);
        public["progressText"] = json!(state.progress_text);
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
        try_collect(&job).await;
    }
    let state = job.state.lock().await;
    let mut metadata = state.metadata.clone();
    metadata["gatewayJobId"] = json!(job.id);
    Ok(Observation {
        status: if state.collection_pending && state.status == "succeeded" {
            "running".into()
        } else {
            state.status.clone()
        },
        settled: state.settled && !state.collection_pending,
        unknown: state.unknown,
        error_code: state.code.clone(),
        metadata,
        outputs: if state.status == "succeeded" {
            state.result.clone().into_iter().collect()
        } else {
            Vec::new()
        },
    })
}
pub(super) async fn result(inner: &Arc<Inner>, id: &str, owner: &str) -> Result<Output> {
    let job = find(inner, id, owner, true).await?;
    let state = job.state.lock().await;
    if state.status != "succeeded" {
        return Err(ApiError::new(404, "RESULT_NOT_FOUND", "结果不存在"));
    }
    state
        .result
        .clone()
        .ok_or_else(|| ApiError::new(404, "RESULT_NOT_FOUND", "结果不存在"))
}
pub(super) async fn release(job: &Job) {
    job.state.lock().await.permit.take();
}
pub(super) async fn discard_output(job: &Job) {
    let result = {
        let mut state = job.state.lock().await;
        state.collection_pending = false;
        state.result.take()
    };
    if let Some(Output::File { path, .. }) = result {
        let _ = tokio::fs::remove_file(path).await;
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
        state.permit.take();
    }
    job.notify.notify_waiters();
}

/// Upstream completion and durable result collection are distinct facts. Keep
/// the successful result even if the workspace write fails, and retry only the
/// idempotent collection hook, never a generation request.
pub(super) async fn succeed(inner: &Arc<Inner>, job: &Arc<Job>, output: Output) {
    {
        let mut state = job.state.lock().await;
        if state.status != "running" {
            drop(state);
            if let Output::File { path, .. } = output {
                let _ = tokio::fs::remove_file(path).await;
            }
            return;
        }
        state.result = Some(output);
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
        state.permit.take();
    }
    job.notify.notify_waiters();
    if try_collect(job).await {
        return;
    }
    let worker = inner.clone();
    let job = job.clone();
    inner.tasks.spawn(async move{
        for seconds in [1,2,4]{
            tokio::select!{_=worker.cancel.cancelled()=>return,_=tokio::time::sleep(Duration::from_secs(seconds))=>{}}
            if try_collect(&job).await{return}
        }
        // No permanent worker: explicit/active query can retry once under the
        // same claim after the finite background budget has been used.
    });
}
async fn try_collect(job: &Job) -> bool {
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
        hooks.collect(vec![output]).await
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
            state
                .metadata
                .as_object_mut()
                .unwrap()
                .remove("resultCollectionError");
        }
        Err(error) => {
            state.code = Some("RESULT_COLLECTION_PENDING".into());
            state.error = Some("生成已完成，结果保存等待重试".into());
            state.metadata["resultCollectionError"] = json!(error.code);
        }
    }
    let complete = !state.collection_pending;
    drop(state);
    job.notify.notify_waiters();
    complete
}
