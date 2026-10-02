use super::*;
use std::path::Path;
use tokio::io::AsyncWriteExt;
fn providers(inner: &Inner) -> &'static [&'static str] {
    match inner.scope {
        Scope::Wai => &["webui", "comfy"],
        Scope::Images | Scope::Video => &["comfy"],
    }
}

fn directory(inner: &Inner, provider: &str) -> std::path::PathBuf {
    inner
        .config
        .runtime_root
        .join("jobs")
        .join(if provider == "webui" {
            "wai-webui"
        } else {
            inner.scope.namespace()
        })
}
fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
}
async fn write(path: &Path, value: &Value) -> Result<()> {
    let (file, pending) =
        tempfile::NamedTempFile::new_in(path.parent().unwrap_or_else(|| Path::new(".")))?
            .into_parts();
    // Own the path before yielding: cancelled Tokio file operations may finish
    // in the background, but TempPath still removes only our temporary file.
    let mut file = tokio::fs::File::from_std(file);
    file.write_all(&serde_json::to_vec(value)?).await?;
    file.sync_all().await?;
    drop(file);
    pending
        .persist(path)
        .map_err(|error| ApiError::from(error.error))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_snapshot_cancel_reclaims_pending_and_preserves_old_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("running.json");
        let old = b"{\"status\":\"running\",\"lostAt\":1}";
        std::fs::write(&path, old).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .max_blocking_threads(1)
            .enable_all()
            .build()
            .unwrap();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let blocker = runtime.spawn_blocking(move || {
            started_tx.send(()).unwrap();
            // A failed assertion cannot leave runtime shutdown waiting forever.
            let _ = release_rx.recv_timeout(Duration::from_secs(5));
        });
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        runtime.block_on(async {
            let value = json!({"status": "running", "lostAt": 2});
            let mut writing = Box::pin(write(&path, &value));
            assert!(futures_util::poll!(writing.as_mut()).is_pending());
            drop(writing);
            release_tx.send(()).unwrap();
            blocker.await.unwrap();
        });
        // Drain any file IO submitted before cancellation before inspecting disk.
        runtime.shutdown_timeout(Duration::from_secs(5));
        assert_eq!(std::fs::read(&path).unwrap(), old);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }
}
pub(super) async fn save(inner: &Inner, job: &Job) -> Result<()> {
    let directory = directory(inner, job.provider);
    tokio::fs::create_dir_all(&directory).await?;
    if !tokio::fs::symlink_metadata(&directory).await?.is_dir() {
        return Err(ApiError::new(503, "SNAPSHOT_UNSAFE", "任务记录目录不可用"));
    }
    write(&directory.join(format!("{}.json",job.id)),&json!({"id":job.id,"owner":job.owner,"status":"running","createdAt":job.created,"estimatedSeconds":null,"input":{"modelId":job.input["modelId"],"width":job.input["width"],"height":job.input["height"],"duration":null,"family":job.input.get("family")}})).await
}
pub(super) async fn remove(inner: &Inner, id: &str) {
    if safe_id(id) {
        for provider in providers(inner) {
            let _ =
                tokio::fs::remove_file(directory(inner, provider).join(format!("{id}.json"))).await;
        }
    }
}
async fn drain(inner: &Inner) -> HashMap<String, Lost> {
    let mut records = Vec::new();
    for provider in providers(inner) {
        let directory = directory(inner, provider);
        let Ok(mut files) = tokio::fs::read_dir(&directory).await else {
            continue;
        };
        while let Ok(Some(entry)) = files.next_entry().await {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(id) = name.strip_suffix(".json").filter(|id| safe_id(id)) else {
                continue;
            };
            let Ok(metadata) = entry.metadata().await else {
                continue;
            };
            if !entry.file_type().await.is_ok_and(|t| t.is_file()) || metadata.len() > 16 * 1024 {
                continue;
            }
            let Ok(bytes) = tokio::fs::read(entry.path()).await else {
                continue;
            };
            let Ok(mut value) = serde_json::from_slice::<Value>(&bytes) else {
                continue;
            };
            let Some(owner) = value["owner"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 256 && s.chars().all(|c| !c.is_control()))
                .map(str::to_owned)
            else {
                continue;
            };
            if value["id"] != id || value["status"] != "running" {
                continue;
            }
            let lost_at = value["lostAt"]
                .as_i64()
                .filter(|n| *n > 0)
                .unwrap_or_else(now)
                .min(now());
            if now() - lost_at >= 7 * 24 * 60 * 60 * 1000 {
                let _ = tokio::fs::remove_file(entry.path()).await;
                continue;
            }
            value["lostAt"] = json!(lost_at);
            let _ = write(&entry.path(), &value).await;
            records.push((
                lost_at,
                id.to_string(),
                Lost {
                    owner,
                    family: value["input"]["family"].as_str().map(str::to_owned),
                },
                entry.path(),
            ));
        }
    }
    records.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    let mut lost = HashMap::new();
    for (index, (_, id, owner, path)) in records.into_iter().enumerate() {
        if index < 256 {
            lost.insert(id, owner);
        } else {
            let _ = tokio::fs::remove_file(path).await;
        }
    }
    lost
}

