use super::*;
use axum::{
    Router,
    body::{Body, Bytes},
    response::IntoResponse,
    routing::get,
};
use futures_util::stream;
use tokio::sync::Semaphore;

async fn fixture(router: Router) -> (tempfile::TempDir, Service, tokio::task::JoinHandle<()>) {
    let directory = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let host = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let service = Service::new(
        Config {
            sd_host: host.clone(),
            sd_auth: None,
            comfy_host: host,
            ai_workspace_root: directory.path().join("ai"),
            runtime_root: directory.path().join("runtime"),
        },
        LocalUpstream::new(),
        CancellationToken::new(),
    )
    .unwrap();
    (directory, service, server)
}
async fn materialize(service: &Service) -> Result<Output> {
    materialize_scoped(
        &service.inner,
        "image",
        "fixture",
        "fixture",
        &json!({"filename":"fixture_result.png","type":"output"}),
    )
    .await
}

#[tokio::test]
async fn split_signatures_publish_exact_image_bytes_and_normalized_mime() {
    for (content_type, bytes, extension, expected_mime) in [
        (
            "Image/PNG; fixture=true",
            b"\x89PNG\r\n\x1a\npng-payload".as_slice(),
            "png",
            "image/png",
        ),
        (
            "image/jpeg",
            b"\xff\xd8\xff".as_slice(),
            "jpg",
            "image/jpeg",
        ),
        (
            "image/webp",
            b"RIFF\x00\x00\x00\x00WEBPwebp-payload".as_slice(),
            "webp",
            "image/webp",
        ),
    ] {
        let router = Router::new().route(
            "/view",
            get(move || async move {
                let chunks = stream::iter(bytes.iter().copied()).then(|byte| async move {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                    Ok::<_, std::io::Error>(vec![byte])
                });
                ([("content-type", content_type)], Body::from_stream(chunks))
            }),
        );
        let (_directory, service, server) = fixture(router).await;
        let Output::File {
            path,
            mime,
            bytes: length,
        } = materialize(&service).await.unwrap()
        else {
            panic!("streamed image must be a file")
        };
        assert_eq!(path.extension().unwrap(), extension);
        assert_eq!(mime, expected_mime);
        assert_eq!(length, bytes.len() as u64);
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert_eq!(
            std::fs::read_dir(path.parent().unwrap()).unwrap().count(),
            1
        );
        service.close().await;
        server.abort();
    }
}

#[tokio::test]
async fn bounded_stream_retains_network_error_priority_and_reclaims_rejected_bytes() {
    for (case, expected) in [
        ("length", "COMFY_RESPONSE_TOO_LARGE"),
        ("valid-over", "COMFY_RESPONSE_TOO_LARGE"),
        ("mime-over", "COMFY_RESPONSE_TOO_LARGE"),
        ("status-broken", "COMFY_UNAVAILABLE"),
        ("mime", "INVALID_RESULT"),
        ("status", "COMFY_RESULT_ERROR"),
    ] {
        let router = Router::new().route(
            "/view",
            get(move || async move {
                if case == "length" {
                    return (
                        [("content-length", (constants::MAX_IMAGE + 1).to_string())],
                        Body::from_stream(stream::pending::<std::io::Result<Bytes>>()),
                    )
                        .into_response();
                }
                let chunks =
                    stream::once(async { Ok(Bytes::from_static(b"\x89PNG\r\n\x1a\nhead")) }).chain(
                        stream::iter(
                            0..if case.ends_with("over") {
                                constants::MAX_IMAGE / 65536
                            } else {
                                1
                            },
                        )
                        .then(move |_| async move {
                            if case == "status-broken" {
                                tokio::time::sleep(Duration::from_millis(1)).await;
                                Err(std::io::Error::other("isolated body interruption"))
                            } else {
                                Ok(Bytes::from_static(&[0; 65536]))
                            }
                        }),
                    );
                (
                    axum::http::StatusCode::from_u16(if case.starts_with("status") {
                        502
                    } else {
                        200
                    })
                    .unwrap(),
                    [(
                        "content-type",
                        if case.starts_with("mime") {
                            "text/plain"
                        } else {
                            "image/png"
                        },
                    )],
                    Body::from_stream(chunks),
                )
                    .into_response()
            }),
        );
        let (directory, service, server) = fixture(router).await;
        assert_eq!(
            materialize(&service).await.unwrap_err().code,
            expected,
            "{case}"
        );
        let outputs = directory.path().join("runtime/outputs/fixture");
        assert!(
            std::fs::read_dir(outputs).map_or(true, |entries| entries.count() == 0),
            "{case}"
        );
        service.close().await;
        server.abort();
    }
}

#[tokio::test]
async fn cancellation_timeout_and_dropped_recovery_reclaim_partial_images() {
    for interruption in ["cancel", "timeout", "drop"] {
        let gate = Arc::new(Semaphore::new(0));
        let router = Router::new().route(
            "/view",
            get(move || {
                let gate = gate.clone();
                async move {
                    let chunks = stream::once(async {
                        Ok::<_, std::io::Error>(b"\x89PNG\r\n\x1a\nhead".to_vec())
                    })
                    .chain(stream::once(async move {
                        gate.acquire().await.unwrap().forget();
                        Ok(b"tail".to_vec())
                    }));
                    ([("content-type", "image/png")], Body::from_stream(chunks))
                }
            }),
        );
        let (directory, service, server) = fixture(router).await;
        let owner = service.clone();
        let download = tokio::spawn(async move { materialize(&owner).await });
        let outputs = directory.path().join("runtime/outputs/fixture");
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if std::fs::read_dir(&outputs).is_ok_and(|entries| entries.count() == 1) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
        assert!(
            !outputs.join("image.png").exists(),
            "partial bytes cannot be published"
        );
        match interruption {
            "cancel" => {
                service.inner.cancel.cancel();
                assert_eq!(download.await.unwrap().unwrap_err().code, "ABORT_ERR");
            }
            "timeout" => {
                tokio::time::pause();
                tokio::time::advance(Duration::from_secs(21)).await;
                tokio::time::resume();
                assert_eq!(download.await.unwrap().unwrap_err().code, "COMFY_TIMEOUT");
            }
            _ => {
                // Recovery can drop this future before its normal error return.
                download.abort();
                assert!(download.await.unwrap_err().is_cancelled());
            }
        }
        assert_eq!(
            std::fs::read_dir(outputs).unwrap().count(),
            0,
            "{interruption}"
        );
        service.close().await;
        server.abort();
    }
}
