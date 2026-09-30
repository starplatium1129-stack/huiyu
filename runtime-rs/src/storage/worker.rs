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
    let mut closing = Vec::new();
    #[cfg(test)]
    let mut pause = None;
    while let Some(work) = receiver.blocking_recv() {
        match work {
            Work::TaskMediaChunk(chunk, principal, cancel, reply) => {
                if !closing.is_empty() {
                    let _ = reply.send(Err(unavailable()));
                    continue;
                }
                context.cancel = cancel;
                if !reply.is_closed() {
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
                if matches!(command["kind"].as_str(), Some("backup" | "restoreBackup")) {
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
                if !closing.is_empty() {
                    break;
                }
            }
            Work::Close(reply) => {
                closing.push(reply);
                if !copying {
                    break;
                }
            }
            #[cfg(test)]
            Work::PauseCopy(gate) => {
                pause = Some(gate);
            }
        }
    }
    // Refuse admission before acknowledging Close. A copy keeps the receiver
    // open until CopyFinished is queued; already admitted mutations retain
    // COMMIT_UNKNOWN if shutdown drops their reply without executing them.
    receiver.close();
    // The copy holds a sender until CopyFinished is queued, so channel shutdown
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

#[cfg(test)]
pub(super) struct CopyPause {
    pub entered: oneshot::Sender<()>,
    pub resume: std::sync::mpsc::Receiver<()>,
    pub finished: oneshot::Sender<()>,
}
