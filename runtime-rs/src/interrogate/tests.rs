use super::*;
use axum::{
    body::{Body, Bytes},
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
};
use futures_util::StreamExt;
use std::{
    collections::HashMap,
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};
use tokio::sync::Notify;

struct Mock {
    stage: AtomicUsize,
    input: std::path::PathBuf,
    started: Notify,
    disconnected: Arc<Notify>,
}
struct Disconnect(Arc<Notify>);
impl Drop for Disconnect {
    fn drop(&mut self) {
        self.0.notify_one();
    }
}
async fn webui_tagger(State(mock): State<Arc<Mock>>) -> Json<Value> {
    Json(if mock.stage.load(Ordering::Relaxed) == 1 {
        json!({"tags":["1girl","blue_hair"],"scores":{"1girl":0.9}})
    } else {
        json!({})
    })
}
async fn webui_native(State(mock): State<Arc<Mock>>) -> Json<Value> {
    Json(if mock.stage.load(Ordering::Relaxed) == 2 {
        json!({"caption":"1girl, blue_hair"})
    } else {
        json!({})
    })
}
async fn objects(State(mock): State<Arc<Mock>>) -> Json<Value> {
    Json(if mock.stage.load(Ordering::Relaxed) >= 3 {
        json!({"WD14Tagger":{}})
    } else {
        json!({})
    })
}
async fn tag(
    State(mock): State<Arc<Mock>>,
    Query(query): Query<HashMap<String, String>>,
) -> axum::response::Response {
    let name = query.get("filename").unwrap();
    assert!(name.starts_with("aics_interrogate_"));
    assert_eq!(query.get("type").unwrap(), "input");
    assert!(
        std::fs::read(mock.input.join(name))
            .unwrap()
            .starts_with(b"\x89PNG\r\n\x1a\n")
    );
    if mock.stage.load(Ordering::Relaxed) == 4 {
        let guard = Disconnect(mock.disconnected.clone());
        mock.started.notify_one();
        let stream = futures_util::stream::once(async {
            Ok::<_, std::io::Error>(Bytes::from_static(b"partial tags"))
        })
        .chain(futures_util::stream::pending())
        .map(move |chunk| {
            let _ = &guard;
            chunk
        });
        return Body::from_stream(stream).into_response();
    }
    Json(json!("1girl, blue hair, BLUE_HAIR")).into_response()
}
fn image() -> String {
    let image = image::RgbImage::from_fn(128, 128, |x, y| {
        image::Rgb([
            ((x * 37 + y * 3) % 256) as u8,
            ((y * 29 + x * 7) % 256) as u8,
            ((x * 13 + y * 11) % 256) as u8,
        ])
    });
    let mut bytes = Vec::new();
    image::DynamicImage::ImageRgb8(image)
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .unwrap();
    assert!(bytes.len() > 1024);
    STANDARD.encode(bytes)
}
async fn fixture() -> (
    tempfile::TempDir,
    Arc<InterrogateService>,
    Arc<Mock>,
    String,
    reqwest::Client,
    CancellationToken,
) {
    let root = tempfile::tempdir().unwrap();
    let stop = CancellationToken::new();
    let mock = Arc::new(Mock {
        stage: AtomicUsize::new(0),
        input: root.path().join("ComfyUI/input"),
        started: Notify::new(),
        disconnected: Arc::new(Notify::new()),
    });
    let upstream = Router::new()
        .route("/tagger/v1/interrogate", post(webui_tagger))
        .route("/sdapi/v1/interrogate", post(webui_native))
        .route("/object_info", get(objects))
        .route("/pysssss/wd14tagger/tag", get(tag))
        .with_state(mock.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_url = format!("http://{}", listener.local_addr().unwrap());
    let done = stop.clone();
    tokio::spawn(async move {
        axum::serve(listener, upstream)
            .with_graceful_shutdown(done.cancelled_owned())
            .await
            .unwrap();
    });
    let settings = settings::Settings {
        models: vec![root.path().join("empty-models")],
        ort: root.path().join("absent-ort.dll"),
        vips: root.path().join("absent-vips.dll"),
        sd: upstream_url.clone(),
        comfy: upstream_url.clone(),
        comfy_input: mock.input.clone(),
    };
    let shutdown = CancellationToken::new();
    let service = Arc::new(InterrogateService::with_settings(
        settings,
        shutdown.clone(),
    ));
    let config = Config {
        app_root: root.path().into(),
        runtime_root: root.path().join("runtime"),
        ai_workspace_root: root.path().into(),
        sd_host: upstream_url.clone(),
        sd_auth: None,
        comfy_host: upstream_url,
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
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    (root, service, mock, url, client, stop)
}

#[tokio::test]
async fn protocol_fallbacks_report_actual_engine_and_keep_private_temporary_inputs_owned() {
    let (_root, service, mock, url, client, stop) = fixture().await;
    let encoded = image();
    let status = client
        .get(format!("{url}/api/interrogate/status"))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(status["wd14"]["available"], false);
    assert_eq!(status["maxBytes"], MAX_BYTES);
    let remote = client
        .post(format!("{url}/api/interrogate"))
        .header("x-forwarded-for", "198.51.100.9")
        .header("content-type", "application/json")
        .body("not json")
        .send()
        .await
        .unwrap();
    assert_eq!(remote.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        client
            .post(format!("{url}/api/interrogate"))
            .json(&json!({"image":encoded,"threshold":1.5}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    for (stage, engine) in [(0, "heuristic"), (1, "webui"), (2, "webui"), (3, "comfy")] {
        mock.stage.store(stage, Ordering::Relaxed);
        let result = client
            .post(format!("{url}/api/interrogate"))
            .json(&json!({"image":encoded,"mode":"tag"}))
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap();
        assert_eq!(result["engine"], engine, "{result}");
        assert_eq!(result["editable"], true);
        if stage == 0 {
            assert!(result["warning"].as_str().unwrap().contains("演示"));
        }
        if stage == 3 {
            assert_eq!(result["tags"], json!(["1girl", "BLUE_HAIR"]));
            assert!(std::fs::read_dir(&mock.input).unwrap().next().is_some());
        }
    }
    service.close().await;
    assert!(std::fs::read_dir(&mock.input).unwrap().next().is_none());
    stop.cancel();
}

#[tokio::test]
async fn disconnected_interrogation_closes_upstream_and_releases_single_admission() {
    let (_root, service, mock, url, client, stop) = fixture().await;
    let encoded = image();
    mock.stage.store(4, Ordering::Relaxed);
    let requester = client.clone();
    let endpoint = format!("{url}/api/interrogate");
    let body = json!({"image":encoded,"mode":"tag"});
    let request = tokio::spawn(async move { requester.post(endpoint).json(&body).send().await });
    tokio::time::timeout(Duration::from_secs(2), mock.started.notified())
        .await
        .unwrap();
    assert_eq!(
        client
            .post(format!("{url}/api/interrogate"))
            .json(&json!({"image":encoded}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    request.abort();
    let _ = request.await;
    tokio::time::timeout(Duration::from_secs(2), mock.disconnected.notified())
        .await
        .expect("upstream must close when caller disconnects");
    mock.stage.store(0, Ordering::Relaxed);
    let result = client
        .post(format!("{url}/api/interrogate"))
        .json(&json!({"image":encoded,"mode":"caption"}))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(result["engine"], "heuristic");
    assert_eq!(result["tags"], json!([]));
    service.close().await;
    assert!(std::fs::read_dir(&mock.input).unwrap().next().is_none());
    stop.cancel();
}
