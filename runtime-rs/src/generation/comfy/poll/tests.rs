use super::*;
use crate::upstream::progress::ProgressUpdate;
use axum::{
    Json, Router,
    extract::State,
    routing::{get, post},
};
use std::sync::atomic::AtomicUsize;

async fn fixture(root: &std::path::Path, host: &str) -> (Service, Arc<Job>) {
    let service = Service::new(
        Config {
            sd_host: host.into(),
            comfy_host: host.into(),
            sd_auth: None,
            ai_workspace_root: root.join("ai"),
            runtime_root: root.join("runtime"),
        },
        LocalUpstream::new(),
        CancellationToken::new(),
    )
    .unwrap();
    let permit = service.inner.admission.clone().try_acquire_owned().unwrap();
    let prepared = Prepared {
        input: json!({}),
        provider: "comfy".into(),
        selected: "comfy",
        permit,
        execution: Execution::Comfy(Box::new(ComfyPlan {
            input: json!({}),
            workflow: json!({}),
            metadata: json!({}),
            resources: vec![],
            family: "fixture",
            namespace: "fixture",
            route_base: "/api/generation",
            output_prefix: "fixture",
            media_kind: MediaKind::Image,
            output_node: "10",
            timeout: Duration::from_secs(3600),
            retention: Duration::from_secs(60),
        })),
    };
    let job = jobs::create(prepared, "owner".into(), None);
    {
        let mut state = job.state.lock().await;
        state.status = "running".into();
        state.upstream_id = "owned".into();
        state.observed = true;
        state.progress_live = true;
        state.execution_started = true;
    }
    service
        .inner
        .state
        .lock()
        .await
        .jobs
        .insert(job.id.clone(), job.clone());
    (service, job)
}

#[tokio::test(start_paused = true)]
async fn execution_backoff_reduces_checks_and_loss_or_lag_restores_fallback() {
    let directory = tempfile::tempdir().unwrap();
    let (service, job) = fixture(directory.path(), "http://127.0.0.1:1").await;
    let started = tokio::time::Instant::now();
    let mut reads = 0_u64;
    while started.elapsed() < Duration::from_secs(20) {
        let delay = next_delay(&*job.state.lock().await, reads);
        assert!(wait(&service.inner, &job, delay).await);
        reads += 1;
    }
    assert!(
        reads <= 7,
        "Twenty seconds of execution previously required about forty checks"
    );
    for lost in [
        None,
        Some(ProgressUpdate {
            event: "connection_lost".into(),
            ..Default::default()
        }),
    ] {
        snapshots::progress_event(&service.inner, lost).await;
        let before = tokio::time::Instant::now();
        assert!(wait(&service.inner, &job, Duration::from_secs(3)).await);
        assert_eq!(before.elapsed(), Duration::ZERO);
        let state = job.state.lock().await;
        assert!(!state.progress_live);
        assert_eq!(next_delay(&state, 10), Duration::from_secs(2));
        assert_eq!(state.status, "running");
        assert!(!state.settled);
    }
    service.inner.cancel.cancel();
    assert!(!wait(&service.inner, &job, Duration::from_secs(3)).await);
}

struct History {
    terminal: AtomicBool,
    reads: AtomicUsize,
    observed: tokio::sync::mpsc::UnboundedSender<()>,
}

