use super::*;
use axum::{Router, body::Body, routing::get};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

const DATA: &[u8] = b"isolated synthetic model, never real weights";

#[tokio::test]
async fn resumes_cancelled_bytes_with_a_validated_range_and_final_hash() {
    use axum::{
        http::{HeaderMap, StatusCode},
        response::IntoResponse,
    };
    let temp = tempfile::tempdir().unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let requests = count.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/resume", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().route(
                "/resume",
                get(move |headers: HeaderMap| {
                    let requests = requests.clone();
                    async move {
                        requests.fetch_add(1, Ordering::SeqCst);
                        if let Some(range) = headers.get("range") {
                            assert_eq!(range, "bytes=8-");
                            (
                                StatusCode::PARTIAL_CONTENT,
                                [(
                                    "content-range",
                                    format!("bytes 8-{}/{}", DATA.len() - 1, DATA.len()),
                                )],
                                Body::from(&DATA[8..]),
                            )
                                .into_response()
                        } else {
                            Body::from_stream(
                                futures_util::stream::once(async {
                                    Ok::<_, Infallible>(Bytes::copy_from_slice(&DATA[..8]))
                                })
                                .chain(futures_util::stream::pending()),
                            )
                            .into_response()
                        }
                    }
                }),
            ),
        )
        .await
        .unwrap();
    });
    let spec = plan(temp.path(), url.clone());
    let partial = temp.path().join(format!(
        "ComfyUI/models/vae/.huiyu-{}.part",
        spec.spec.sha256
    ));
    let cancel = CancellationToken::new();
    let token = cancel.clone();
    let (send, _events) = tokio::sync::mpsc::unbounded_channel();
    let worker_sender = send.clone();
    let worker = tokio::spawn(async move {
        download(&spec, &reqwest::Client::new(), &worker_sender, &token).await
    });
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if tokio::fs::metadata(&partial)
                .await
                .is_ok_and(|meta| meta.len() == 8)
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    cancel.cancel();
    assert_eq!(worker.await.unwrap().unwrap_err().code, "CANCELLED");
    assert_eq!(std::fs::read(&partial).unwrap(), &DATA[..8]);
    let result = download(
        &plan(temp.path(), url),
        &reqwest::Client::new(),
        &send,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(result["state"], "downloaded");
    assert_eq!(
        std::fs::read(temp.path().join("ComfyUI/models/vae/fixture.safetensors")).unwrap(),
        DATA
    );
    assert_eq!(count.load(Ordering::SeqCst), 2);
    assert!(!partial.exists());
    server.abort();
}
fn plan(workspace: &Path, url: String) -> DownloadPlan {
    DownloadPlan {
        workspace: workspace.into(),
        root: workspace.join("ComfyUI/models"),
        id: "fixture".into(),
        url,
        spec: ModelFile {
            path: "vae/fixture.safetensors".into(),
            bytes: DATA.len() as u64,
            sha256: hex::encode(Sha256::digest(DATA)),
        },
    }
}
fn no_parts(workspace: &Path) {
    assert!(
        std::fs::read_dir(workspace.join("ComfyUI/models/vae"))
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".part"))
    );
}

