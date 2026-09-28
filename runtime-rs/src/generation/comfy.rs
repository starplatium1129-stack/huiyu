mod cancellation;
use super::*;
use reqwest::Method;
type FamilyGate = Arc<Mutex<Option<String>>>;
static FAMILIES: std::sync::LazyLock<Mutex<HashMap<String, FamilyGate>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
pub(super) async fn cancel(inner: Arc<Inner>, job: Arc<Job>) -> Result<()> {
    cancellation::cancel(inner, job).await
}
fn encode(value: &str) -> String {
    percent_encoding::utf8_percent_encode(value, percent_encoding::NON_ALPHANUMERIC).to_string()
}
fn watch(inner: &Inner, id: &str, active: bool) {
    if let Some(initialized) = inner.initialized.get()
        && let Some(progress) = &*initialized.progress.lock().unwrap()
    {
        if active {
            progress.watch(id)
        } else {
            progress.unwatch(id)
        }
    }
}

pub(super) async fn submit(inner: Arc<Inner>, job: Arc<Job>) -> Result<()> {
    let Execution::Comfy(plan) = &job.execution else {
        unreachable!("Comfy executor owns Comfy plans")
    };
    for file in &plan.resources {
        if !tokio::fs::metadata(file).await.is_ok_and(|m| m.is_file()) {
            jobs::remove(&inner, &job).await;
            return Err(ApiError::new(
                503,
                "COMFY_RESOURCES_UNAVAILABLE",
                "所选模型或输入资源不可用",
            ));
        }
    }
    let host = crate::upstream::local_url(&inner.config.comfy_host)?.to_string();
    let gate = FAMILIES
        .lock()
        .await
        .entry(host)
        .or_insert_with(|| Arc::new(Mutex::new(None)))
        .clone();
    let mut family =
        tokio::select! {guard=gate.lock()=>guard,_=inner.cancel.cancelled()=>return Err(closed())};
    if family.as_deref() != Some(plan.family) {
        let _ = inner
            .json(
                "comfy",
                Method::POST,
                "/free",
                Some(&json!({"unload_models":true,"free_memory":true})),
                Duration::from_secs(8),
                &inner.cancel,
            )
            .await;
    }
    if inner.cancel.is_cancelled() {
        return Err(closed());
    }
    if job.state.lock().await.status == "cancelled" {
        return Ok(());
    }
    if let Some(hooks) = &job.hooks
        && let Err(error) = hooks.submitting("comfy".into(), String::new()).await
    {
        jobs::remove(&inner, &job).await;
        return Err(error);
    }
    let initialized = inner
        .initialized
        .get()
        .expect("service initialized before submission");
    {
        let mut state = job.state.lock().await;
        if state.status == "cancelled" {
            return Ok(());
        }
        state.status = "submitting".into();
    }
    let response=inner.json("comfy",Method::POST,"/prompt",Some(&json!({"prompt":plan.workflow,"client_id":initialized.client_id,"extra_data":{"aics_session_id":initialized.session_id}})),Duration::from_secs(20),&inner.cancel).await;
    if response.is_ok() {
        *family = Some(plan.family.into());
    } else {
        *family = None;
    }
    drop(family);
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            let code = error.code.clone();
            let message = error.message.clone();
            jobs::fail(&job, error, true).await;
            return Err(ApiError::new(502, code, message));
        }
    };
    let upstream = response["prompt_id"]
        .as_str()
        .filter(|id| !id.is_empty() && id.encode_utf16().count() <= 200)
        .ok_or_else(|| ApiError::new(502, "COMFY_INVALID_RESPONSE", "ComfyUI 未返回有效任务 ID"));
    let upstream = match upstream {
        Ok(id) => id.to_string(),
        Err(error) => {
            jobs::fail(&job, ApiError::new(502, &error.code, &error.message), true).await;
            return Err(error);
        }
    };
    let was_cancelling = {
        let mut state = job.state.lock().await;
        state.upstream_id = upstream.clone();
        state.metadata["upstreamId"] = json!(upstream);
        let cancelling = state.status == "cancelling";
        if !cancelling {
            state.status = "running".into();
        }
        state.progress_text = "已提交，等待 ComfyUI 执行…".into();
        cancelling
    };
    watch(&inner, &upstream, true);
    let observed = if let Some(hooks) = &job.hooks {
        let mut metadata = job.state.lock().await.metadata.clone();
        metadata["gatewayJobId"] = json!(job.id);
        hooks.observed(upstream, metadata).await
    } else {
        Ok(())
    };
    {
        let mut state = job.state.lock().await;
        state.observed = observed.is_ok();
        state.unknown = observed.is_err();
    }
    let worker = inner.clone();
    let target = job.clone();
    inner.tasks.spawn(async move {
        poll(worker, target).await;
    });
    if was_cancelling {
        cancellation::request(inner.clone(), job).await;
    }
    observed
}
async fn poll(inner: Arc<Inner>, job: Arc<Job>) {
    let Execution::Comfy(plan) = &job.execution else {
        unreachable!()
    };
    let mut failures = 0;
    let mut delay = Duration::ZERO;
    loop {
        tokio::select! {_=inner.cancel.cancelled()=>return,_=job.notify.notified()=>{},_=tokio::time::sleep(delay)=>{}}
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
        if status != "failed" && now() - job.created > plan.timeout.as_millis() as i64 {
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
        let result = inner
            .json(
                "comfy",
                Method::GET,
                &format!("/history/{}", encode(&id)),
                None,
                Duration::from_secs(10),
                &inner.cancel,
            )
            .await;
        match result {
            Ok(history) => {
                failures = 0;
                delay = Duration::from_millis(500);
                let current = job.state.lock().await;
                if current.status != "running" && !(current.status == "failed" && !current.settled)
                {
                    continue;
                }
                drop(current);
                let entry = &history[&id];
                if entry.is_null() {
                    continue;
                }
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
                {
                    let mut state = job.state.lock().await;
                    if state.status == "failed" && !state.settled {
                        state.status = "running".into();
                        state.unknown = false;
                    }
                }
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
                let materialized = if plan.media_kind == MediaKind::Video {
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
                    output::materialize(&inner, &job, image).await
                };
                match materialized {
                    Ok(output) => {
                        jobs::succeed(&inner, &job, output).await;
                    }
                    Err(error) => {
                        let known = matches!(
                            error.code.as_str(),
                            "INVALID_RESULT" | "COMFY_NO_IMAGE" | "RESULT_SAVE_FAILED"
                        );
                        if known {
                            jobs::fail(&job, error, false).await;
                        } else {
                            failures += 1;
                        }
                    }
                }
            }
            Err(error) => {
                failures += 1;
                if failures >= 60 {
                    jobs::fail(&job, error, true).await;
                }
                delay = Duration::from_millis((500 * failures as u64).min(3000));
            }
        }
    }
}
fn execution_error(entry: &Value) -> String {
    if let Some(error) = entry["status"]["messages"]
        .as_array()
        .and_then(|a| a.iter().find(|m| m[0] == "execution_error"))
    {
        format!(
            "{}: {}",
            error[1]["exception_type"].as_str().unwrap_or(""),
            error[1]["exception_message"]
                .as_str()
                .unwrap_or("")
                .chars()
                .take(1500)
                .collect::<String>()
        )
    } else {
        "ComfyUI 执行失败".into()
    }
}