pub(super) async fn progress_event(
    inner: &Inner,
    event: Option<crate::upstream::progress::ProgressUpdate>,
) {
    let lost = event
        .as_ref()
        .is_none_or(|event| event.event == "connection_lost");
    let jobs = inner
        .state
        .lock()
        .await
        .jobs
        .values()
        .cloned()
        .collect::<Vec<_>>();
    for job in jobs {
        if job.provider != "comfy" {
            continue;
        }
        let mut state = job.state.lock().await;
        if state.settled || state.upstream_id.is_empty() {
            continue;
        }
        if lost {
            state.progress_live = false;
            state.history_urgent = true;
            job.notify.notify_one();
        } else if let Some(event) = &event
            && state.upstream_id == event.prompt_id
        {
            state.progress = event.progress;
            state.current_node = event.current_node.clone();
            state.progress_text = event.progress_text.clone();
            state.progress_live = true;
            state.execution_started = true;
            if event.terminal_hint() {
                // WebSocket hints shorten the next authoritative HTTP check;
                // they never settle a job or release its provider capacity.
                state.history_urgent = true;
                state.history_finishing =
                    Some(tokio::time::Instant::now() + Duration::from_secs(5));
                job.notify.notify_one();
            }
        }
    }
}

pub(super) async fn initialize(inner: Arc<Inner>) -> Result<()> {
    if inner.closed.load(Ordering::Relaxed) || inner.cancel.is_cancelled() {
        return Err(closed());
    }
    inner.initialized.get_or_try_init(||async {
        let state=inner.config.runtime_root.join("state");tokio::fs::create_dir_all(&state).await?;let identity_file=state.join(format!("comfy_client_{}.id",inner.scope.client()));
        let existing=tokio::fs::read_to_string(&identity_file).await.unwrap_or_default();let existing=existing.trim();
        let client_id=if (8..=80).contains(&existing.len())&&existing.bytes().all(|c|c.is_ascii_alphanumeric()||c==b'-'){existing.to_string()}else{
            let generated=format!("aics-{}-{}",inner.scope.client(),uuid::Uuid::new_v4().simple());let pending=state.join(format!("comfy_client_{}.{}.tmp",inner.scope.client(),uuid::Uuid::new_v4()));tokio::fs::write(&pending,format!("{generated}\n")).await?;tokio::fs::rename(pending,identity_file).await?;generated
        };
        inner.state.lock().await.lost=drain(&inner).await;
        let progress=crate::upstream::progress::ProgressMonitor::new(&inner.config.comfy_host,&client_id)?;
        let mut events=progress.subscribe();let weak=Arc::downgrade(&inner);let cancel=inner.cancel.clone();
        inner.tasks.spawn(async move {loop{tokio::select!{_=cancel.cancelled()=>return,event=events.recv()=>{
            let event=match event{Ok(event)=>Some(event),Err(tokio::sync::broadcast::error::RecvError::Lagged(_))=>None,Err(_)=>return};let Some(inner)=weak.upgrade()else{return};
            progress_event(&inner,event).await;
        }}}});
        let weak=Arc::downgrade(&inner);let cancel=inner.cancel.clone();
        inner.tasks.spawn(async move {loop{tokio::select!{_=cancel.cancelled()=>return,_=tokio::time::sleep(Duration::from_secs(60))=>{let Some(inner)=weak.upgrade()else{return};let jobs=inner.state.lock().await.jobs.values().cloned().collect::<Vec<_>>();for job in jobs{let expired={let state=job.state.lock().await;state.finished.is_some_and(|t|now()-t>=match &job.execution{Execution::Webui(_)=>2*60*60*1000,Execution::Comfy(plan)=>plan.retention.as_millis() as i64})&&state.permit.is_none()};if expired{jobs::remove(&inner,&job).await;}}}}}});
        Ok::<_,ApiError>(Initialized {client_id,session_id:uuid::Uuid::new_v4().simple().to_string(),progress:std::sync::Mutex::new(Some(progress))})
    }).await?;
    Ok(())
}
