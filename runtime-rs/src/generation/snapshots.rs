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
            value["lostAt"] = json!(lost_at);
            let _ = write(&entry.path(), &value).await;
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
        inner.tasks.spawn(async move {loop{tokio::select!{_=cancel.cancelled()=>return,_=tokio::time::sleep(Duration::from_secs(60))=>{let Some(inner)=weak.upgrade()else{return};webui_results::prune(&inner).await;let jobs=inner.state.lock().await.jobs.values().cloned().collect::<Vec<_>>();for job in jobs{let expired={let state=job.state.lock().await;state.finished.is_some_and(|t|now()-t>=match &job.execution{Execution::Webui(_)=>2*60*60*1000,Execution::Native(_)=>30*60*1000,Execution::Comfy(plan)=>plan.retention.as_millis() as i64})&&state.permit.is_none()};if expired{jobs::remove(&inner,&job).await;}}}}}});
        Ok::<_,ApiError>(Initialized {client_id,session_id:uuid::Uuid::new_v4().simple().to_string(),progress:std::sync::Mutex::new(progress)})
    }).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(root: &Path) -> Service {
        Service::new(
            Config {
                sd_host: "http://127.0.0.1:1".into(),
                comfy_host: "http://127.0.0.1:1".into(),
                sd_auth: None,
                ai_workspace_root: root.join("unused-ai"),
                runtime_root: root.to_path_buf(),
            },
            LocalUpstream::new(),
            CancellationToken::new(),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn recovery_keeps_newest_256_and_expires_only_valid_seven_day_records() {
        let root = tempfile::tempdir().unwrap();
        let service = fixture(root.path());
        let folder = directory(&service.inner, "comfy");
        std::fs::create_dir_all(&folder).unwrap();
        let timestamp = now();
        for index in 0..257 {
            let id = format!("job-{index:03}");
            std::fs::write(
                folder.join(format!("{id}.json")),
                json!({"id":id,"owner":"owner","status":"running","lostAt":timestamp-index,
                    "input":{"family":"wai"}})
                .to_string(),
            )
            .unwrap();
        }
        std::fs::write(
            folder.join("expired.json"),
            json!({"id":"expired","owner":"owner",
            "status":"running","lostAt":timestamp-7*24*60*60*1000})
            .to_string(),
        )
        .unwrap();
        let malformed = b"{\"id\":\"other\",\"owner\":\"owner\",\"status\":\"running\"}";
        std::fs::write(folder.join("malformed.json"), malformed).unwrap();
        let recovered = drain(&service.inner).await;
        assert_eq!(recovered.len(), 256);
        assert!(recovered.contains_key("job-000"));
        assert!(!recovered.contains_key("job-256"));
        assert!(!folder.join("job-256.json").exists());
        assert!(!folder.join("expired.json").exists());
        assert_eq!(
            std::fs::read(folder.join("malformed.json")).unwrap(),
            malformed
        );
        assert_eq!(recovered["job-000"].family.as_deref(), Some("wai"));
        let second = drain(&service.inner).await;
        assert_eq!(second.len(), 256);
        let value: Value =
            serde_json::from_slice(&std::fs::read(folder.join("job-000.json")).unwrap()).unwrap();
        assert_eq!(value["lostAt"], timestamp);
    }

    #[tokio::test]
    async fn completed_webui_results_outrank_lost_jobs_within_the_256_record_budget() {
        let root = tempfile::tempdir().unwrap();
        let service = fixture(root.path());
        let webui = directory(&service.inner, "webui");
        let comfy = directory(&service.inner, "comfy");
        std::fs::create_dir_all(&webui).unwrap();
        std::fs::create_dir_all(&comfy).unwrap();
        let timestamp = now();
        for index in 0..256 {
            // Reverse names ensure ordering follows completion time, not ID.
            let id = format!("webui-{:03}", 255 - index);
            std::fs::write(webui.join(format!("{id}.png")), b"png").unwrap();
            std::fs::write(
                webui.join(format!("{id}.json")),
                json!({
                    "id":id,"owner":"owner","status":"running","lostAt":timestamp-1000,
                    "webuiResult":{"expiresAt":timestamp+60_000+index,"bytes":3,"seed":42}
                })
                .to_string(),
            )
            .unwrap();
            let id = format!("comfy-{index:03}");
            std::fs::write(
                comfy.join(format!("{id}.json")),
                json!({
                    "id":id,"owner":"owner","status":"running","lostAt":timestamp
                })
                .to_string(),
            )
            .unwrap();
        }
        let recovered = drain(&service.inner).await;
        assert_eq!(recovered.len(), 256);
        assert!(recovered.keys().all(|id| id.starts_with("webui-")));
        assert!(webui.join("webui-255.png").exists());
        assert!(webui.join("webui-255.json").exists());
        assert!(!comfy.join("comfy-000.json").exists());

        std::fs::write(webui.join("newest.png"), b"png").unwrap();
        std::fs::write(
            webui.join("newest.json"),
            json!({
                "id":"newest","owner":"owner","status":"running",
                "webuiResult":{"expiresAt":timestamp+120_000,"bytes":3,"seed":43}
            })
            .to_string(),
        )
        .unwrap();
        let bounded = drain(&service.inner).await;
        assert_eq!(bounded.len(), 256);
        assert!(bounded.contains_key("newest"));
        assert!(!bounded.contains_key("webui-255"));
        assert!(!webui.join("webui-255.json").exists());
        assert!(!webui.join("webui-255.png").exists());
        assert!(webui.join("webui-000.png").exists());
    }

    #[cfg(any(unix, windows))]
    #[tokio::test]
    async fn linked_snapshot_directories_never_recover_or_delete_external_records() {
        fn link(source: &Path, target: &Path) {
            #[cfg(unix)]
            std::os::unix::fs::symlink(source, target).unwrap();
            #[cfg(windows)]
            assert!(std::process::Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:AICS_TEST_LINK -Target $env:AICS_TEST_TARGET | Out-Null"])
                .env("AICS_TEST_LINK", target).env("AICS_TEST_TARGET", source).status().unwrap().success());
        }
        let external = tempfile::tempdir().unwrap();
        let bytes = json!({"id":"outside","owner":"owner","status":"running",
            "lostAt":now()-8*24*60*60*1000})
        .to_string();
        std::fs::write(external.path().join("outside.json"), &bytes).unwrap();
        for parent in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let service = fixture(root.path());
            let folder = directory(&service.inner, "comfy");
            if parent {
                std::fs::create_dir_all(external.path().join("wai")).unwrap();
                std::fs::write(external.path().join("wai/outside.json"), &bytes).unwrap();
                link(external.path(), folder.parent().unwrap());
            } else {
                std::fs::create_dir_all(folder.parent().unwrap()).unwrap();
                link(external.path(), &folder);
            }
            assert!(drain(&service.inner).await.is_empty());
            remove(&service.inner, "outside").await;
            let target = external.path().join(if parent {
                "wai/outside.json"
            } else {
                "outside.json"
            });
            assert_eq!(std::fs::read(target).unwrap(), bytes.as_bytes());
        }
    }

    #[cfg(unix)]
    #[test]
    fn snapshot_write_failure_preserves_previous_record() {
        const CHILD: &str = "HUIYU_TEST_SNAPSHOT_WRITE_FAILURE_CHILD";
        if std::env::var_os(CHILD).is_none() {
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "generation::snapshots::tests::snapshot_write_failure_preserves_previous_record", "--nocapture"])
                .env(CHILD, "1")
                .status()
                .unwrap();
            assert!(status.success());
            return;
        }
        // File-size limits are process-wide: fault only this isolated child,
        // never concurrent tests, user files or the parent runtime.
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("running.json");
        let old = br#"{"status":"running","lostAt":1}"#;
        std::fs::write(&path, old).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        unsafe {
            libc::signal(libc::SIGXFSZ, libc::SIG_IGN);
            let limit = libc::rlimit {
                rlim_cur: 0,
                rlim_max: 0,
            };
            assert_eq!(libc::setrlimit(libc::RLIMIT_FSIZE, &limit), 0);
        }
        let result = runtime.block_on(write(&path, &json!({"lostAt":2})));
        assert!(
            result.is_err(),
            "A failed buffered write must not be published"
        );
        assert_eq!(std::fs::read(path).unwrap(), old);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

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
