use super::*;
#[cfg(test)]
mod tests;

pub(super) fn run(
    root: PathBuf,
    id: String,
    epoch: String,
    create: bool,
    mut receiver: mpsc::Receiver<Work>,
    opened: oneshot::Sender<Result<()>>,
    sender: mpsc::WeakSender<Work>,
) {
    let mut context = match schema::open(root, id, epoch, create) {
        Ok(context) => {
            if opened.send(Ok(())).is_err() {
                return;
            }
            context
        }
        Err(error) => {
            let _ = opened.send(Err(error));
            return;
        }
    };
    let mut copying = false;
    let mut collecting: Option<Arc<AtomicBool>> = None;
    let mut closing = Vec::new();
    #[cfg(test)]
    let mut pause = None;
    #[cfg(test)]
    let mut garbage_pause = None;
    while let Some(work) = receiver.blocking_recv() {
        let (work, permit) = match work {
            Work::AdmittedResult(work, permit) => (*work, Some(permit)),
            work => (work, None),
        };
        match work {
            Work::AdmittedResult(..) => unreachable!("result admission cannot be nested"),
            Work::ResultVerified(id, verified) => {
                result_commit::finish(&mut context, id, verified, &sender);
                if !closing.is_empty()
                    && !copying
                    && collecting.is_none()
                    && context.result_commit.is_none()
                {
                    break;
                }
            }
            Work::TaskMediaChunk(chunk, principal, cancel, reply) => {
                if !closing.is_empty() {
                    let _ = reply.send(Err(unavailable()));
                    continue;
                }
                context.cancel = cancel;
                if !reply.is_closed() {
                    if matches!(chunk.target, TaskMediaTarget::Result(_))
                        && context.result_commit.is_some()
                    {
                        let _ = reply.send(Err(result_busy()));
                        continue;
                    }
                    let result = tasks::upload_chunk(&mut context, &principal, chunk);
                    let _ = reply.send(result);
                }
            }
            Work::Task(command, principal, cancel, reply) => {
                if !closing.is_empty() {
                    let _ = reply.send(Err(unavailable()));
                    continue;
                }
                context.cancel = cancel;
                if !reply.is_closed() {
                    let result = tasks::execute_command(&mut context, &principal, command);
                    let _ = reply.send(result);
                }
            }
            Work::Request(command, principal, cancel, reply) => {
                if !closing.is_empty() {
                    let _ = reply.send(Err(unavailable()));
                    continue;
                }
                context.cancel = cancel;
                if reply.is_closed() {
                    continue;
                }
                if result_commit::is_write(&command) && context.result_commit.is_some() {
                    let _ = reply.send(Err(result_busy()));
                    continue;
                }
                if command["kind"] == "task.result.commit" {
                    result_commit::start(
                        &mut context,
                        &command,
                        &principal,
                        reply,
                        permit,
                        &sender,
                    );
                    continue;
                }
                if command["kind"] == "collectGarbage" {
                    if collecting.is_some() {
                        let result =
                            garbage::receipt(&context, &principal, &command).and_then(|receipt| {
                                receipt.ok_or_else(|| {
                                    ApiError::new(
                                        429,
                                        "WORKSPACE_BUSY",
                                        "A workspace garbage discovery is already running",
                                    )
                                })
                            });
                        let _ = reply.send(result);
                        continue;
                    }
                    match garbage::prepare(&mut context, &principal, &command) {
                        Ok(garbage::Prepared::Complete(value)) => {
                            let _ = reply.send(Ok(value));
                        }
                        Ok(garbage::Prepared::Discover(job)) => {
                            let Some(sender) = sender.upgrade() else {
                                let _ = reply.send(Err(unavailable()));
                                continue;
                            };
                            let cancellation = job.completion.cancel.clone();
                            #[cfg(test)]
                            let gate: Option<GarbagePause> = garbage_pause.take();
                            let thread = std::thread::Builder::new()
                                .name("workspace-garbage".into())
                                .spawn(move || {
                                    let result = std::panic::catch_unwind(
                                        std::panic::AssertUnwindSafe(|| job.run()),
                                    )
                                    .unwrap_or_else(|_| {
                                        Err(ApiError::new(
                                            503,
                                            "STORAGE_UNAVAILABLE",
                                            "Workspace garbage discovery failed",
                                        ))
                                    });
                                    #[cfg(test)]
                                    let finished = gate.map(|gate| {
                                        let _ = gate.entered.send(());
                                        let _ = gate.resume.recv();
                                        gate.finished
                                    });
                                    let _ = sender.blocking_send(Work::GarbageFinished(
                                        job.completion,
                                        result,
                                        reply,
                                    ));
                                    #[cfg(test)]
                                    if let Some(finished) = finished {
                                        let _ = finished.send(());
                                    }
                                });
                            if thread.is_ok() {
                                collecting = Some(cancellation);
                            }
                            if let Err(error) = thread {
                                eprintln!("workspace garbage startup: {error}");
                            }
                        }
                        Err(error) => {
                            let _ = reply.send(Err(error));
                        }
                    }
                } else if matches!(command["kind"].as_str(), Some("backup" | "restoreBackup")) {
                    if copying {
                        let _ = reply.send(Err(ApiError::new(
                            429,
                            "WORKSPACE_BUSY",
                            "A workspace copy is already running",
                        )));
                        continue;
                    }
                    match backup::prepare(&mut context, &principal, &command) {
                        Ok(backup::Prepared::Complete(value)) => {
                            let _ = reply.send(Ok(value));
                        }
                        Ok(backup::Prepared::Copy(job)) => {
                            let Some(sender) = sender.upgrade() else {
                                let _ = reply.send(Err(unavailable()));
                                continue;
                            };
                            #[cfg(test)]
                            let gate: Option<CopyPause> = pause.take();
                            let thread = std::thread::Builder::new()
                                .name("workspace-copy".into())
                                .spawn(move || {
                                    #[cfg(test)]
                                    let finished = gate.map(|gate| {
                                        let _ = gate.entered.send(());
                                        let _ = gate.resume.recv();
                                        gate.finished
                                    });
                                    let result = std::panic::catch_unwind(
                                        std::panic::AssertUnwindSafe(|| job.run()),
                                    )
                                    .unwrap_or_else(|_| {
                                        Err(ApiError::new(
                                            503,
                                            "STORAGE_UNAVAILABLE",
                                            "Workspace copy worker failed",
                                        ))
                                    });
                                    let _ = sender.blocking_send(Work::CopyFinished(
                                        job.completion,
                                        result,
                                        reply,
                                    ));
                                    #[cfg(test)]
                                    if let Some(finished) = finished {
                                        let _ = finished.send(());
                                    }
                                });
                            copying = thread.is_ok();
                            if let Err(error) = thread {
                                eprintln!("workspace copy startup: {error}");
                            }
                        }
                        Err(error) => {
                            let _ = reply.send(Err(error));
                        }
                    }
                } else {
                    let result = context.execute(&command, &principal);
                    let _ = reply.send(result);
                }
            }
            Work::Media(alias, cancel, reply) => {
                if !closing.is_empty() {
                    let _ = reply.send(Err(unavailable()));
                    continue;
                }
                context.cancel = cancel;
                if !reply.is_closed() {
                    let result = context.lookup_media(&alias);
                    let _ = reply.send(result);
                }
            }
            Work::CopyFinished(completion, result, reply) => {
                let result = backup::finish(&mut context, completion, result);
                let _ = reply.send(result);
                copying = false;
                if !closing.is_empty() && collecting.is_none() && context.result_commit.is_none() {
                    break;
                }
            }
            Work::GarbageFinished(completion, result, reply) => {
                let result = garbage::finish(&mut context, completion, result);
                let _ = reply.send(result);
                collecting = None;
                if !closing.is_empty() && !copying && context.result_commit.is_none() {
                    break;
                }
            }
            Work::Close(reply) => {
                closing.push(reply);
                if let Some(cancel) = &collecting {
                    cancel.store(true, Ordering::Relaxed);
                }
                if let Some(pending) = &context.result_commit {
                    pending.cancel();
                }
                if !copying && collecting.is_none() && context.result_commit.is_none() {
                    break;
                }
            }
            #[cfg(test)]
            Work::PauseCopy(gate) => {
                pause = Some(gate);
            }
            #[cfg(test)]
            Work::PauseGarbage(gate) => {
                garbage_pause = Some(gate);
            }
        }
    }
    // Refuse admission before acknowledging Close. Each filesystem worker keeps
    // the receiver open until its completion is queued; admitted mutations retain
    // COMMIT_UNKNOWN if shutdown drops their reply without executing them.
    receiver.close();
    // The filesystem workers hold a sender until completion, so channel shutdown
    // cannot release ownership while a background filesystem operation is running.
    let result = context.shutdown();
    for reply in closing {
        let response = result
            .as_ref()
            .map(|_| ())
            .map_err(|error| ApiError::new(error.status.as_u16(), &error.code, &error.message));
        let _ = reply.send(response);
    }
    if let Err(error) = result {
        eprintln!("workspace shutdown: {error}");
    }
}

fn result_busy() -> ApiError {
    ApiError::new(
        429,
        "WORKSPACE_BUSY",
        "A task result verification is already running",
    )
}

#[cfg(test)]
pub(super) struct CopyPause {
    pub entered: oneshot::Sender<()>,
    pub resume: std::sync::mpsc::Receiver<()>,
    pub finished: oneshot::Sender<()>,
}
#[cfg(test)]
pub(super) struct GarbagePause {
    pub entered: oneshot::Sender<()>,
    pub resume: std::sync::mpsc::Receiver<()>,
    pub finished: oneshot::Sender<()>,
}
