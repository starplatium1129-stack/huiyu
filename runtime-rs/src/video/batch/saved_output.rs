use super::*;
use crate::file_identity::{self, Identity, Version};
use crate::task_contract::ResultRef;
use sha2::{Digest, Sha256};
use std::{fs::File, io::Read, sync::LazyLock};
use tokio::sync::Semaphore;

static WORKERS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(2)));

#[derive(Default)]
pub(super) struct Proofs {
    // A batch has at most 30 shots and one concat. Proofs own no file handles
    // and live with the task recovery/batch; they never cross principals or restarts.
    entries: std::sync::Mutex<[Option<Proof>; 31]>,
    restored: std::sync::Mutex<Option<tempfile::TempDir>>,
}
#[derive(Clone)]
struct Proof {
    path: PathBuf,
    reference: ResultRef,
    stamp: (Identity, Version),
}
fn stamp(file: &File) -> std::io::Result<(Identity, Version)> {
    Ok((file_identity::opened(file)?, Version::of(file)?))
}
fn check(cancel: &CancellationToken) -> Result<()> {
    if cancel.is_cancelled() {
        Err(cancelled())
    } else {
        Ok(())
    }
}
fn cancelled() -> crate::error::ApiError {
    error(499, "CANCELLED", "分镜结果校验已取消")
}
pub(super) async fn saved_output(
    service: &Service,
    value: &Value,
    reference: Option<&ResultRef>,
    proofs: &Arc<Proofs>,
    index: usize,
    hooks: &dyn ExecutionHooks,
) -> Result<Option<Output>> {
    let Some(reference) = reference else {
        proofs.entries.lock().unwrap()[index] = None;
        return Ok(None);
    };
    if let Some(raw) = value["path"].as_str()
        && let Some(output) =
            checked_output(service, PathBuf::from(raw), reference, proofs, index).await?
    {
        return Ok(Some(output));
    }
    // A checkpoint path is only a cache hint. The durable task reference is the
    // fallback for both shots and a completed concat when upstream history is gone.
    let extension = match reference.mime.as_str() {
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "video/quicktime" => "mov",
        _ => return Err(error(409, "BATCH_RESULT_INVALID", "分镜结果类型无效")),
    };
    let root = service.config.runtime_root.join("outputs/video");
    tokio::fs::create_dir_all(&root).await?;
    let path = {
        let mut directory = proofs.restored.lock().unwrap();
        if directory.is_none() {
            *directory = Some(
                tempfile::Builder::new()
                    .prefix(".batch-recovery-")
                    .tempdir_in(&root)?,
            );
        }
        directory
            .as_ref()
            .unwrap()
            .path()
            .join(format!("{index}.{extension}"))
    };
    if let Some(output) = checked_output(service, path.clone(), reference, proofs, index).await? {
        return Ok(Some(output));
    }
    if !hooks.restore_result(index, path.clone()).await? {
        return Ok(None);
    }
    checked_output(service, path, reference, proofs, index)
        .await?
        .map(Some)
        .ok_or_else(|| {
            error(
                409,
                "BATCH_RESULT_INVALID",
                "工作区分镜文件与持久结果记录不一致",
            )
        })
}
async fn checked_output(
    service: &Service,
    path: PathBuf,
    reference: &ResultRef,
    proofs: &Arc<Proofs>,
    index: usize,
) -> Result<Option<Output>> {
    let previous = proofs.entries.lock().unwrap()[index].clone();
    let proofs = proofs.clone();
    let (path, root, reference) = (
        path,
        service.config.runtime_root.join("outputs/video"),
        reference.clone(),
    );
    let cancel = service.shutdown.child_token();
    let _guard = cancel.clone().drop_guard();
    let permit = tokio::select! { biased;
        _ = cancel.cancelled() => return Err(cancelled()),
        permit = WORKERS.clone().acquire_owned() => permit.map_err(|_| error(503,"BATCH_RECOVERY_UNAVAILABLE","分镜结果校验不可用"))?,
    };
    tokio::task::spawn_blocking(move || {
        // A dropped recovery waiter cancels the reader, whose admission slot
        // remains held until the actual filesystem worker exits.
        let _permit = permit;
        let (output, proof) = verify(path, root, reference, previous, &cancel)?;
        // Publish each completed check before any later upstream await. An
        // interrupted reconciliation can reuse the task recovery's progress.
        proofs.entries.lock().unwrap()[index] = proof;
        Ok(output)
    })
    .await
    .map_err(|_| error(503, "BATCH_RECOVERY_UNAVAILABLE", "分镜结果校验未完成"))?
}
fn verify(
    path: PathBuf,
    root: PathBuf,
    reference: ResultRef,
    previous: Option<Proof>,
    cancel: &CancellationToken,
) -> Result<(Option<Output>, Option<Proof>)> {
    check(cancel)?;
    let (Ok(canonical), Ok(root)) = (std::fs::canonicalize(&path), std::fs::canonicalize(root))
    else {
        return Ok((None, None));
    };
    if !canonical.starts_with(&root)
        || !matches!(
            path.extension().and_then(|s| s.to_str()),
            Some("mp4" | "webm" | "mov")
        )
    {
        return Ok((None, None));
    }
    let mut file = File::open(&path)?;
    let metadata = file.metadata()?;
    let bytes = metadata.len();
    if !metadata.is_file() || bytes == 0 || reference.bytes != bytes {
        return Ok((None, None));
    }
    // Unsupported identity APIs retain the full-hash path without publishing
    // a proof. A native file ID alone cannot prove that its contents are intact.
    let before = stamp(&file).ok();
    let cached = before.as_ref().is_some_and(|stamp| {
        previous.as_ref().is_some_and(|proof| {
            proof.path == canonical && proof.reference == reference && &proof.stamp == stamp
        })
    });
    if !cached {
        let mut hash = Sha256::new();
        let mut buffer = vec![0; bytes.saturating_add(1).min(1024 * 1024) as usize];
        let mut total = 0u64;
        loop {
            check(cancel)?;
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            total += count as u64;
            if total > bytes {
                return Ok((None, None));
            }
            hash.update(&buffer[..count]);
        }
        if total != bytes || reference.sha256 != hex::encode(hash.finalize()) {
            return Ok((None, None));
        }
    }
    check(cancel)?;
    if std::fs::canonicalize(&path).ok().as_ref() != Some(&canonical) {
        return Ok((None, None));
    }
    let proof = if let Some(before) = before {
        if stamp(&file).ok().as_ref() != Some(&before)
            || stamp(&File::open(&path)?).ok().as_ref() != Some(&before)
        {
            return Ok((None, None));
        }
        Some(Proof {
            path: canonical,
            reference: reference.clone(),
            stamp: before,
        })
    } else {
        None
    };
    check(cancel)?;
    Ok((
        Some(Output::File {
            path,
            mime: reference.mime,
            bytes,
        }),
        proof,
    ))
}