#[tokio::test]
async fn websocket_terminal_hint_wakes_history_but_cannot_settle_the_job() {
    let directory = tempfile::tempdir().unwrap();
    let (send, mut read) = tokio::sync::mpsc::unbounded_channel();
    let history = Arc::new(History {
        terminal: AtomicBool::new(false),
        reads: AtomicUsize::new(0),
        observed: send,
    });
    let router = Router::new()
        .route(
            "/history/{id}",
            get(|State(history): State<Arc<History>>| async move {
                let response = if history.terminal.load(Ordering::Acquire) {
                    json!({"owned":{"status":{"status_str":"error","messages":[]}}})
                } else {
                    json!({})
                };
                history.reads.fetch_add(1, Ordering::Relaxed);
                let _ = history.observed.send(());
                Json(response)
            }),
        )
        .with_state(history.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let host = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let (service, job) = fixture(directory.path(), &host).await;
    let worker = tokio::spawn(run(service.inner.clone(), job.clone()));
    read.recv().await.unwrap();
    snapshots::progress_event(
        &service.inner,
        Some(ProgressUpdate {
            prompt_id: "owned".into(),
            event: "execution_success".into(),
            ..Default::default()
        }),
    )
    .await;
    {
        let state = job.state.lock().await;
        assert_eq!(state.status, "running");
        assert!(!state.settled);
    }
    tokio::time::timeout(Duration::from_secs(1), read.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(
        !job.state.lock().await.settled,
        "Empty history cannot confirm WebSocket success"
    );
    history.terminal.store(true, Ordering::Release);
    snapshots::progress_event(
        &service.inner,
        Some(ProgressUpdate {
            prompt_id: "owned".into(),
            event: "execution_error".into(),
            ..Default::default()
        }),
    )
    .await;
    tokio::time::timeout(Duration::from_secs(1), worker)
        .await
        .unwrap()
        .unwrap();
    let state = job.state.lock().await;
    assert_eq!(state.status, "failed");
    assert!(state.settled);
    assert!(history.reads.load(Ordering::Relaxed) <= 4);
    drop(state);
    service.inner.cancel.cancel();
    server.abort();
}

#[tokio::test]
async fn failed_result_save_retries_download_without_resubmitting_generation() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let directory = tempfile::tempdir().unwrap();
    let png = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=").unwrap();
    let prompts = Arc::new(AtomicUsize::new(0));
    let downloads = Arc::new(AtomicUsize::new(0));
    let router = Router::new()
        .route("/free", post(|| async { Json(json!({})) }))
        .route("/prompt", post({
            let prompts = prompts.clone();
            move || {
                prompts.fetch_add(1, Ordering::Relaxed);
                async { Json(json!({"prompt_id":"owned"})) }
            }
        }))
        .route("/history/{id}", get(|| async {
            Json(json!({"owned":{"status":{"status_str":"success"},"outputs":{"10":{"images":[{"filename":"fixture_result.png","type":"output"}]}}}}))
        }))
        .route("/view", get({
            let downloads = downloads.clone();
            let png = png.clone();
            move || {
                downloads.fetch_add(1, Ordering::Relaxed);
                let png = png.clone();
                async { ([(axum::http::header::CONTENT_TYPE, "image/png")], png) }
            }
        }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let host = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let (service, job) = fixture(directory.path(), &host).await;
    // Exercise the actual prompt submission without an unrelated WebSocket
    // reconnect worker changing the timing of this local disk failure.
    assert!(
        service
            .inner
            .initialized
            .set(Initialized {
                client_id: "fixture-client".into(),
                session_id: "fixture-session".into(),
                progress: std::sync::Mutex::new(None),
            })
            .is_ok()
    );
    {
        let mut state = job.state.lock().await;
        state.status = "queued".into();
        state.upstream_id.clear();
    }
    let path = directory
        .path()
        .join("runtime/outputs/fixture")
        .join(format!("{}.png", job.id));
    std::fs::create_dir_all(path.parent().unwrap().parent().unwrap()).unwrap();
    // A file blocking the output directory must be reported like a failed write.
    std::fs::write(path.parent().unwrap(), b"blocked directory").unwrap();
    super::super::submit(service.inner.clone(), job.clone())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let changed = job.notify.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if job.state.lock().await.code.as_deref() == Some("RESULT_SAVE_FAILED") {
                break;
            }
            changed.await;
        }
    })
    .await
    .unwrap();
    let failed = jobs::observe(&service.inner, &job.id, "owner")
        .await
        .unwrap();
    assert_eq!(failed.error_code.as_deref(), Some("RESULT_SAVE_FAILED"));
    assert!(
        !failed.settled,
        "A local save failure cannot settle a successful upstream job"
    );
    assert!(job.state.lock().await.permit.is_none());
    assert_eq!(prompts.load(Ordering::Relaxed), 1);
    assert_eq!(downloads.load(Ordering::Relaxed), 1);
    std::fs::remove_file(path.parent().unwrap()).unwrap();
    job.notify.notify_one();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let changed = job.notify.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if job.state.lock().await.status == "succeeded" {
                break;
            }
            changed.await;
        }
    })
    .await
    .unwrap();
    let recovered = jobs::observe(&service.inner, &job.id, "owner")
        .await
        .unwrap();
    assert!(recovered.settled);
    assert_eq!(std::fs::read(&path).unwrap(), png);
    assert_eq!(prompts.load(Ordering::Relaxed), 1);
    assert_eq!(downloads.load(Ordering::Relaxed), 2);
    assert_eq!(
        std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
        1
    );
    assert!(job.state.lock().await.permit.is_none());
    service.close().await;
    server.abort();
}

