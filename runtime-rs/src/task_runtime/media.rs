use super::*;
use crate::execution::Output;
use crate::storage::TaskMediaSource;
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Seek},
    path::Path,
    sync::LazyLock,
};
use tokio::sync::Semaphore;

static HASHERS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(2)));

pub(super) enum Target {
    Input(String),
    Result(usize),
}
impl Target {
    fn command(&self, id: &str, phase: &str) -> Value {
        match self {
            Self::Input(name) => {
                json!({"kind":format!("task.input.{phase}"),"taskId":id,"name":name})
            }
            Self::Result(index) => {
                json!({"kind":format!("task.result.{phase}"),"taskId":id,"index":index})
            }
        }
    }
    fn alias(&self, id: &str) -> String {
        match self {
            Self::Input(name) => format!(
                "task-input-{}",
                hex::encode(Sha256::digest(format!("input:{id}:{name}").as_bytes()))
            ),
            Self::Result(index) => format!("task-{id}-{index}"),
        }
    }
}

async fn hashed_source(storage: &Storage, output: Output) -> Result<(TaskMediaSource, String)> {
    let bytes = match output {
        Output::File { path, bytes, .. } => return storage.stage_task_file(path, bytes).await,
        Output::Bytes { bytes, .. } => bytes,
    };
    let permit =
        HASHERS.clone().acquire_owned().await.map_err(|_| {
            ApiError::new(503, "TASK_MEDIA_UNAVAILABLE", "Media worker unavailable")
        })?;
    let cancel = CancellationToken::new();
    let _cancel = cancel.clone().drop_guard();
    tokio::task::spawn_blocking(move || {
        // Keep hashing off async workers without copying byte sources. A dropped
        // caller cancels between chunks; the worker retains its permit until exit.
        let _permit = permit;
        let check = || {
            if cancel.is_cancelled() {
                Err(ApiError::new(499, "CANCELLED", "Media hashing cancelled"))
            } else {
                Ok(())
            }
        };
        check()?;
        let mut hash = Sha256::new();
        for chunk in bytes.chunks(1024 * 1024) {
            check()?;
            hash.update(chunk);
        }
        let source = TaskMediaSource::Bytes(bytes);
        check()?;
        Ok((source, hex::encode(hash.finalize())))
    })
    .await
    .map_err(|_| ApiError::new(503, "TASK_MEDIA_UNAVAILABLE", "Media worker stopped"))?
}

pub(super) async fn persist(
    storage: &Storage,
    principal: &str,
    id: &str,
    target: Target,
    output: Output,
) -> Result<()> {
    let bytes = output.len();
    let mime = output.mime().to_owned();
    let (source, hash) = hashed_source(storage, output).await?;
    let mut media = json!({"alias":target.alias(id),"sha256":hash,"bytes":bytes,"mime":mime});
    if let Target::Result(index) = &target {
        media["index"] = json!(index);
    }
    let mut prepare = target.command(id, "prepare");
    prepare["media"] = media;
    let prepared = storage.request(prepare, principal).await?;
    prepared["offset"]
        .as_u64()
        .filter(|v| *v <= bytes)
        .ok_or_else(|| {
            ApiError::new(503, "TASK_MEDIA_INVALID", "Invalid persisted media offset")
        })?;
    // Both internal sources use one admitted background copy and durable flush.
    // HTTP uploads keep their independently acknowledged, durable chunk protocol.
    storage
        .task_media_copy(target.command(id, "commit"), source, principal)
        .await?;
    Ok(())
}

