//! Retain validated native PNGs on disk using the existing job result lifecycle.
use super::*;
use std::{collections::HashSet, path::Path};

pub(super) async fn publish(
    inner: &Inner,
    job: &Job,
    source: &Path,
    bytes: u64,
    cancel: &CancellationToken,
) -> Result<Output> {
    let directory = inner.config.runtime_root.join("outputs/anima");
    tokio::fs::create_dir_all(&directory).await?;
    let root = tokio::fs::canonicalize(&directory).await?;
    let path = root.join(format!("native-{}.png", job.id));
    if cancel.is_cancelled() {
        return Err(ApiError::new(499, "ABORT_ERR", "独立推理已取消"));
    }
    // No await between publication and handing ownership to settle/succeed.
    // TempPath and the caller's TempDir clean up an unsuccessful publication;
    // the job removes a published file on late cancellation, expiry or close.
    tempfile::TempPath::try_from_path(source)?
        .persist_noclobber(&path)
        .map_err(|error| ApiError::from(error.error))?;
    Ok(Output::File {
        path,
        mime: "image/png".into(),
        bytes,
    })
}

// A killed process cannot run job cleanup. Reuse the existing maintenance tick
// for expired native-only files; never sweep Comfy outputs or live job results.
pub(in crate::generation) async fn prune(inner: &Inner) {
    // Retire prior native results even when the next session selects ComfyUI.
    if !matches!(inner.scope, Scope::Images) {
        return;
    }
    let directory = inner.config.runtime_root.join("outputs/anima");
    if !snapshots::safe_directory(&directory).await {
        return;
    }
    let live: HashSet<_> = inner.state.lock().await.jobs.keys().cloned().collect();
    let cancel = inner.cancel.clone();
    let _ = tokio::task::spawn_blocking(move || {
        let Ok(entries) = std::fs::read_dir(directory) else {
            return;
        };
        for entry in entries.flatten() {
            if cancel.is_cancelled() {
                break;
            }
            let name = entry.file_name();
            let Some(id) = name
                .to_str()
                .and_then(|name| name.strip_prefix("native-"))
                .and_then(|name| name.strip_suffix(".png"))
                .filter(|id| {
                    id.len() == 32
                        && id
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                })
            else {
                continue;
            };
            if live.contains(id) {
                continue;
            }
            let Ok(metadata) = std::fs::symlink_metadata(entry.path()) else {
                continue;
            };
            if metadata.is_file()
                && !metadata.file_type().is_symlink()
                && metadata
                    .modified()
                    .ok()
                    .and_then(|at| at.elapsed().ok())
                    .is_some_and(|age| age >= Duration::from_secs(30 * 60))
            {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    })
    .await;
}
