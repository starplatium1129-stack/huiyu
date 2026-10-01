use super::*;
use axum::http::StatusCode;

async fn fixture() -> (
    tempfile::TempDir,
    Arc<InterrogateService>,
    String,
    reqwest::Client,
    CancellationToken,
) {
    let root = tempfile::tempdir().unwrap();
    let shutdown = CancellationToken::new();
    let service = Arc::new(InterrogateService::with_settings(
        pixai::Settings {
            python: root.path().join("missing-python.exe"),
            model_dir: root.path().join("missing-model"),
            deps_dir: root.path().join("missing-deps"),
            torch_site_packages: root.path().join("missing-torch"),
            script: root.path().join("missing-worker.py"),
            temp_root: root.path().join("private-inputs"),
        },
        shutdown.clone(),
    ));
    let config = Config {
        app_root: root.path().into(),
        runtime_root: root.path().join("runtime"),
        ai_workspace_root: root.path().into(),
        sd_host: "http://127.0.0.1:9".into(),
        sd_auth: None,
        comfy_host: "http://127.0.0.1:9".into(),
        bind: "127.0.0.1:0".parse().unwrap(),
        token: String::new(),
        desktop_secret: None,
        source_profile_id: None,
        workspace_pointer: None,
        workspace_candidate: None,
        config_root: None,
        gateway_origin: String::new(),
        workspace_root: None,
        workspace_id: None,
        create_workspace: false,
    };
    let state = AppState::new(
        Arc::new(config),
        Arc::new(crate::host::HostAuthority::new(None, None, None)),
        shutdown,
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let stop = CancellationToken::new();
    let done = stop.clone();
    let app = router(service.clone()).with_state(state);
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(done.cancelled_owned())
        .await
        .unwrap();
    });
    (root, service, url, reqwest::Client::new(), stop)
}

#[tokio::test]
async fn pixai_is_the_local_default_and_unavailable_models_never_become_fake_results() {
    let (root, service, url, client, stop) = fixture().await;
    let status = client
        .get(format!("{url}/api/interrogate/status"))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(status["defaultEngine"], "pixai");
    assert_eq!(status["engines"], json!(["pixai"]));
    assert_eq!(status["pixai"]["available"], false);
    assert_eq!(status["thresholdDefault"], 0.17);
    assert_eq!(status["maxBytes"], MAX_BYTES);
    let endpoint = format!("{url}/api/interrogate");
    let remote = client
        .post(&endpoint)
        .header("x-forwarded-for", "198.51.100.9")
        .header("content-type", "application/json")
        .body("not json")
        .send()
        .await
        .unwrap();
    assert_eq!(remote.status(), StatusCode::FORBIDDEN);
    let image = STANDARD.encode(vec![0; 2048]);
    for body in [
        json!({"image":image,"threshold":1.5}),
        json!({"image":image,"mode":"unknown"}),
    ] {
        assert_eq!(
            client
                .post(&endpoint)
                .json(&body)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    let unavailable = client
        .post(&endpoint)
        .json(&json!({"image":image}))
        .send()
        .await
        .unwrap();
    assert_eq!(unavailable.status(), StatusCode::SERVICE_UNAVAILABLE);
    let result = unavailable.json::<Value>().await.unwrap();
    assert_eq!(result["ok"], false);
    assert!(result["code"].as_str().unwrap().starts_with("PIXAI_"));
    assert!(result.get("tags").is_none());
    assert!(
        std::fs::read_dir(root.path().join("private-inputs"))
            .unwrap()
            .next()
            .is_none()
    );
    service.close().await;
    stop.cancel();
}

#[tokio::test]
async fn request_body_limit_preserves_twenty_mib_before_model_admission() {
    let (_root, service, url, client, stop) = fixture().await;
    let admission = service.client.admit().unwrap();
    let endpoint = format!("{url}/api/interrogate");
    for bytes in [12 * 1024 * 1024 + 1, MAX_BYTES] {
        let response = client.post(&endpoint)
            .json(&json!({"image":format!("data:image/png;base64,{}", STANDARD.encode(vec![0;bytes]))}))
            .send().await.unwrap();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(
            response.json::<Value>().await.unwrap()["code"],
            "INTERROGATE_BUSY"
        );
    }
    let response = client
        .post(&endpoint)
        .json(&json!({"image":STANDARD.encode(vec![0;MAX_BYTES+1])}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let rejection = response.json::<Value>().await.unwrap();
    assert_eq!(rejection["code"], "IMAGE_TOO_LARGE");
    assert_eq!(rejection["error"], "图片超过 20MB 限制");
    let response = client
        .post(&endpoint)
        .json(&json!({"image":STANDARD.encode(vec![0;MAX_BYTES]),"extra":"x".repeat(64*1024)}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    drop(admission);
    service.close().await;
    stop.cancel();
}

#[test]
fn captions_are_label_summaries_not_a_separate_caption_model() {
    let result = results::finish(
        json!({"tags":["1girl","white_shirt"]}),
        "pixai",
        "caption",
        0.17,
    );
    assert_eq!(result["engine"], "pixai");
    assert_eq!(result["captionDerived"], "pixai-tags");
    assert_eq!(result["caption"], "a girl, wearing a white shirt");
    let input = validate(json!({"image":STANDARD.encode(vec![0;2048])})).unwrap();
    assert_eq!(input.threshold, 0.17);
}
