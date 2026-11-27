use super::*;

pub(super) fn run(
    root: PathBuf,
    id: String,
    epoch: String,
    create: bool,
    mut receiver: mpsc::Receiver<Work>,
    opened: oneshot::Sender<Result<()>>,
    sender: mpsc::WeakSender<Work>,
    derivatives: Arc<thumbnail::Cache>,
) {
    let mut context = match schema::open(root, id, epoch, create, derivatives) {
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
    let mut copying: Option<Arc<AtomicBool>> = None;
    let mut collecting: Option<Arc<AtomicBool>> = None;
    let mut closing = Vec::new();

    while let Some(work) = receiver.blocking_recv() {
        match work {
            Work::MigrationVerified(id, result) => {
                migration::verification::finish(&mut context, id, result);
            }
            Work::UploadFinished(id, result) => {
                upload::finish(&mut context, id, result);
            }
            Work::ResultVerified(id, verified) => {
                result_commit::finish(&mut context, id, verified, &sender);
            }
            Work::RestoreVerified(id, verified) => {
                restore::finish(&mut context, id, verified);
            }
            Work::TaskMediaCopy(command, source, principal, cancel, reply, permit) => {
                if !closing.is_empty() {
                    let _ = reply.send(Err(unavailable()));
                    continue;
                }
                context.cancel = cancel;
                if !reply.is_closed() {
                    result_commit::start_copy(
                        &mut context,
                        command,
                        source,
                        &principal,
                        reply,
                        permit,
                        &sender,
                    );
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
            Work::TaskPatch(id, revision, patch, principal, cancel, reply) => {
                if !closing.is_empty() {
                    let _ = reply.send(Err(unavailable()));
                    continue;
                }
                context.cancel = cancel;
                if !reply.is_closed() {
                    let result =
                        tasks::patch_record(&mut context, &principal, &id, revision, patch);
                    let _ = reply.send(result);
                }
            }
            Work::PrepareArtworkRead(search, cancel, reply) => {
                context.cancel = cancel;
                if !closing.is_empty() {
                    let _ = reply.send(Err(unavailable()));
                } else if !reply.is_closed() {
                    let result = (|| {
                        if !artwork_index::refresh_chunk(&context)?
                            && search && artwork_search::small_pending(&context)?
                        {
                            artwork_search::refresh_chunk(&context)?;
                        }
                        Ok(())
                    })();
                    let _ = reply.send(result);
                }
            }
            Work::WarmArtworkSearch(cancel, warming, reply) => {
                context.cancel = cancel;
                let result = if !closing.is_empty() || reply.is_closed() {
                    Err(unavailable())
                } else {
                    artwork_index::refresh_chunk(&context)
                        .and_then(|worked| Ok(worked || artwork_search::refresh_chunk(&context)?))
                };
                // Clear under actor ordering, before notifying the producer: a
                // later read can start new work without an older completion
                // clearing its flag or losing the wakeup.
                if !matches!(&result, Ok(true)) {
                    warming.store(false, Ordering::Release);
                }
                let _ = reply.send(result);
            }
            Work::Request(command, principal, cancel, reply, permit, job, bytes) => {
                if !closing.is_empty() {
                    let _ = reply.send(Err(unavailable()));
                    continue;
                }
                context.cancel = cancel;
                context.job = job;
                if reply.is_closed() {
                    continue;
                }
                if upload::is_chunk(&command) {
                    if let Some(permit) = permit {
                        upload::start(
                            &mut context,
                            command,
                            principal,
                            reply,
                            permit,
                            bytes,
                            &sender,
                        );
                    } else {
                        let _ = reply.send(Err(unavailable()));
                    }
                    continue;
                }
                if command["kind"] == "migration.verify" {
                    if let Some(permit) = permit {
                        migration::verification::start(
                            &mut context,
                            &command,
                            &principal,
                            reply,
                            permit,
                            &sender,
                        );
                    } else {
                        let _ = reply.send(Err(unavailable()));
                    }
                    continue;
                }
                if matches!(
                    command["kind"].as_str(),
                    Some("restoreArtwork" | "restoreArtworks")
                ) {
                    if let Some(permit) = permit {
                        restore::start(&mut context, &command, &principal, reply, permit, &sender);
                    } else {
                        let _ = reply.send(Err(unavailable()));
                    }
                    continue;
                }
                if result_commit::is_commit(&command) {
                    result_commit::start(&mut context, command, &principal, reply, permit, &sender);
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

                                    let _ = sender.blocking_send(Work::GarbageFinished(
                                        job.completion,
                                        result,
                                        reply,
                                    ));
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
                    if copying.is_some() {
                        let _ = reply.send(Err(ApiError::new(
                            429,
                            "WORKSPACE_BUSY",
                            "A workspace copy is already running",
                        )));
                        continue;
                    }
                    match context.durable(|c| backup::prepare(c, &principal, &command)) {
                        Ok(backup::Prepared::Complete(value)) => {
                            let _ = reply.send(Ok(value));
                        }
                        Ok(backup::Prepared::Copy(mut job)) => {
                            let backup_id = job.completion.backup_id.clone();
                            let Some(sender) = sender.upgrade() else {
                                backup::release_unsealed(&context, backup_id.as_deref());
                                let _ = reply.send(Err(unavailable()));
                                continue;
                            };

                            let cancellation = job.completion.cancel.clone();
                            let thread = std::thread::Builder::new()
                                .name("workspace-copy".into())
                                .spawn(move || {
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
                                });
                            match thread {
                                Ok(_) => copying = Some(cancellation),
                                Err(error) => {
                                    backup::release_unsealed(&context, backup_id.as_deref());
                                    eprintln!("workspace copy startup: {error}");
                                }
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
            Work::CopyFinished(completion, result, reply) => {
                let result = context.durable(|c| backup::finish(c, completion, result));
                let _ = reply.send(result);
                copying = None;
            }
            Work::GarbageFinished(completion, result, reply) => {
                let result = garbage::finish(&mut context, completion, result);
                let _ = reply.send(result);
                collecting = None;
            }
            Work::Close(reply) => {
                closing.push(reply);
                for cancel in copying.iter().chain(&collecting) {
                    cancel.store(true, Ordering::Relaxed);
                }
                if let Some(pending) = &context.result_commit {
                    pending.cancel();
                }
                if let Some(pending) = &context.restore_commit {
                    pending.cancel();
                }
                if let Some(pending) = &context.upload {
                    pending.cancel();
                }
                if let Some(pending) = &context.migration_verification {
                    pending.cancel();
                }
            }
        }
        if !closing.is_empty()
            && copying.is_none()
            && collecting.is_none()
            && context.result_commit.is_none()
            && context.restore_commit.is_none()
            && context.upload.is_none()
            && context.migration_verification.is_none()
        {
            break;
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
