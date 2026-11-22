use super::*;

pub(super) async fn run(inner: &Arc<Inner>, job: &Arc<Job>, token: &CancellationToken) -> Result<Output> {
    let Execution::Native(plan) = &job.execution else {
        unreachable!()
    };
    let control = inner.control.read().unwrap().upgrade();
    if let Some(control) = control.filter(|_| {
        plan.input["family"] != "manga-screen"
            || plan.input["rewrite"].is_object()
            || plan.input["autoLines"] == true
    }) {
        let native_only = plan.input["family"] == "keyframe" || plan.input["modelId"] == crate::studio_workflows::MODEL
            || plan.input["modelId"] == crate::studio_workflows::DIALOGUE;
        control.ensure_native_drawing(token, native_only).await?;
    }
    if let Some(hooks) = &job.hooks {
        tokio::select! { biased; _=token.cancelled()=>return Err(closed()), result=hooks.submitting("native".into())=>result? }
    }
    if token.is_cancelled() || job.state.lock().await.status == "cancelling" {
        return Err(ApiError::new(499, "ABORT_ERR", "独立推理已取消"));
    }
    let output_dir = inner.config.runtime_root.join("outputs/native");
    tokio::fs::create_dir_all(&output_dir).await?;
    let temp = Arc::new(
        tempfile::Builder::new()
            .prefix("native-")
            .tempdir_in(&output_dir)?,
    );
    let video = plan.input["mediaKind"] == "video";
    let output = temp
        .path()
        .join(if video { "result.mp4" } else { "result.png" });
    // Already accepted files are private snapshots, never mutable upload paths.
    let mut inputs = Vec::new();
    let mut accepted = |input: Option<InputFile>| -> Result<Option<PathBuf>> {
        input
            .map(|input| {
                input.check()?;
                let path = input.path().to_owned();
                inputs.push(input);
                Ok(path)
            })
            .transpose()
    };
    let input_image_path = accepted(plan.init_image.lock().unwrap().take())?;
    let last_frame_path = accepted(plan.last_frame.lock().unwrap().take())?;
    let driver_path = accepted(plan.driving_media.lock().unwrap().take())?;
    let mask_image_path = accepted(plan.mask_image.lock().unwrap().take())?;
    let pen_lines_path = accepted(plan.pen_lines.lock().unwrap().take())?;
    let sketch_image_path = accepted(plan.sketch_image.lock().unwrap().take())?;
    let references = std::mem::take(&mut *plan.reference_images.lock().unwrap());
    let mut reference_paths = Vec::new();
    for input in references {
        if token.is_cancelled() {
            return Err(ApiError::new(499, "ABORT_ERR", "参考图准备已取消"));
        }
        reference_paths.push(accepted(Some(input))?.unwrap());
    }
    let mut request = if plan.input["family"] == "manga-screen" {
        output::manga_request(job, plan, &output, input_image_path, pen_lines_path)
    } else if adapters::model(plan.input["modelId"].as_str().unwrap_or("")).is_some() {
        output::adapter_request(job, plan, &output, input_image_path)
    } else {
        output::anima_request(
            job,
            plan,
            &output,
            input_image_path,
            mask_image_path,
            sketch_image_path,
        )
    };
    if !reference_paths.is_empty() {
        request["referenceImagePaths"] = json!(reference_paths);
    }
    if let Some(path) = last_frame_path {
        request["lastFramePath"] = json!(path);
    }
    if let Some(path) = driver_path {
        let key = if plan.input["drivingAudio"].is_string() { "drivingAudioPath" } else { "drivingVideoPath" };
        request[key] = json!(path);
    }
    let files = Arc::new(RunFiles {
        _output: temp.clone(),
        _inputs: inputs,
    });
    let failure = match attempt(inner, job, token, &request, &files, &output, true).await {
        Err(error) if !token.is_cancelled() && error.code == "OUT_OF_MEMORY"
            && wan_attempt::conservative(&mut request["input"]).is_some() => error,
        result => return result,
    };
    let cause: String = failure.message.chars().filter(|c| !c.is_control()).take(1200).collect();
    let retry = json!({"attempt":2,"reason":"oom","cause":cause,"width":request["input"]["width"],
        "height":request["input"]["height"],"memoryTier":"conservative"});
    let next = temp.path().join("result-retry.mp4");
    request["outputPath"] = json!(next);
    {
        let mut state = job.state.lock().await;
        if state.status == "cancelling" {
            return Err(closed());
        }
        state.progress = None;
        state.preview_data_url = None;
        state.progress_text = "上一轮内存不足，正以节省显存的设置重试".into();
        Arc::make_mut(&mut state.metadata)["gpuRetry"] = retry.clone();
    }
    if let Some(hooks) = &job.hooks {
        hooks.execution_metadata(json!({"gpuRetry":retry})).await?;
    }
    attempt(inner, job, token, &request, &files, &next, false).await
}

