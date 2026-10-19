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
    let video = job.input["mediaKind"] == "video";
    let directory = inner.config.runtime_root.join(if video {
        "outputs/video"
    } else {
        "outputs/anima"
    });
    tokio::fs::create_dir_all(&directory).await?;
    let root = tokio::fs::canonicalize(&directory).await?;
    let path = root.join(format!(
        "native-{}.{}",
        job.id,
        if video { "mp4" } else { "png" }
    ));
    if cancel.is_cancelled() {
        return Err(ApiError::new(499, "ABORT_ERR", "独立推理已取消"));
    }
    recovery::stage(job, &path, bytes).await?;
    // No await between publication and handing ownership to settle/succeed.
    // TempPath and the caller's TempDir clean up an unsuccessful publication;
    // the job removes a collected/discarded file on cancellation, expiry or close.
    let published = (|| -> Result<()> {
        let lineart = manga::Publication::stage(job, source, &path)?;
        tempfile::TempPath::try_from_path(source)?
            .persist_noclobber(&path)
            .map_err(|error| ApiError::from(error.error))?;
        lineart.commit();
        Ok(())
    })();
    if published.is_err() {
        recovery::forget(&path).await;
    }
    published?;
    Ok(Output::File {
        path,
        mime: if video { "video/mp4" } else { "image/png" }.into(),
        bytes,
    })
}

// A killed process cannot run job cleanup. Reuse the existing maintenance tick
// for expired native-only files; never sweep Comfy outputs or live job results.
pub(in crate::generation) async fn prune(inner: &Inner) {
    // Retire prior native results even when the next session selects ComfyUI.
    if !matches!(inner.scope, Scope::Images | Scope::Video) {
        return;
    }
    let video = matches!(inner.scope, Scope::Video);
    let directory = inner.config.runtime_root.join(if video {
        "outputs/video"
    } else {
        "outputs/anima"
    });
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
                .and_then(|name| name.strip_suffix(if video { ".mp4" } else { ".png" }))
                .map(|id| {
                    if video {
                        id
                    } else {
                        id.strip_suffix("-lineart").unwrap_or(id)
                    }
                })
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
            // An unreadable/present recovery owner also blocks age-based
            // deletion, including a manga sidecar and pre-restart results.
            let owner = entry.path().with_file_name(format!("native-{id}.json"));
            if !matches!(std::fs::symlink_metadata(owner), Err(error) if error.kind() == std::io::ErrorKind::NotFound) {
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
