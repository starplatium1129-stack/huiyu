//! Native output ownership survives workspace write failures and gateway exits.
use super::*;
use crate::task_contract::{DeliveryState, ResultState, TaskKind, TaskRecord, TaskStatus};
use std::path::Path;

pub(super) async fn stage(job: &Job, path: &Path, bytes: u64) -> Result<()> {
    if job.hooks.is_none() {
        return Ok(());
    }
    let state = job.state.lock().await;
    let record = json!({"id":job.id,"owner":job.owner,"bytes":bytes,
        "metadata":state.metadata.as_ref(),
        "input":{"family":job.input["family"],"operation":job.input["operation"],
            "autoLines":manga::has_lines(&job.input)}});
    drop(state);
    // Publish the recovery owner before the validated files. This record has no
    // TTL or startup-count eviction; only durable collection/discard releases it.
    snapshots::write(&path.with_extension("json"), &record).await?;
    Ok(())
}

pub(in crate::generation) async fn forget(path: &Path) {
    let _ = tokio::fs::remove_file(path.with_extension("json")).await;
}

fn result_path(inner: &Inner, task: &RecoveryTask<'_>) -> Option<PathBuf> {
    let id = task.checkpoint?["gatewayJobId"].as_str()?;
    if id.len() != 32
        || !id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    let video = task.kind == TaskKind::Video;
    Some(
        inner
            .config
            .runtime_root
            .join(if video {
                "outputs/video"
            } else {
                "outputs/anima"
            })
            .join(format!("native-{id}.{}", if video { "mp4" } else { "png" })),
    )
}

pub(in crate::generation) async fn recover(
    inner: &Inner,
    task: &RecoveryTask<'_>,
) -> Result<Option<Observation>> {
    let Some(path) = result_path(inner, task) else {
        return Ok(None);
    };
    if !snapshots::safe_directory(path.parent().unwrap()).await {
        return Ok(None);
    }
    let record_path = path.with_extension("json");
    let stat = match tokio::fs::symlink_metadata(&record_path).await {
        Ok(stat) => stat,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let invalid = || {
        ApiError::new(
            503,
            "NATIVE_RESULT_RECOVERY_UNAVAILABLE",
            "原生结果恢复记录不可读取，文件已保留",
        )
    };
    if !stat.is_file() || stat.file_type().is_symlink() || stat.len() > 2 * 1024 * 1024 {
        return Err(invalid());
    }
    let record: Value =
        serde_json::from_slice(&tokio::fs::read(&record_path).await?).map_err(|_| invalid())?;
    if record["owner"].as_str() != Some(task.principal_id)
        || record["id"] != task.checkpoint.unwrap()["gatewayJobId"]
        || !record["metadata"].is_object()
    {
        return Err(invalid());
    }
    let mut metadata = task.metadata.clone();
    metadata.extend(record["metadata"].as_object().unwrap().clone());
    let mut result = Observation {
        status: "succeeded".into(),
        settled: true,
        unknown: false,
        error_code: None,
        metadata: Value::Object(metadata),
        outputs: vec![],
    };
    if task.cancel_requested || task.result_available {
        if task.cancel_requested {
            if manga::has_lines(&record["input"]) && record["input"]["operation"] != "lineart" {
                let _ = tokio::fs::remove_file(manga::lineart_path(&path, &record["input"])).await;
            }
            let _ = tokio::fs::remove_file(&path).await;
            result.status = "cancelled".into();
        }
        forget(&path).await;
        return Ok(Some(result));
    }
    let stat = tokio::fs::symlink_metadata(&path).await?;
    let video = task.kind == TaskKind::Video;
    if !stat.is_file()
        || stat.file_type().is_symlink()
        || stat.len() == 0
        || stat.len()
            > if video {
                256 * 1024 * 1024
            } else {
                32 * 1024 * 1024
            }
        || Some(stat.len()) != record["bytes"].as_u64()
    {
        return Err(invalid());
    }
    result.outputs = manga::outputs(
        &record["input"],
        Output::File {
            path,
            mime: if video { "video/mp4" } else { "image/png" }.into(),
            bytes: stat.len(),
        },
    )
    .await?;
    Ok(Some(result))
}

impl Service {
    /// Called only after the workspace has confirmed persistence or discard.
    pub(crate) async fn release_native_result(&self, task: &TaskRecord) {
        if task.provider == "native"
            && (task.result_state == ResultState::Available
                || task.delivery_state == DeliveryState::Discarded
                || task.status == TaskStatus::Cancelled && task.cancel_requested_at.is_some())
        {
            if let Some(path) = result_path(&self.inner, &RecoveryTask::from(task)) {
                forget(&path).await;
            }
        }
    }
}