#[tokio::test]
async fn failed_result_save_video_reports_directory_and_publish_errors() {
    let directory = tempfile::tempdir().unwrap();
    let bytes = b"\x00\x00\x00\x18ftypisomfixture-video-body";
    let router = Router::new().route(
        "/view",
        get(|| async {
            (
                [("content-type", "video/mp4")],
                b"\x00\x00\x00\x18ftypisomfixture-video-body".as_slice(),
            )
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let host = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let root = directory.path().join("outputs");
    let transport = LocalUpstream::new();
    let cancel = CancellationToken::new();
    let output = json!({"filename":"aics_video_fixture.mp4","type":"output"});
    std::fs::write(&root, b"blocked directory").unwrap();
    let error = video_output::materialize(&transport, &host, &root, "video", &output, &cancel)
        .await
        .err()
        .unwrap();
    assert_eq!(error.code, "RESULT_SAVE_FAILED");
    std::fs::remove_file(&root).unwrap();
    let path = root.join("video.mp4");
    std::fs::create_dir_all(&path).unwrap();
    let error = video_output::materialize(&transport, &host, &root, "video", &output, &cancel)
        .await
        .err()
        .unwrap();
    assert_eq!(error.code, "RESULT_SAVE_FAILED");
    assert_eq!(
        std::fs::read_dir(&root).unwrap().count(),
        1,
        "Failed publication reclaims temporary bytes"
    );
    std::fs::remove_dir(&path).unwrap();
    let recovered = video_output::materialize(&transport, &host, &root, "video", &output, &cancel)
        .await
        .unwrap();
    assert_eq!(recovered.len(), bytes.len() as u64);
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    server.abort();
}

#[tokio::test]
async fn result_failures_release_capacity_and_survive_history_eviction() {
    let directory = tempfile::tempdir().unwrap();
    let reads = Arc::new(AtomicUsize::new(0));
    let downloads = Arc::new(AtomicUsize::new(0));
    let router = Router::new()
        .route("/history/{id}", get({
            let reads = reads.clone();
            move || {
                let first = reads.fetch_add(1, Ordering::Relaxed) == 0;
                async move { Json(if first {
                    json!({"owned":{"status":{"status_str":"success"},"outputs":{"10":{"images":[{"filename":"fixture_result.png","type":"output"}]}}}})
                } else { json!({}) }) }
            }
        }))
        .route("/view", get({
            let downloads = downloads.clone();
            move || {
                downloads.fetch_add(1, Ordering::Relaxed);
                async { axum::http::StatusCode::SERVICE_UNAVAILABLE }
            }
        }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let host = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let (service, job) = fixture(directory.path(), &host).await;
    let worker = tokio::spawn(run(service.inner.clone(), job.clone()));
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let state = job.state.lock().await;
            if state.code.as_deref() == Some("COMFY_RESULT_ERROR") {
                assert!(state.unknown && !state.settled);
                assert!(state.permit.is_none());
                break;
            }
            drop(state);
            // Skip wall-clock backoff; retry_delay is checked separately below.
            job.notify.notify_one();
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(downloads.load(Ordering::Relaxed) >= 60);
    assert_eq!(reads.load(Ordering::Relaxed), 1);
    assert_eq!(retry_delay(1), Duration::from_millis(500));
    assert_eq!(retry_delay(60), Duration::from_secs(3));
    service.inner.cancel.cancel();
    worker.await.unwrap();
    service.close().await;
    server.abort();
}

#[tokio::test]
async fn cancelling_inflight_result_drops_transfer_and_temporary_bytes() {
    use futures_util::StreamExt;
    let directory = tempfile::tempdir().unwrap();
    let reads = Arc::new(AtomicUsize::new(0));
    let router = Router::new().route(
        "/view",
        get({
            let reads = reads.clone();
            move || {
                reads.fetch_add(1, Ordering::Relaxed);
                async {
                    let body = futures_util::stream::iter([Ok::<_, std::io::Error>(
                        axum::body::Bytes::from_static(b"\x89PNG\r\n\x1a\nfixture body"),
                    )])
                    .chain(futures_util::stream::pending());
                    (
                        [("content-type", "image/png")],
                        axum::body::Body::from_stream(body),
                    )
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let host = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let (service, job) = fixture(directory.path(), &host).await;
    let (inner, transfer_job) = (service.inner.clone(), job.clone());
    let worker = tokio::spawn(async move {
        materialize(
            &inner,
            &transfer_job,
            &json!({"filename":"fixture_result.png","type":"output"}),
        )
        .await
    });
    let output = directory.path().join("runtime/outputs/fixture");
    tokio::time::timeout(Duration::from_secs(3), async {
        while std::fs::read_dir(&output).map_or(true, |mut files| files.next().is_none()) {
            job.notify.notify_waiters();
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    job.state.lock().await.status = "cancelling".into();
    job.notify.notify_waiters();
    let error = tokio::time::timeout(Duration::from_secs(1), worker)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(error.code, "ABORT_ERR");
    assert_eq!(
        reads.load(Ordering::Relaxed),
        1,
        "progress must not restart download"
    );
    assert_eq!(std::fs::read_dir(output).unwrap().count(), 0);
    service.close().await;
    server.abort();
}
