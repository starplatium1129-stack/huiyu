use super::*;
use verified_media::Identity;
pub(super) mod file;

#[derive(Clone, PartialEq)]
pub(super) struct Chunk {
    pub key: String,
    pub media: Value,
    pub committed: bool,
    pub record: bool,
    pub receipt: Value,
}
pub(super) enum Prepared {
    Complete(Value),
    Write(Chunk),
}
impl Chunk {
    pub fn new(key: String, media: Value, committed: bool, receipt: Value) -> Prepared {
        Prepared::Write(Self {
            key,
            media,
            committed,
            record: false,
            receipt,
        })
    }
}
pub(super) struct Pending {
    id: String,
    chunk: Chunk,
    command: Value,
    principal: String,
    identity: Identity,
    reply: oneshot::Sender<Result<Value>>,
    _permit: OwnedSemaphorePermit,
}
impl Pending {
    pub fn key(&self) -> &str {
        &self.chunk.key
    }
    pub fn hash(&self) -> &str {
        self.chunk.media["sha256"].as_str().unwrap()
    }
    pub fn cancel(&self) {
        self.identity.cancel.store(true, Ordering::Relaxed);
    }
}
pub(super) fn is_chunk(command: &Value) -> bool {
    matches!(
        command["kind"].as_str(),
        Some(
            "uploadChunk"
                | "uploadMediaChunk"
                | "task.input.chunk"
                | "task.result.chunk"
                | "migration.media"
                | "migration.recordChunk"
        )
    )
}
fn prepare(c: &mut Context, principal: &str, command: &Value) -> Result<Prepared> {
    c.check_cancel()?;
    if principal.is_empty() {
        return Err(ApiError::new(
            401,
            "UNAUTHORIZED",
            "Desktop principal is required",
        ));
    }
    c.writer()?;
    c.owner.check()?;
    let kind = string(command, "kind")?;
    if !kind.starts_with("task.") {
        let id = string(command, "operationId")?;
        if id.is_empty() || id.len() > 200 {
            return Err(invalid("A stable operation ID is required"));
        }
    }
    let prepared = match kind {
        "uploadChunk" | "uploadMediaChunk" => saves::prepare_chunk(c, principal, command),
        "task.input.chunk" => tasks::inputs::prepare_chunk(c, principal, command),
        "task.result.chunk" => tasks::outputs::prepare_chunk(c, principal, command),
        "migration.media" | "migration.recordChunk" => {
            migration::prepare_chunk(c, principal, command)
        }
        _ => Err(invalid("Unknown media chunk command")),
    }?;
    if let Prepared::Write(chunk) = &prepared {
        // Validate persisted metadata at the worker boundary before its hash
        // becomes GC protection. JSON migration records use a separate MIME.
        if chunk.record {
            if !chunk.media["sha256"]
                .as_str()
                .is_some_and(media::valid_hash)
                || chunk.media["bytes"]
                    .as_u64()
                    .is_none_or(|bytes| bytes == 0 || bytes > 9_007_199_254_740_991)
            {
                return Err(conflict(
                    "MIGRATION_FORMAT",
                    "Invalid record chunk metadata",
                ));
            }
        } else {
            media::validate(&chunk.media)?;
        }
    }
    Ok(prepared)
}
pub(super) fn start(
    c: &mut Context,
    mut command: Value,
    principal: String,
    reply: oneshot::Sender<Result<Value>>,
    permit: OwnedSemaphorePermit,
    sender: &mpsc::WeakSender<Work>,
) {
    let chunk = match prepare(c, &principal, &command) {
        Ok(Prepared::Complete(receipt)) => {
            let _ = reply.send(Ok(receipt));
            return;
        }
        Ok(Prepared::Write(chunk)) => chunk,
        Err(error) => {
            let _ = reply.send(Err(error));
            return;
        }
    };
    let encoded = match command
        .as_object_mut()
        .and_then(|object| object.remove("data"))
    {
        Some(Value::String(encoded)) => encoded,
        _ => {
            let _ = reply.send(Err(invalid("data must be a string")));
            return;
        }
    };
    let identity = match Identity::new(c) {
        Ok(identity) => identity,
        Err(error) => {
            let _ = reply.send(Err(error));
            return;
        }
    };
    let Some(sender) = sender.upgrade() else {
        let _ = reply.send(Err(unavailable()));
        return;
    };
    let id = uuid::Uuid::new_v4().to_string();
    let (job_id, job_identity) = (id.clone(), identity.clone());
    let job_chunk = chunk.clone();
    let offset = command["offset"].as_u64();
    let pending = Pending {
        id,
        chunk,
        command,
        principal,
        identity,
        reply,
        _permit: permit,
    };
    // Retain the sole media writer permit on the actor, including cancellation
    // and worker startup failure. Acknowledgements still follow sync_all.
    let thread = std::thread::Builder::new()
        .name("workspace-upload".into())
        .spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                file::write(&job_identity, &job_chunk, offset, encoded)
            }))
            .unwrap_or_else(|_| Err(unavailable()));
            let _ = sender.blocking_send(Work::UploadFinished(job_id, result));
        });
    match thread {
        Ok(_) => c.upload = Some(pending),
        Err(error) => {
            let _ = pending.reply.send(Err(error.into()));
        }
    }
}
pub(super) fn finish(c: &mut Context, id: String, result: Result<file::Written>) {
    if !c.upload.as_ref().is_some_and(|pending| pending.id == id) {
        return;
    }
    let pending = c.upload.take().unwrap();
    c.cancel = pending.identity.cancel.clone();
    let response = (|| {
        pending.identity.check(c)?;
        let written = result?;
        match prepare(c, &pending.principal, &pending.command)? {
            Prepared::Write(current) if current == pending.chunk => {}
            _ => return Err(conflict("OPERATION_CONFLICT", "Media upload state changed")),
        }
        written.check(&pending.identity)?;
        if let Some(record) = written.record {
            migration::complete_record_chunk(c, &pending.principal, &pending.command, record)?;
        }
        let mut receipt = pending.chunk.receipt;
        receipt["offset"] = json!(written.offset);
        Ok(receipt)
    })();
    let _ = pending.reply.send(response);
}