pub(super) async fn restore(
    storage: &Storage,
    principal: &str,
    id: &str,
    name: &str,
    path: &Path,
) -> Result<bool> {
    let record = storage
        .request(
            json!({"kind":"task.input.get","taskId":id,"name":name}),
            principal,
        )
        .await?;
    if record.is_null() {
        return Ok(false);
    }
    let source = storage.media(text(&record, "alias")?).await?;
    if record["sha256"] != source.sha256 || record["bytes"] != source.total_bytes {
        return Err(ApiError::new(
            409,
            "TASK_INPUT_INVALID",
            "Frozen task input is inconsistent",
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| ApiError::invalid("Input destination has no parent"))?;
    tokio::fs::create_dir_all(parent).await?;
    let mut input = tokio::fs::File::open(&source.path).await?;
    let (output, pending) = tempfile::NamedTempFile::new_in(parent)?.into_parts();
    let mut output = tokio::fs::File::from_std(output);
    let bytes = tokio::io::copy(&mut input, &mut output).await?;
    if bytes != source.total_bytes {
        return Err(ApiError::new(
            409,
            "TASK_INPUT_INVALID",
            "Frozen task input copy was incomplete",
        ));
    }
    output.sync_all().await?;
    drop(output);
    pending
        .persist(path)
        .map_err(|error| ApiError::from(error.error))?;
    Ok(true)
}

pub(super) async fn restore_result(
    storage: &Storage,
    principal: &str,
    id: &str,
    index: usize,
    path: &Path,
    cancel: CancellationToken,
) -> Result<bool> {
    let lease = uuid::Uuid::new_v4().to_string();
    let restored = async {
        let current = storage.task_result_reference(id, index as u64, principal).await?;
        let Some(reference) = current.reference else { return Ok(false); };
        let leased = storage.begin_task_result_import(id, index as u64, &reference.alias, &lease, principal).await?;
        if leased.reference.as_ref() != Some(&reference) {
            return Err(ApiError::new(409, "TASK_RESULT_INVALID", "Task result changed during restoration"));
        }
        let source = storage.open_media(&reference.alias).await?;
        if source.media.sha256 != reference.sha256 || source.media.total_bytes != reference.bytes
            || source.media.mime != reference.mime
        {
            return Err(ApiError::new(409, "TASK_RESULT_INVALID", "Task result metadata is inconsistent"));
        }
        let file = source.file.try_clone().await?.into_std().await;
        let parent = path.parent().ok_or_else(|| ApiError::invalid("Result destination has no parent"))?.to_owned();
        tokio::fs::create_dir_all(&parent).await?;
        let permit = tokio::select! { biased;
            _ = cancel.cancelled() => return Err(ApiError::new(499, "CANCELLED", "Task result restoration was cancelled")),
            permit = HASHERS.clone().acquire_owned() => permit.map_err(|_| ApiError::new(503, "TASK_MEDIA_UNAVAILABLE", "Media worker unavailable"))?,
        };
        let scope = cancel.clone();
        let bytes = reference.bytes;
        let closed = source.closed.clone();
        let pending = tokio::task::spawn_blocking(move || -> Result<tempfile::TempPath> {
            // Keep admission and the source lease until this worker settles.
            // TempPath owns partial bytes on cancellation and copy failures.
            use std::io::Write;
            let _permit = permit;
            let (mut output, pending) = tempfile::NamedTempFile::new_in(parent)?.into_parts();
            let mut input = file;
            input.rewind()?;
            let mut copied = 0u64;
            let mut buffer = vec![0; 1024 * 1024];
            loop {
                if scope.is_cancelled() || closed.is_cancelled() {
                    return Err(ApiError::new(499, "CANCELLED", "Task result restoration was cancelled"));
                }
                let count = input.read(&mut buffer)?;
                if count == 0 { break; }
                copied += count as u64;
                if copied > bytes {
                    return Err(ApiError::new(409, "TASK_RESULT_INVALID", "Task result grew during restoration"));
                }
                output.write_all(&buffer[..count])?;
            }
            if copied != bytes {
                return Err(ApiError::new(409, "TASK_RESULT_INVALID", "Task result copy was incomplete"));
            }
            output.sync_all()?;
            Ok(pending)
        }).await.map_err(|_| ApiError::new(503, "TASK_MEDIA_UNAVAILABLE", "Media worker stopped"))??;
        storage.finish_media(&reference.alias, source).await?;
        if cancel.is_cancelled() {
            return Err(ApiError::new(499, "CANCELLED", "Task result restoration was cancelled"));
        }
        pending.persist(path).map_err(|error| ApiError::from(error.error))?;
        Ok(true)
    }.await;
    // Release even if the begin response was lost after its transaction committed.
    let released = storage.end_task_result_import(&lease, principal).await;
    match (restored, released) {
        (Ok(value), Ok(())) => Ok(value),
        (Ok(_), Err(error)) => Err(error),
        (Err(error), released) => {
            if let Err(released) = released { eprintln!("task result restore lease cleanup: {released}"); }
            Err(error)
        }
    }
}
