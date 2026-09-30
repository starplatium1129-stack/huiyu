use super::*;
use crate::upstream::progress::ProgressUpdate;
use axum::{Json, Router, extract::State, routing::get};
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
