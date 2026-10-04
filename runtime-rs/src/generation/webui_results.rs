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

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(root: &std::path::Path) -> Service {
        Service::new(
            Config {
                sd_host: "http://127.0.0.1:1".into(),
                comfy_host: "http://127.0.0.1:1".into(),
                sd_auth: None,
                ai_workspace_root: root.join("ai"),
                runtime_root: root.into(),
            },
            LocalUpstream::new(),
            CancellationToken::new(),
        )
        .unwrap()
    }
    #[tokio::test]
    async fn pending_result_survives_close_and_recovers_offline_with_owner_and_expiry_guards() {
        let root = tempfile::tempdir().unwrap();
        let service = fixture(root.path());
        let input = validation::validate(
            &json!({"prompt":"landscape","seed":42,"width":1024,"height":1024}),
            true,
        )
        .unwrap();
        let job = jobs::create(
            Prepared {
                input: serde_json::to_value(&input).unwrap(),
                provider: "webui".into(),
                selected: "webui",
                execution: Execution::Webui(Box::new(input)),
                permit: service.inner.admission.clone().try_acquire_owned().unwrap(),
            },
            "owner".into(),
            None,
        );
        let bytes = b"\x89PNG\r\n\x1a\nfixture";
        stage(&service.inner, &job, bytes).await.unwrap();
        {
            let mut state = job.state.lock().await;
            state.status = "succeeded".into();
            state.collection_pending = true;
            state.result = Some(Output::Bytes {
                bytes: Arc::new(bytes.to_vec()),
                mime: "image/png".into(),
            });
        }
        service
            .inner
            .state
            .lock()
            .await
            .jobs
            .insert(job.id.clone(), job.clone());
        service.close().await;
        let restarted = fixture(root.path());
        let mut task = json!({"provider":"webui","principalId":"owner","checkpoint":{"gatewayJobId":job.id},
            "metadata":{},"status":"running","resultState":"none"});
        let mut cancellation = None;
        let result = restarted
            .recover_task(&task, &mut cancellation)
            .await
            .unwrap();
        assert!(result.settled && !result.unknown);
        assert_eq!(result.status, "succeeded");
        assert_eq!(result.metadata["seed"], 42);
        let Output::File { path, .. } = &result.outputs[0] else {
            panic!("recovery must own staged file");
        };
        assert_eq!(tokio::fs::read(path).await.unwrap(), bytes);
        task["principalId"] = json!("other");
        assert!(
            restarted
                .recover_task(&task, &mut cancellation)
                .await
                .unwrap()
                .unknown
        );
        assert!(
            path.exists(),
            "wrong owner cannot read or delete the result"
        );
        task["principalId"] = json!("owner");
        task["cancelRequestedAt"] = json!(now());
        let cancelled = restarted
            .recover_task(&task, &mut cancellation)
            .await
            .unwrap();
        assert_eq!(cancelled.status, "cancelled");
        assert!(cancelled.outputs.is_empty());
        assert!(!path.exists());

        // Old snapshots have no payload: preserve the existing unknown outcome.
        snapshots::save(&restarted.inner, &job).await.unwrap();
        task.as_object_mut().unwrap().remove("cancelRequestedAt");
        assert!(
            restarted
                .recover_task(&task, &mut cancellation)
                .await
                .unwrap()
                .unknown
        );
        stage(&restarted.inner, &job, bytes).await.unwrap();
        let mut saved = record(&restarted.inner, &job.id).await.unwrap();
        saved["webuiResult"]["expiresAt"] = json!(now() - 1);
        snapshots::write(
            &snapshots::directory(&restarted.inner, "webui").join(format!("{}.json", job.id)),
            &saved,
        )
        .await
        .unwrap();
        let directory = snapshots::directory(&restarted.inner, "webui");
        let old_temp = directory.join(".webui-result-orphan.abcdef.tmp");
        let recent_temp = directory.join(".webui-result-recent.abcdef.tmp");
        let unrelated = directory.join(".unrelated.tmp");
        for file in [&old_temp, &recent_temp, &unrelated] {
            std::fs::write(file, bytes).unwrap();
        }
        let old_time = std::time::SystemTime::now() - Duration::from_secs(3 * 60 * 60);
        for file in [&old_temp, &unrelated] {
            std::fs::File::options()
                .write(true)
                .open(file)
                .unwrap()
                .set_times(std::fs::FileTimes::new().set_modified(old_time))
                .unwrap();
        }
        prune(&restarted.inner).await;
        assert!(
            !old_temp.exists(),
            "a killed writer's blob must not persist indefinitely"
        );
        assert!(
            recent_temp.exists(),
            "do not race a live atomic publication"
        );
        assert!(
            unrelated.exists(),
            "do not sweep another writer's temporary files"
        );
        assert!(!path.exists());
        assert!(
            restarted
                .recover_task(&task, &mut cancellation)
                .await
                .unwrap()
                .unknown
        );
        restarted.close().await;
    }
}
