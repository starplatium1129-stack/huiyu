mod restart;
use super::*;
use axum::{
    Router,
    body::{Body, Bytes},
    extract::{ConnectInfo, State},
    http::{HeaderMap, Request, StatusCode},
    response::IntoResponse,
    routing::get,
};
use http_body_util::BodyExt;
use std::sync::atomic::{AtomicUsize, Ordering};
use tower::ServiceExt;
struct Mock {
    bytes: Vec<u8>,
    manifest: Vec<u8>,
    ranges: AtomicUsize,
}
async fn metadata(State(mock): State<Arc<Mock>>) -> impl IntoResponse {
    (
        [("content-type", "application/json")],
        mock.manifest.clone(),
    )
}
async fn resource(State(mock): State<Arc<Mock>>, headers: HeaderMap) -> axum::response::Response {
    let offset = headers
        .get("range")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("bytes="))
        .and_then(|value| value.strip_suffix('-'))
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    if offset > 0 {
        mock.ranges.fetch_add(1, Ordering::SeqCst);
        assert_eq!(headers.get("if-range").unwrap(), "\"fixture\"");
    }
    let length = mock.bytes.len();
    let stream = futures_util::stream::unfold((mock, offset), move |(mock, at)| async move {
        if at >= mock.bytes.len() {
            return None;
        }
        tokio::time::sleep(std::time::Duration::from_millis(3)).await;
        let end = (at + 32 * 1024).min(mock.bytes.len());
        Some((
            Ok::<_, std::io::Error>(Bytes::copy_from_slice(&mock.bytes[at..end])),
            (mock, end),
        ))
    });
    let mut response = Body::from_stream(stream).into_response();
    response.headers_mut().insert(
        "content-length",
        (length - offset).to_string().parse().unwrap(),
    );
    response
        .headers_mut()
        .insert("etag", "\"fixture\"".parse().unwrap());
    if offset > 0 {
        *response.status_mut() = StatusCode::PARTIAL_CONTENT;
        response.headers_mut().insert(
            "content-range",
            format!("bytes {offset}-{}/{length}", length - 1)
                .parse()
                .unwrap(),
        );
    }
    response
}
async fn call(
    app: &Router,
    method: &str,
    path: &str,
    body: Value,
    peer: &str,
    etag: Option<&str>,
) -> (StatusCode, HeaderMap, Bytes) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("host", "127.0.0.1:3210")
        .header("content-type", "application/json");
    if let Some(etag) = etag {
        request = request.header("if-none-match", etag);
    }
    let mut request = request.body(Body::from(body.to_string())).unwrap();
    request
        .extensions_mut()
        .insert(ConnectInfo(peer.parse::<std::net::SocketAddr>().unwrap()));
    let response = app.clone().oneshot(request).await.unwrap();
    let (parts, body) = response.into_parts();
    (
        parts.status,
        parts.headers,
        body.collect().await.unwrap().to_bytes(),
    )
}
async fn settled(service: &Service) -> Value {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if service.queue_status()["active"] == 0 {
                return service.status(false);
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("isolated resource task settles")
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn http_cancel_recover_resumes_verified_download_and_installed_overlay_revokes() {
    let (directory, gateway, file, _, _) = fixture();
    let bytes = (0..3 * 1024 * 1024)
        .map(|index| (index % 251) as u8)
        .collect::<Vec<_>>();
    let manifest = Manifest {
        entries: vec![entry("assets/a.png", &bytes)],
    };
    let raw = serde_json::to_vec(&manifest.value()).unwrap();
    let mock = Arc::new(Mock {
        bytes: bytes.clone(),
        manifest: raw.clone(),
        ranges: AtomicUsize::new(0),
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(
        axum::serve(
            listener,
            Router::new()
                .route("/download/manifest.json", get(metadata))
                .route("/download/assets/a.png", get(resource))
                .with_state(mock.clone()),
        )
        .into_future(),
    );
    let policy = json!({"sources":{"http":{"approved":true,"kind":"http","baseUrl":format!("http://{address}/"),"loopbackFixture":true}},"releases":{"download":{"approved":true,"sourceId":"http","path":"download","kind":"full","packageIdentity":policy::package_identity(&raw,None),"targetIdentity":manifest.identity()}}});
    let user = directory.path().join("user");
    write(
        &file,
        &serde_json::to_vec(
            &json!({"userDataRoot":user,"protectedRoots":[gateway.app_root],"policy":policy}),
        )
        .unwrap(),
    );
    let shutdown = CancellationToken::new();
    let service = Arc::new(
        Service::configured(&gateway, Some(file.clone()), true, shutdown.clone()).unwrap(),
    );
    let app = router(service.clone())
        .fallback(|| async { "bundled" })
        .layer(axum::middleware::from_fn_with_state(
            service.clone(),
            overlay,
        ))
        .with_state(AppState::new(
            Arc::new(gateway.clone()),
            Arc::new(HostAuthority::new(None, None, None)),
            shutdown,
        ));
    let (status, _, body) = call(
        &app,
        "GET",
        "/api/resources/status",
        Value::Null,
        "127.0.0.1:1234",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let initial: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(initial["configured"], true);
    assert_eq!(initial["mounted"], false);
    assert!(!user.join("resource-library-v1").exists());
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/resources/tasks",
            json!({"action":"download","releaseId":"download"}),
            "203.0.113.1:1234",
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, _, body) = call(
        &app,
        "POST",
        "/api/resources/tasks",
        json!({"action":"download","releaseId":"download"}),
        "127.0.0.1:1234",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let accepted: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(service.queue_status()["active"], 1);
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/resources/tasks",
            json!({"action":"recover"}),
            "127.0.0.1:1234",
            None
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if service.status(false)["task"]["bytes"].as_u64().unwrap_or(0) > 0 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let id = accepted["task"]["id"].as_str().unwrap();
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/api/resources/tasks/{id}/cancel"),
            json!({}),
            "127.0.0.1:1234",
            None
        )
        .await
        .0,
        StatusCode::OK
    );
    let cancelled = settled(&service).await;
    assert_eq!(cancelled["task"]["state"], "cancelled");
    assert_eq!(cancelled["mounted"], false);
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/resources/tasks",
            json!({"action":"recover"}),
            "127.0.0.1:1234",
            None
        )
        .await
        .0,
        StatusCode::ACCEPTED
    );
    let recovered = settled(&service).await;
    assert_eq!(recovered["task"]["state"], "completed", "{recovered}");
    assert_eq!(recovered["task"]["resumeAction"], "download");
    assert_eq!(recovered["mounted"], false);
    assert_eq!(recovered["releases"][0]["downloaded"], true);
    assert!(mock.ranges.load(Ordering::SeqCst) > 0);
    server.abort();
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/resources/tasks",
            json!({"action":"import","releaseId":"download"}),
            "127.0.0.1:1234",
            None
        )
        .await
        .0,
        StatusCode::ACCEPTED
    );
    let installed = settled(&service).await;
    assert_eq!(installed["task"]["state"], "completed", "{installed}");
    assert_eq!(installed["mounted"], true);
    let (status, headers, result) = call(
        &app,
        "GET",
        "/assets/a.png",
        Value::Null,
        "127.0.0.1:1234",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result.as_ref(), bytes);
    assert_eq!(headers["x-resource-version"], manifest.identity());
    let etag = headers["etag"].to_str().unwrap();
    assert_eq!(
        call(
            &app,
            "GET",
            "/assets/a.png",
            Value::Null,
            "127.0.0.1:1234",
            Some(etag)
        )
        .await
        .0,
        StatusCode::NOT_MODIFIED
    );
    let (_, head_headers, head) = call(
        &app,
        "HEAD",
        "/assets/a.png",
        Value::Null,
        "127.0.0.1:1234",
        None,
    )
    .await;
    assert!(head.is_empty());
    assert_eq!(head_headers["content-length"], bytes.len().to_string());
    assert_eq!(
        call(
            &app,
            "GET",
            "/assets/a.png",
            Value::Null,
            "203.0.113.1:1234",
            None
        )
        .await
        .2,
        "bundled"
    );
    let ctx = config::load(&gateway, &file, CancellationToken::new())
        .unwrap()
        .ctx;
    let root = ctx.store.join("versions").join(manifest.identity());
    let mut tampered = bytes.clone();
    tampered[0] ^= 1;
    write(&root.join("assets/a.png"), &tampered);
    assert_eq!(
        call(
            &app,
            "GET",
            "/assets/a.png",
            Value::Null,
            "127.0.0.1:1234",
            None
        )
        .await
        .2,
        "bundled"
    );
    assert_eq!(service.status(false)["mounted"], false);
    assert_eq!(service.status(false)["issue"]["code"], "CONTENT_INVALID");
    service.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recovery_outcome_survives_task_settlement_and_restart_without_raw_details() {
    let (_directory, gateway, file, ctx, _) = fixture();
    let original = lifecycle::run(&operation(&ctx), "import", "A").unwrap();
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    let interrupted = Operation {
        ctx: ctx.clone(),
        cancel,
        progress: Arc::new(move |event| {
            if event["phase"] == "prepared" {
                trigger.cancel();
            }
        }),
    };
    assert_eq!(
        lifecycle::run(&interrupted, "import", "C")
            .unwrap_err()
            .code,
        "CANCELLED"
    );
    let journal = state::journal(&ctx).unwrap().unwrap();
    // Reproduce a process interruption after switching the pointer, followed
    // by damaged candidate bytes, using only disposable neutral fixture files.
    fs::write_json(&ctx.store.join("current.json"), &state::next(&journal)).unwrap();
    let target = state::version_root(&ctx, &journal["target"]).unwrap();
    write(&target.join("assets/a.png"), b"X");
    let shutdown = CancellationToken::new();
    let service =
        Arc::new(Service::configured(&gateway, Some(file.clone()), true, shutdown).unwrap());
    let host = Arc::new(HostAuthority::new(None, None, None));
    service
        .start("recover", None, host.admit_owned().unwrap())
        .unwrap();
    let status = settled(&service).await;
    assert_eq!(status["task"]["state"], "completed");
    assert!(status["task"]["error"].is_null());
    assert_eq!(
        status["task"]["result"],
        json!({"action":"rolled-back",
        "warning":{"code":"CONTENT_INVALID","message":"新版本资源内容校验失败。"}})
    );
    assert_eq!(status["mounted"], true);
    assert_eq!(status["recoveryRequired"], false);
    assert_eq!(status["current"]["releaseId"], "A");
    assert_eq!(state::read(&ctx).unwrap(), original["state"]);
    assert!(!ctx.store.join("pending.json").exists());
    assert!(!target.exists());
    service.close().await;

    let task_file = ctx.store.join("gateway/task.json");
    let mut saved = fs::json(&task_file, false, false).unwrap().unwrap();
    assert_eq!(saved["result"], status["task"]["result"]);
    saved["result"]["warning"]["message"] = "private /home/operator/secret token=fixture".into();
    saved["result"]["state"] = json!({"localPath":"/private/fixture"});
    fs::write_json(&task_file, &saved).unwrap();
    let restarted =
        Service::configured(&gateway, Some(file), true, CancellationToken::new()).unwrap();
    assert_eq!(
        restarted.status(false)["task"]["result"],
        status["task"]["result"]
    );
    saved.as_object_mut().unwrap().remove("result");
    fs::write_json(&task_file, &saved).unwrap();
    let legacy = restarted.status(true);
    assert_eq!(legacy["task"]["state"], "completed");
    assert!(legacy["task"]["result"].is_null());
    assert_eq!(legacy["mounted"], true);
    restarted.close().await;
}