async fn attempt(
    inner: &Arc<Inner>,
    job: &Arc<Job>,
    token: &CancellationToken,
    request: &Value,
    files: &Arc<RunFiles>,
    output: &std::path::Path,
    first_attempt: bool,
) -> Result<Output> {
    let Execution::Native(plan) = &job.execution else { unreachable!() };
    if token.is_cancelled() {
        return Err(closed());
    }
    let video = plan.input["mediaKind"] == "video";
    let mut worker = inner.native.take_worker(&plan.settings, queue::model(&plan.input)).await?;
    *worker.current_temp.lock().unwrap() = Some(files.clone());
    // Do not interrupt a partially written JSONL request with another command.
    // The stdin reader operates independently of loading and CUDA execution.
    let sent = tokio::time::timeout(Duration::from_secs(10), async {
        worker
            .input
            .write_all(format!("{}\n", request).as_bytes())
            .await?;
        worker.input.flush().await
    })
    .await;
    match sent {
        Ok(Ok(())) => {}
        value => {
            worker.stop().await?;
            return match value {
                Ok(Err(error)) => Err(error.into()),
                _ => Err(ApiError::new(504, "NATIVE_TIMEOUT", "独立推理请求发送超时")),
            };
        }
    }
    let mut produced = false;
    let mut ready = false;
    let mut host_failure = false;
    let result = async {
        let mut runtime_observation = Value::Null;
        let events = async {
            {
                let mut state = job.state.lock().await;
                if state.status == "cancelling" {
                    return Err(ApiError::new(499, "ABORT_ERR", "独立推理已取消"));
                }
                state.status = "running".into();
                state.upstream_id = job.id.clone();
                state.progress_text = "独立推理准备生成".into();
            }
            if first_attempt && let Some(hooks) = &job.hooks {
                hooks
                    .observed(
                        job.id.clone(),
                        json!({"gatewayJobId":job.id,"provider":"native"}),
                    )
                    .await?;
            }
            loop {
                let event = worker.event(&job.id).await?;
                match event["event"].as_str() {
                    Some("stage") if !produced => {
                        let text = stage_text(&event)?;
                        let mut state = job.state.lock().await;
                        state.current_node = event["stage"].as_str().map(str::to_owned);
                        state.progress_text = text;
                        if plan.input["family"] == "manga-screen" {
                            state.progress = None;
                        }
                    }
                    Some("progress") if !produced => {
                        let (step, total, sampling) = output::progress(&event)?;
                        let preview = wan_attempt::preview(&event);
                        let mut state = job.state.lock().await;
                        if preview.is_some() {
                            state.preview_data_url = preview;
                        }
                        state.progress = Some(step as f64 / total as f64);
                        state.progress_text = if let Some(sampling) = sampling {
                            sampling
                        } else if plan.input["mossUpscaleScale"].is_number() {
                            format!("Remacri 放大 {step}/{total}")
                        } else {
                            format!("独立推理 {step}/{total}")
                        };
                    }
                    Some("result") if !produced => {
                        if event["outputPath"].as_str() != output.to_str() {
                            return Err(protocol_error());
                        }
                        runtime_observation = observations::capture(&event["nativeRuntime"]);
                        // Single-shot CLI adapters report no resident context. Accept an
                        // affirmative runtime observation before advertising retained weights.
                        worker.model_loaded = event["modelReused"].is_boolean()
                            || event["nativeRuntime"]["contextId"].is_string()
                            || event["nativeRuntime"]["weightReuse"] == true;
                        produced = true;
                    }
                    Some("ready") if produced => {
                        ready = true;
                        return Ok(());
                    }
                    Some("error") => {
                        return Err(ApiError::new(
                            502,
                            event["code"].as_str().unwrap_or("NATIVE_EXECUTION_FAILED"),
                            event["message"].as_str().unwrap_or("独立推理失败"),
                        ));
                    }
                    _ => return Err(protocol_error()),
                }
            }
        };
        events.await?;
        // Output paths are chosen by this runtime, never accepted from worker input.
        let metadata = tokio::fs::symlink_metadata(&output).await?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len()
                > if video {
                    256 * 1024 * 1024
                } else {
                    32 * 1024 * 1024
                }
        {
            return Err(protocol_error());
        }
        if let Err(error) = output::validate(&output, video, token).await {
            // Host decoder admission says nothing about worker integrity.
            host_failure = error.code == "IMAGE_STORAGE_BUSY";
            return Err(error);
        }
        manga::validate(job, &output, token).await?;
        let length = metadata.len();
        // Do not block cancellation or observation while reading the PNG header.
        let read_dimensions =
            plan.input["family"] == "manga-screen" && job.state.lock().await.status == "running";
        let dimensions = if read_dimensions {
            Some(output::png_dimensions(&output).await)
        } else {
            None
        };
        {
            let mut state = job.state.lock().await;
            if state.status == "running" {
                let metadata = Arc::make_mut(&mut state.metadata);
                metadata["nativeRuntime"] = runtime_observation;
                if !first_attempt {
                    metadata["width"] = request["input"]["width"].clone();
                    metadata["height"] = request["input"]["height"].clone();
                }
                if let Some(dimensions) = dimensions {
                    let device = metadata["nativeRuntime"]["device"].clone();
                    if matches!(device.as_str(), Some("cpu" | "cuda+cpu")) {
                        metadata["device"] = device;
                    }
                    let (width, height) = dimensions?;
                    metadata["width"] = json!(width);
                    metadata["height"] = json!(height);
                }
            }
        }
        // Save effective output dimensions and verified worker observations before
        // the result collector settles the desktop task. The original input stays frozen.
        if (plan.input["modelId"] == crate::studio_workflows::MODEL || plan.input["modelId"] == crate::studio_workflows::DIALOGUE || plan.input["family"] == "keyframe")
            && let Some(hooks) = &job.hooks {
            let snapshot = job.state.lock().await.metadata.clone();
            hooks.execution_metadata(json!({"nativeRuntime":snapshot["nativeRuntime"],
                "width":request["input"]["width"],"height":request["input"]["height"]})).await?;
        }
        let publication = results::publish(inner, job, output, length, token).await;
        // Only classify storage failures after the worker's PNG fully decoded.
        host_failure = publication
            .as_ref()
            .err()
            .is_some_and(|error| error.code == "STORAGE_UNAVAILABLE");
        publication
    };
    let cold_load = matches!(plan.input["family"].as_str(), Some("moss-image" | "keyframe"));
    let timeout = Duration::from_secs(if video || cold_load { 1800 } else { 600 });
    let value = tokio::select! { biased; _=token.cancelled()=>Err(ApiError::new(499,"ABORT_ERR","独立推理已取消")), value=tokio::time::timeout(timeout,result)=>value.unwrap_or_else(|_| Err(ApiError::new(504,"NATIVE_TIMEOUT","独立推理超时"))) };
    let cancelling = value.as_ref().err().is_some_and(|error| {
        token.is_cancelled() && matches!(error.code.as_str(), "ABORT_ERR" | "CANCELLED")
    });
    let retain = if value.is_ok() || (ready && (cancelling || host_failure)) {
        true
    } else if cancelling {
        match worker.cancel_and_wait(&job.id, produced, &output).await {
            Ok(()) => true,
            Err(error) => {
                eprintln!("native cooperative cancellation: {}", error.code);
                false
            }
        }
    } else {
        false
    };
    if retain {
        if cancelling {
            // Cooperative cleanup can evict the adapter context while keeping
            // its Python process alive. Only a new result can confirm residency.
            worker.model_loaded = false;
        }
        // Ready confirms worker-side cleanup; the request keeps its directory Arc.
        worker.current_temp.lock().unwrap().take();
        // Give a successful MOSS drawing session time for a prompt edit. A
        // chat/model handoff can still retire the worker immediately.
        let idle = Duration::from_secs(match plan.input["family"].as_str() {
            Some("moss-image") if value.is_ok() && plan.input["mossUpscaleScale"].is_null() => 300,
            Some("moss-image") => 90,
            _ => 600,
        });
        Engine::retain_worker(inner.clone(), worker, idle).await;
        return value;
    }
    // Unacknowledged cancellation, faults and timeouts still retire the process
    // while its process entry retains the temporary inputs through reap.
    worker.stop().await?;
    inner.native.queue.resident(None);
    value
}
