use super::*;
use std::path::Path;
use tokio::io::AsyncWriteExt;
fn providers(inner: &Inner) -> &'static [&'static str] {
    match inner.scope {
        Scope::Wai => &["webui", "comfy"],
        Scope::Images | Scope::Video => &["comfy"],
    }
}

pub(super) fn directory(inner: &Inner, provider: &str) -> std::path::PathBuf {
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
pub(super) fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
}
pub(super) async fn safe_directory(directory: &Path) -> bool {
    for path in [directory.parent().unwrap(), directory] {
        if !tokio::fs::symlink_metadata(path)
            .await
            .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
        {
            return false;
        }
    }
    true
}
pub(super) async fn write(path: &Path, value: &Value) -> Result<()> {
    let (file, pending) =
        tempfile::NamedTempFile::new_in(path.parent().unwrap_or_else(|| Path::new(".")))?
            .into_parts();
    // Own the path before yielding: cancelled Tokio file operations may finish
    // in the background, but TempPath still removes only our temporary file.
    let mut file = tokio::fs::File::from_std(file);
    file.write_all(&serde_json::to_vec(value)?).await?;
    // sync_all waits for pending writes but does not propagate their errors.
    file.flush().await?;
    file.sync_all().await?;
    drop(file);
    pending
        .persist(path)
        .map_err(|error| ApiError::from(error.error))?;
    Ok(())
}

pub(super) async fn save(inner: &Inner, job: &Job) -> Result<()> {
    let directory = directory(inner, job.provider);
    let jobs = directory.parent().unwrap();
    tokio::fs::create_dir_all(jobs).await?;
    if !tokio::fs::symlink_metadata(jobs).await?.is_dir() {
        return Err(ApiError::new(503, "SNAPSHOT_UNSAFE", "任务记录目录不可用"));
    }
    tokio::fs::create_dir_all(&directory).await?;
    if !safe_directory(&directory).await {
        return Err(ApiError::new(503, "SNAPSHOT_UNSAFE", "任务记录目录不可用"));
    }
    write(&directory.join(format!("{}.json",job.id)),&json!({"id":job.id,"owner":job.owner,"status":"running","createdAt":job.created,"estimatedSeconds":null,"input":{"modelId":job.input["modelId"],"width":job.input["width"],"height":job.input["height"],"duration":null,"family":job.input.get("family")}})).await
}
pub(super) async fn remove(inner: &Inner, id: &str) {
    if safe_id(id) {
        for provider in providers(inner) {
            let directory = directory(inner, provider);
            if safe_directory(&directory).await {
                let _ = tokio::fs::remove_file(directory.join(format!("{id}.json"))).await;
                if *provider == "webui" {
                    let _ = tokio::fs::remove_file(directory.join(format!("{id}.png"))).await;
                }
            }
        }
    }
}
async fn drain(inner: &Inner) -> HashMap<String, Lost> {
    let mut records = Vec::new();
    for provider in providers(inner) {
        let directory = directory(inner, provider);
        if !safe_directory(&directory).await {
            continue;
        }
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
            // Record loss once. Reopening an unchanged recovery ledger must not
            // rewrite and sync every entry before the first status request.
            if value["lostAt"].as_i64() != Some(lost_at) {
                value["lostAt"] = json!(lost_at);
                let _ = write(&entry.path(), &value).await;
            }
            // Completed WebUI images are recoverable, unlike ordinary lost
            // jobs. Keep them ahead of metadata-only records within the same
            // 256-record startup budget; their separate TTL remains two hours.
            let pending_result = *provider == "webui"
                && value["webuiResult"]["expiresAt"]
                    .as_i64()
                    .is_some_and(|t| t > now() && t <= now() + 2 * 60 * 60 * 1000)
                && tokio::fs::symlink_metadata(entry.path().with_extension("png"))
                    .await
                    .is_ok_and(|m| {
                        m.is_file()
                            && m.len() > 0
                            && m.len() <= constants::MAX_IMAGE as u64
                            && Some(m.len()) == value["webuiResult"]["bytes"].as_u64()
                    });
            let ordered_at = if pending_result {
                value["webuiResult"]["expiresAt"].as_i64().unwrap()
            } else {
                lost_at
            };
            records.push((
                pending_result,
                ordered_at,
                id.to_string(),
                Lost {
                    owner,
                    family: value["input"]["family"].as_str().map(str::to_owned),
                },
                entry.path(),
                *provider == "webui",
            ));
        }
    }
    records.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| b.1.cmp(&a.1))
            .then_with(|| a.2.cmp(&b.2))
    });
    let mut lost = HashMap::new();
    for (index, (_, _, id, owner, path, webui)) in records.into_iter().enumerate() {
        if index < 256 {
            lost.insert(id, owner);
        } else {
            if webui {
                let _ = tokio::fs::remove_file(path.with_extension("png")).await;
            }
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
        webui_results::prune(&inner).await;
        native::prune(&inner).await;
        inner.state.lock().await.lost=drain(&inner).await;
        let progress = if inner.native_images { None } else {
        let progress=crate::upstream::progress::ProgressMonitor::new(&inner.config.comfy_host,&client_id)?;
        let mut events=progress.subscribe();let weak=Arc::downgrade(&inner);let cancel=inner.cancel.clone();
        inner.tasks.spawn(async move {loop{tokio::select!{_=cancel.cancelled()=>return,event=events.recv()=>{
            let event=match event{Ok(event)=>Some(event),Err(tokio::sync::broadcast::error::RecvError::Lagged(_))=>None,Err(_)=>return};let Some(inner)=weak.upgrade()else{return};
            progress_event(&inner,event).await;
        }}}});
        Some(progress) };
        let weak=Arc::downgrade(&inner);let cancel=inner.cancel.clone();
        inner.tasks.spawn(async move {loop{tokio::select!{_=cancel.cancelled()=>return,_=tokio::time::sleep(Duration::from_secs(60))=>{let Some(inner)=weak.upgrade()else{return};webui_results::prune(&inner).await;let jobs=inner.state.lock().await.jobs.values().cloned().collect::<Vec<_>>();for job in jobs{let expired={let state=job.state.lock().await;state.finished.is_some_and(|t|now()-t>=match &job.execution{Execution::Webui(_)=>2*60*60*1000,Execution::Native(_)=>30*60*1000,Execution::Comfy(plan)=>plan.retention.as_millis() as i64})&&state.permit.is_none()};if expired{jobs::remove(&inner,&job).await;}}native::prune(&inner).await;}}}});
        Ok::<_,ApiError>(Initialized {client_id,session_id:uuid::Uuid::new_v4().simple().to_string(),progress:std::sync::Mutex::new(progress)})
    }).await?;
    Ok(())
}
