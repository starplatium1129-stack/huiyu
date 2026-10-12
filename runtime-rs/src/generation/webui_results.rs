// Bounded recovery cache for completed durable WebUI tasks. The existing task
// checkpoint supplies identity; snapshots bind that identity to its owner.
// Retention is two hours; startup keeps at most 256 result/lost records,
// prioritizing completed results over metadata-only lost jobs.
use super::*;
use tokio::io::AsyncWriteExt;

const RETENTION: i64 = 2 * 60 * 60 * 1000;

pub(super) async fn stage(inner: &Inner, job: &Job, bytes: &[u8]) -> Result<()> {
    snapshots::save(inner, job).await?;
    let directory = snapshots::directory(inner, "webui");
    let (file, pending) = tempfile::Builder::new()
        .prefix(&format!(".webui-result-{}.", job.id))
        .suffix(".tmp")
        .tempfile_in(&directory)?
        .into_parts();
    let mut file = tokio::fs::File::from_std(file);
    file.write_all(bytes).await?;
    file.flush().await?;
    file.sync_all().await?;
    drop(file);
    pending
        .persist(directory.join(format!("{}.png", job.id)))
        .map_err(|error| ApiError::from(error.error))?;
    let state = job.state.lock().await;
    snapshots::write(&directory.join(format!("{}.json", job.id)),
        &json!({"id":job.id,"owner":job.owner,"status":"running","createdAt":job.created,
            "webuiResult":{"expiresAt":now()+RETENTION,"bytes":bytes.len(),"seed":state.metadata["seed"]}})).await
}

async fn record(inner: &Inner, id: &str) -> Option<Value> {
    if !snapshots::safe_id(id) {
        return None;
    }
    let directory = snapshots::directory(inner, "webui");
    if !snapshots::safe_directory(&directory).await {
        return None;
    }
    let path = directory.join(format!("{id}.json"));
    let metadata = tokio::fs::symlink_metadata(&path).await.ok()?;
    if !metadata.is_file() || metadata.len() > 16 * 1024 {
        return None;
    }
    let value: Value = serde_json::from_slice(&tokio::fs::read(path).await.ok()?).ok()?;
    (value["id"] == id).then_some(value)
}

pub(super) async fn recover(inner: &Inner, task: &Value) -> Result<Option<Observation>> {
    let Some(id) = task["checkpoint"]["gatewayJobId"].as_str() else {
        return Ok(None);
    };
    let Some(value) = record(inner, id).await else {
        return Ok(None);
    };
    if value["owner"].as_str().filter(|s| !s.is_empty()) != task["principalId"].as_str()
        || !value["webuiResult"].is_object()
    {
        return Ok(None);
    }
    let valid = value["webuiResult"]["expiresAt"]
        .as_i64()
        .is_some_and(|expires| expires > now() && expires <= now() + RETENTION);
    if !valid {
        snapshots::remove(inner, id).await;
        return Ok(None);
    }
    let mut result = Observation {
        status: "succeeded".into(),
        settled: true,
        unknown: false,
        error_code: None,
        metadata: task["metadata"].clone(),
        outputs: vec![],
    };
    if task["cancelRequestedAt"].is_number() || task["resultState"] == "available" {
        snapshots::remove(inner, id).await;
        if task["cancelRequestedAt"].is_number() {
            result.status = "cancelled".into();
        }
        return Ok(Some(result));
    }
    let path = snapshots::directory(inner, "webui").join(format!("{id}.png"));
    let metadata = match tokio::fs::symlink_metadata(&path).await {
        Ok(metadata)
            if metadata.is_file()
                && metadata.len() > 0
                && metadata.len() <= constants::MAX_IMAGE as u64
                && Some(metadata.len()) == value["webuiResult"]["bytes"].as_u64() =>
        {
            metadata
        }
        _ => return Ok(None),
    };
    result.metadata["seed"] = value["webuiResult"]["seed"].clone();
    result.outputs.push(Output::File {
        path,
        mime: "image/png".into(),
        bytes: metadata.len(),
    });
    Ok(Some(result))
}

// Runs at initialization and on the existing minute maintenance tick. Also
// reclaims interrupted publications (PNG without a completed snapshot).
pub(super) async fn prune(inner: &Inner) {
    if !matches!(inner.scope, Scope::Wai) {
        return;
    }
    let directory = snapshots::directory(inner, "webui");
    if !snapshots::safe_directory(&directory).await {
        return;
    }
    let Ok(mut entries) = tokio::fs::read_dir(&directory).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().into_owned();
        // TempPath handles normal cancellation. A killed process cannot run
        // Drop, so reclaim only this writer's recognizable orphan PNG blobs.
        if name
            .strip_prefix(".webui-result-")
            .and_then(|name| name.strip_suffix(".tmp"))
            .is_some_and(snapshots::safe_id)
        {
            if entry.file_type().await.is_ok_and(|kind| kind.is_file())
                && entry
                    .metadata()
                    .await
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.elapsed().ok())
                    .is_some_and(|elapsed| elapsed.as_millis() >= RETENTION as u128)
            {
                let _ = tokio::fs::remove_file(entry.path()).await;
            }
            continue;
        }
        let Some(id) = name
            .strip_suffix(".png")
            .filter(|id| snapshots::safe_id(id))
        else {
            continue;
        };
        if !entry.file_type().await.is_ok_and(|kind| kind.is_file()) {
            continue;
        }
        let expired = match record(inner, id).await {
            Some(value) if value["webuiResult"].is_object() => value["webuiResult"]["expiresAt"]
                .as_i64()
                .is_none_or(|t| t <= now() || t > now() + RETENTION),
            _ => entry
                .metadata()
                .await
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|elapsed| elapsed.as_millis() >= RETENTION as u128),
        };
        if expired {
            snapshots::remove(inner, id).await;
        }
    }
}
