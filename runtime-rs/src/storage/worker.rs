use super::*;

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

    while let Some(work) = receiver.blocking_recv() {
        match work {
            Work::MigrationVerified(id, result) => {
                migration::verification::finish(&mut context, id, result);
                if !closing.is_empty()
                    && !copying
                    && collecting.is_none()
                    && context.result_commit.is_none()
                    && context.restore_commit.is_none()
                    && context.upload.is_none()
                    && context.migration_verification.is_none()
                {
                    break;
                }
            }
            Work::UploadFinished(id, result) => {
                upload::finish(&mut context, id, result);
                if !closing.is_empty()
                    && !copying
                    && collecting.is_none()
                    && context.result_commit.is_none()
                    && context.restore_commit.is_none()
                    && context.upload.is_none()
                    && context.migration_verification.is_none()
                {
                    break;
                }
            }
            Work::ResultVerified(id, verified) => {
                result_commit::finish(&mut context, id, verified, &sender);
                if !closing.is_empty()
                    && !copying
                    && collecting.is_none()
                    && context.result_commit.is_none()
                    && context.restore_commit.is_none()
                    && context.upload.is_none()
                    && context.migration_verification.is_none()
                {
                    break;
                }
            }
            Work::RestoreVerified(id, verified) => {
                restore::finish(&mut context, id, verified);
                if !closing.is_empty()
                    && !copying
                    && collecting.is_none()
                    && context.result_commit.is_none()
                    && context.restore_commit.is_none()
                    && context.upload.is_none()
                    && context.migration_verification.is_none()
                {
                    break;
                }
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
                    let result = tasks::patch_record(&mut context,&principal,&id,revision,patch);
                    let _ = reply.send(result);
                }
            }
            Work::TaskRecord(key, principal, cancel, reply) => {
                if !closing.is_empty() {
                    let _ = reply.send(Err(unavailable()));
                    continue;
                }
                context.cancel = cancel;
                if !reply.is_closed() {
                    let result = tasks::read_record(&context, &principal, &key);
                    let _ = reply.send(result);
                }
            }
            Work::TaskRecoveryPage(query, principal, cancel, reply) => {
                if !closing.is_empty() {
                    let _ = reply.send(Err(unavailable()));
                    continue;
                }
                context.cancel = cancel;
                if !reply.is_closed() {
                    let result = tasks::read_recovery_page(&context, &principal, query);
                    let _ = reply.send(result);
                }
            }
            Work::TaskRevision(id, principal, cancel, reply) => {
                if !closing.is_empty() {
                    let _ = reply.send(Err(unavailable()));
                    continue;
                }
                context.cancel = cancel;
                if !reply.is_closed() {
                    let result = tasks::read_revision(&context, &principal, &id);
                    let _ = reply.send(result);
                }
            }
            Work::TaskResultReference(id, index, principal, cancel, reply) => {
                if !closing.is_empty() {
                    let _ = reply.send(Err(unavailable()));
                    continue;
                }
                context.cancel = cancel;
                if !reply.is_closed() {
                    let result = tasks::read_result_reference(&context, &principal, &id, index);
                    let _ = reply.send(result);
                }
            }
            Work::ArtworkRead(command, principal, cancel, search, reply) => {
                if !closing.is_empty() {
                    let _ = reply.send(Err(unavailable()));
                    continue;
                }
                context.cancel = cancel;
                if !reply.is_closed() {
                    // Index preparation and search scans each yield within one
                    // bounded chunk. The caller owns progress and rejoins FIFO.
                    let result = artwork_index::refresh_chunk(&context).and_then(|worked| {
                        let worked = worked
                            || (command["kind"] == "searchArtworks"
                                && artwork_search::needs_index(&command)
                                && artwork_search::refresh_small(&context)?);
                        if worked {
                            Ok(artwork_index::ReadOutcome::Continue(search))
                        } else if let Some(search) = search {
                            if principal.is_empty() {
                                return Err(ApiError::new(
                                    401,
                                    "UNAUTHORIZED",
                                    "Desktop principal is required",
                                ));
                            }
                            match search.step(&context)? {
                                artwork_search::Step::Continue(search) => {
                                    Ok(artwork_index::ReadOutcome::Continue(Some(search)))
                                }
                                artwork_search::Step::Complete(value) => {
                                    let warm = !artwork_search::ready(&context)?;
                                    Ok(artwork_index::ReadOutcome::Complete(value, warm))
                                }
                            }
                        } else {
                            context
                                .execute(&command, &principal)
                                .map(|value| artwork_index::ReadOutcome::Complete(value, false))
                        }
                    });
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
                        upload::start(&mut context, command, principal, reply, permit, bytes, &sender);
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
                    result_commit::start(
                        &mut context,
                        command,
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
                        Ok(backup::Prepared::Copy(mut job)) => {
                            let Some(sender) = sender.upgrade() else {
                                let _ = reply.send(Err(unavailable()));
                                continue;
                            };

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
                if !closing.is_empty()
                    && collecting.is_none()
                    && context.result_commit.is_none()
                    && context.restore_commit.is_none()
                    && context.upload.is_none()
                    && context.migration_verification.is_none()
                {
                    break;
                }
            }
            Work::GarbageFinished(completion, result, reply) => {
                let result = garbage::finish(&mut context, completion, result);
                let _ = reply.send(result);
                collecting = None;
                if !closing.is_empty()
                    && !copying
                    && context.result_commit.is_none()
                    && context.restore_commit.is_none()
                    && context.upload.is_none()
                    && context.migration_verification.is_none()
                {
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
                if let Some(pending) = &context.restore_commit {
                    pending.cancel();
                }
                if let Some(pending) = &context.upload {
                    pending.cancel();
                }
                if let Some(pending) = &context.migration_verification {
                    pending.cancel();
                }
                if !copying
                    && collecting.is_none()
                    && context.result_commit.is_none()
                    && context.restore_commit.is_none()
                    && context.upload.is_none()
                    && context.migration_verification.is_none()
                {
                    break;
                }
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