#[tokio::test]
async fn isolated_download_checks_disk_bytes_hash_and_publishes_without_replacing_models() {
    let temp = tempfile::tempdir().unwrap();
    let target = temp.path().join("ComfyUI/models/vae/fixture.safetensors");
    let count = Arc::new(AtomicUsize::new(0));
    let calls = count.clone();
    let race_target = target.clone();
    let app = Router::new()
        .route(
            "/ok",
            get(move || {
                let calls = calls.clone();
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    DATA
                }
            }),
        )
        .route("/bad", get(|| async { vec![b'x'; DATA.len()] }))
        .route("/short", get(|| async { b"partial" }))
        .route(
            "/race",
            get(move || {
                let target = race_target.clone();
                async move {
                    std::fs::write(target, b"keep concurrent model").unwrap();
                    DATA
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = reqwest::Client::new();
    let (send, mut events) = tokio::sync::mpsc::unbounded_channel();
    let cancel = CancellationToken::new();
    let mut spec = plan(temp.path(), format!("{origin}/ok"));
    assert_eq!(
        download(&spec, &client, &send, &cancel).await.unwrap()["state"],
        "downloaded"
    );
    assert_eq!(std::fs::read(&target).unwrap(), DATA);
    no_parts(temp.path());
    let mut phases = Vec::new();
    while let Ok(event) = events.try_recv() {
        phases.push(event["phase"].clone());
    }
    assert!(phases.contains(&json!("downloading")));
    assert!(phases.contains(&json!("verifying")));
    assert_eq!(
        download(&spec, &client, &send, &cancel).await.unwrap()["state"],
        "already-present"
    );
    assert_eq!(
        count.load(Ordering::SeqCst),
        1,
        "matching existing content must not be downloaded again"
    );
    std::fs::write(&target, vec![b'x'; DATA.len()]).unwrap();
    assert_eq!(
        download(&spec, &client, &send, &cancel)
            .await
            .unwrap_err()
            .code,
        "MODEL_CONFLICT"
    );
    assert_eq!(std::fs::read(&target).unwrap(), vec![b'x'; DATA.len()]);
    assert_eq!(count.load(Ordering::SeqCst), 1);
    std::fs::remove_file(&target).unwrap();
    for (route, code) in [("bad", "HASH_MISMATCH"), ("short", "SIZE_MISMATCH")] {
        spec.url = format!("{origin}/{route}");
        assert_eq!(
            download(&spec, &client, &send, &cancel)
                .await
                .unwrap_err()
                .code,
            code
        );
        assert!(!target.exists());
        no_parts(temp.path());
    }
    let old_bytes = spec.spec.bytes;
    spec.spec.bytes = u64::MAX;
    assert_eq!(
        download(&spec, &client, &send, &cancel)
            .await
            .unwrap_err()
            .code,
        "ENOSPC"
    );
    assert!(!target.exists());
    no_parts(temp.path());
    spec.spec.bytes = old_bytes;
    spec.url = format!("{origin}/race");
    assert_eq!(
        download(&spec, &client, &send, &cancel)
            .await
            .unwrap_err()
            .code,
        "MODEL_CONFLICT"
    );
    assert_eq!(std::fs::read(&target).unwrap(), b"keep concurrent model");
    no_parts(temp.path());
    server.abort();
}

#[tokio::test]
async fn cancelling_isolated_stream_cleans_temporary_file_and_admission_binds_current_workspace() {
    let temp = tempfile::tempdir().unwrap();
    let entered = Arc::new(tokio::sync::Notify::new());
    let signal = entered.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().route(
                "/slow",
                get(move || {
                    let signal = signal.clone();
                    async move {
                        signal.notify_one();
                        Body::from_stream(futures_util::stream::pending::<
                            std::result::Result<Bytes, Infallible>,
                        >())
                    }
                }),
            ),
        )
        .await
        .unwrap()
    });
    let spec = plan(temp.path(), format!("{origin}/slow"));
    let workspace = temp.path().to_path_buf();
    let cancel = CancellationToken::new();
    let token = cancel.clone();
    let (send, _events) = tokio::sync::mpsc::unbounded_channel();
    let worker =
        tokio::spawn(async move { download(&spec, &reqwest::Client::new(), &send, &token).await });
    tokio::time::timeout(Duration::from_secs(3), entered.notified())
        .await
        .unwrap();
    cancel.cancel();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), worker)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err()
            .code,
        "CANCELLED"
    );
    assert!(
        !workspace
            .join("ComfyUI/models/vae/fixture.safetensors")
            .exists()
    );
    no_parts(&workspace);
    server.abort();

    let (_temp, service) = super::super::tests::fixture(json!({}));
    let request = |path: &str, reviewed| DownloadRequest {
        workspace_path: path.into(),
        reviewed,
    };
    assert!(
        service
            .download_setup_model("../../secret".into(), request("any", true))
            .is_err()
    );
    assert_eq!(
        service
            .download_setup_model("qwen-vae".into(), request("other workspace", true))
            .unwrap_err()
            .code,
        "WORKSPACE_CHANGED"
    );
    let active = service
        .config
        .ai_workspace_root
        .to_string_lossy()
        .into_owned();
    assert_eq!(
        service
            .download_setup_model("qwen-vae".into(), request(&active, false))
            .unwrap_err()
            .code,
        "WORKSPACE_CHANGED"
    );
    let permit = service
        .setup_verify_lock
        .clone()
        .acquire_owned()
        .await
        .unwrap();
    assert_eq!(
        service
            .download_setup_model("qwen-vae".into(), request(&active, true))
            .unwrap_err()
            .code,
        "SETUP_BUSY"
    );
    drop(permit);
    let response = service
        .download_setup_model("qwen-vae".into(), request(&active, true))
        .unwrap();
    drop(response);
    let _released = tokio::time::timeout(
        Duration::from_secs(3),
        service.setup_verify_lock.clone().acquire_owned(),
    )
    .await
    .unwrap()
    .unwrap();
    service.close().await;
}
