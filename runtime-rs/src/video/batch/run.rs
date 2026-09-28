use super::*;
pub(super) async fn execute(service: Arc<Service>, batch: Arc<Batch>, mut first: Option<Prepared>) {
    let _gate = batch.serial.lock().await;
    loop {
        let (index, input, cancel) = {
            let state = batch.state.lock().await;
            if state.status != "running" || state.cancel.is_cancelled() {
                return;
            }
            let Some(index) = state.shots.iter().position(|s| s.status == "pending") else {
                drop(state);
                finish(&batch).await;
                return;
            };
            (
                index,
                state.shots[index].input.clone(),
                state.cancel.clone(),
            )
        };
        let result = async {
            let prepared = if index == 0 && first.is_some() {
                first.take().unwrap()
            } else {
                let input = batch_input::recompose(&input, &batch.input)?;
                if let Some(hooks) = &batch.hooks {
                    resume::restore(&service.config, &input, hooks.as_ref(), &cancel).await?;
                }
                batch.state.lock().await.shots[index].input = input.clone();
                service
                    .prepare_input(input, true, None, true, cancel.clone())
                    .await?
            };
            {
                let mut state = batch.state.lock().await;
                if state.cancel.is_cancelled() {
                    return Err(error(499, "VIDEO_BATCH_CANCELLED", "分镜任务已取消"));
                }
                let shot = &mut state.shots[index];
                shot.status = "queued".into();
                shot.attempts += 1;
            }
            batch.save().await?;
            let hooks = Arc::new(hooks::ShotHooks {
                batch: batch.clone(),
                index,
            });
            let job = service
                .clone()
                .submit(prepared, batch.owner.clone(), Some(hooks))
                .await?;
            let id = job["id"].as_str().unwrap().to_string();
            loop {
                let observation = service.query(&id, &batch.owner).await?;
                if observation.settled || observation.unknown {
                    if observation.status == "succeeded" {
                        return Ok(observation.outputs.into_iter().next());
                    }
                    return Err(error(
                        502,
                        observation
                            .error_code
                            .as_deref()
                            .unwrap_or(if observation.unknown {
                                "BATCH_UPSTREAM_UNKNOWN"
                            } else {
                                "VIDEO_FAILED"
                            }),
                        "分镜生成未完成",
                    ));
                }
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(250)) => {},
                    _ = cancel.cancelled() => {
                        let _ = service.cancel(&id, &batch.owner).await;
                        return Err(error(499, "VIDEO_BATCH_CANCELLED", "分镜取消尚待上游确认"));
                    }
                }
            }
        }
        .await;
        match result {
            Ok(output) => {
                let mut state = batch.state.lock().await;
                state.shots[index].status = "succeeded".into();
                if output.is_some() {
                    state.shots[index].result = output;
                }
                let link = batch.input["linkLastFrame"] == true
                    && state.shots.get(index + 1).is_some_and(|s| {
                        s.status == "pending" && !generation::truthy(&s.input["references"])
                    });
                let output = state.shots[index].result.clone();
                drop(state);
                if link && let Some(output) = output {
                    match transcode::tail(&service, &output, cancel.clone()).await {
                        Ok(name) => {
                            let mut state = batch.state.lock().await;
                            state.shots[index].tail = Some(name.clone());
                            let next = &mut state.shots[index + 1];
                            let key = if generation::truthy(&next.input["image"]) {
                                "lastFrame"
                            } else {
                                "image"
                            };
                            next.input[key] = json!(name);
                        }
                        Err(e) => {
                            if cancel.is_cancelled() {
                                pause(&batch, index, e, true).await;
                                return;
                            } /* Legacy extraction failure proceeds without a tail. */
                        }
                    }
                }
                if let Err(e) = batch.save().await {
                    pause(&batch, index, e, false).await;
                    return;
                }
            }
            Err(e) => {
                let intent = batch.state.lock().await.shots[index].intent.is_some();
                if batch.hooks.is_some() || cancel.is_cancelled() {
                    pause(&batch, index, e, intent).await;
                    return;
                }
                let mut state = batch.state.lock().await;
                state.shots[index].status = "failed".into();
                state.shots[index].code = Some(e.code);
                state.shots[index].error = Some(e.message);
            }
        }
    }
}
async fn pause(batch: &Batch, index: usize, e: ApiError, unknown: bool) {
    let mut state = batch.state.lock().await;
    state.status = if state.cancel.is_cancelled() && !unknown {
        "cancelled"
    } else {
        "paused"
    }
    .into();
    state.unknown = unknown;
    state.error_code = Some(if unknown {
        "BATCH_SUBMISSION_UNCONFIRMED".into()
    } else {
        e.code.clone()
    });
    state.shots[index].code = Some(e.code);
    state.shots[index].error = Some(e.message);
    drop(state);
    let _ = batch.save().await;
}
async fn finish(batch: &Batch) {
    let mut state = batch.state.lock().await;
    state.status = if state.shots.iter().all(|s| s.status == "succeeded") {
        "done"
    } else if state
        .shots
        .iter()
        .all(|s| ["succeeded", "cancelled"].contains(&s.status.as_str()))
    {
        "cancelled"
    } else {
        "paused"
    }
    .into();
    drop(state);
    if batch.save().await.is_err() {
        let mut s = batch.state.lock().await;
        s.status = "paused".into();
        s.error_code = Some("BATCH_CHECKPOINT_FAILED".into());
    }
}
