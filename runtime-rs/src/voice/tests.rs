use super::*;
use axum::{
    body::Body,
    extract::Query,
    http::{Request, StatusCode},
    routing::get,
};
use http_body_util::BodyExt;
use std::sync::{
    Mutex,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tower::ServiceExt;

#[derive(Default)]
struct Mock {
    spoken: AtomicUsize,
    translated: AtomicUsize,
    fail_gpt: AtomicBool,
    fail_tts: AtomicBool,
    switches: Mutex<Vec<String>>,
    payloads: Mutex<Vec<Value>>,
}
fn wave() -> Vec<u8> {
    let mut data = vec![0; 128];
    data[..4].copy_from_slice(b"RIFF");
    data[8..12].copy_from_slice(b"WAVE");
    data[12..16].copy_from_slice(b"fmt ");
    data[16..20].copy_from_slice(&16u32.to_le_bytes());
    data[36..40].copy_from_slice(b"data");
    data
}
async fn mock_speech(
    Extension(mock): Extension<Arc<Mock>>,
    Json(payload): Json<Value>,
) -> Response {
    mock.spoken.fetch_add(1, Ordering::SeqCst);
    mock.payloads.lock().unwrap().push(payload);
    if mock.fail_tts.load(Ordering::Relaxed) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error":"RuntimeError: reference audio missing"})),
        )
            .into_response();
    }
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    ([("content-type", "audio/wav")], wave()).into_response()
}
async fn mock_translate(Extension(mock): Extension<Arc<Mock>>) -> Json<Value> {
    mock.translated.fetch_add(1, Ordering::SeqCst);
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    Json(
        json!({"translation": "こんにちは", "segments": [{"source": "你好", "translation": "こんにちは"}]}),
    )
}
async fn weight(
    Extension(mock): Extension<Arc<Mock>>,
    Query(query): Query<HashMap<String, String>>,
) -> StatusCode {
    let value = query.get("weights_path").unwrap().clone();
    mock.switches.lock().unwrap().push(value.clone());
    if value == "natsume.gpt" && mock.fail_gpt.load(Ordering::Relaxed) {
        StatusCode::INTERNAL_SERVER_ERROR
    } else {
        StatusCode::OK
    }
}
async fn fixture() -> (
    tempfile::TempDir,
    Arc<VoiceService>,
    AppState,
    Arc<Mock>,
    CancellationToken,
) {
    let directory = tempfile::tempdir().unwrap();
    let mock = Arc::new(Mock::default());
    let upstream = Router::new()
        .route("/docs", get(|| async { "docs" }))
        .route("/health", get(|| async { "ok" }))
        .route("/tts", post(mock_speech))
        .route("/translate", post(mock_translate))
        .route("/set_sovits_weights", get(weight))
        .route("/set_gpt_weights", get(weight))
        .layer(Extension(mock.clone()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let stop = CancellationToken::new();
    let done = stop.clone();
    tokio::spawn(async move {
        axum::serve(listener, upstream)
            .with_graceful_shutdown(done.cancelled_owned())
            .await
            .unwrap();
    });
    let profiles = ["nene", "natsume"]
        .iter()
        .map(|id| {
            (
                (*id).to_owned(),
                config::Profile {
                    reference: config::Reference {
                        ref_audio_path: format!("{id}.wav"),
                        prompt_text: "参考台词".into(),
                        prompt_lang: "ja".into(),
                    },
                    gpt_weights_path: format!("{id}.gpt"),
                    sovits_weights_path: format!("{id}.sovits"),
                    ..Default::default()
                },
            )
        })
        .collect();
    let shutdown = CancellationToken::new();
    let settings = Settings {
        tts_host: format!("http://{address}"),
        translation_url: format!("http://{address}"),
        translation_port: address.port(),
        profiles,
        python: directory.path().join("absent-python"),
        script: directory.path().join("absent-script"),
        log: directory.path().join("translate.log"),
    };
    let service = Arc::new(VoiceService::with_settings(settings, shutdown.clone()));
    let config = Config {
        app_root: directory.path().into(),
        runtime_root: directory.path().join("runtime"),
        ai_workspace_root: directory.path().join("AI"),
        sd_host: format!("http://{address}"),
        sd_auth: None,
        comfy_host: format!("http://{address}"),
        bind: address,
        token: String::new(),
        desktop_secret: None,
        source_profile_id: None,
        workspace_pointer: None,
        workspace_candidate: None,
        config_root: None,
        gateway_origin: format!("http://{address}"),
        workspace_root: None,
        workspace_id: None,
        create_workspace: false,
    };
    let state = AppState::new(
        Arc::new(config),
        Arc::new(crate::host::HostAuthority::new(None, None, None)),
        shutdown,
    );
    (directory, service, state, mock, stop)
}

#[tokio::test]
async fn tts_protocol_shares_audio_fixes_wav_and_keeps_post_queue_until_body_drop() {
    let (_directory, service, state, mock, stop) = fixture().await;
    let app = router(service.clone()).with_state(state);
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("voice", "nene")
        .append_pair("text", "绫地宁宁・你好\n世界")
        .finish();
    let make_request = || {
        Request::builder()
            .uri(format!("/api/tts?{query}"))
            .body(Body::empty())
            .unwrap()
    };
    let (first, second) = tokio::join!(
        app.clone().oneshot(make_request()),
        app.clone().oneshot(make_request())
    );
    let first = first.unwrap();
    let second = second.unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    assert_eq!(second.status(), StatusCode::OK);
    assert_eq!(mock.spoken.load(Ordering::SeqCst), 1);
    let audio = first.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(u32::from_le_bytes(audio[4..8].try_into().unwrap()), 120);
    assert_eq!(u32::from_le_bytes(audio[40..44].try_into().unwrap()), 84);
    assert_eq!(
        mock.payloads.lock().unwrap()[0]["text"],
        "あやち ねね你好。世界"
    );
    assert_eq!(
        mock.payloads.lock().unwrap()[0]["text_split_method"],
        "cut5"
    );
    let cached = app.clone().oneshot(make_request()).await.unwrap();
    assert_eq!(cached.headers()["x-tts-cache"], "hit");
    let input = json!({"voice":"nene", "text":"別の文"});
    let audio = service
        .speech
        .stream(payload::validate(&input, &service.speech.settings).unwrap())
        .await
        .unwrap();
    assert_eq!(service.queue_status()["running"], true);
    drop(audio);
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        while service.queue_status()["running"] == true {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    mock.fail_tts.store(true, Ordering::Relaxed);
    let error = service
        .speech
        .stream(payload::validate(&input, &service.speech.settings).unwrap())
        .await
        .unwrap_err();
    assert_eq!(error.status, StatusCode::BAD_GATEWAY);
    assert_eq!(error.code, "TTS_FAILED");
    assert!(error.message.contains("GPT-SoVITS 生成失败"));
    assert!(error.message.contains("reference audio missing"));
    assert_eq!(service.queue_status()["running"], false);
    service.close().await;
    stop.cancel();
}

#[tokio::test]
async fn translation_segments_are_cached_and_failed_weight_switch_restores_both_models() {
    let (_directory, service, state, mock, stop) = fixture().await;
    let app = router(service.clone()).with_state(state);
    let translate = || {
        Request::builder()
            .method("POST")
            .uri("/api/translate")
            .header("content-type", "application/json")
            .body(Body::from(json!({"text": "你好"}).to_string()))
            .unwrap()
    };
    let (a, b) = tokio::join!(app.clone().oneshot(translate()), app.oneshot(translate()));
    assert_eq!(a.unwrap().status(), StatusCode::OK);
    let result: Value =
        serde_json::from_slice(&b.unwrap().into_body().collect().await.unwrap().to_bytes())
            .unwrap();
    assert_eq!(result["segments"][0]["translation"], "こんにちは");
    assert_eq!(mock.translated.load(Ordering::SeqCst), 1);
    let nene = payload::validate(
        &json!({"voice":"nene", "text":"はい"}),
        &service.speech.settings,
    )
    .unwrap();
    service.speech.prepare(&nene).await.unwrap();
    mock.fail_gpt.store(true, Ordering::Relaxed);
    let natsume = payload::validate(
        &json!({"voice":"natsume", "text":"はい"}),
        &service.speech.settings,
    )
    .unwrap();
    assert!(service.speech.prepare(&natsume).await.is_err());
    service.speech.prepare(&nene).await.unwrap();
    let switches = mock.switches.lock().unwrap().clone();
    assert_eq!(
        switches,
        vec![
            "nene.sovits",
            "nene.gpt",
            "natsume.sovits",
            "natsume.gpt",
            "nene.sovits",
            "nene.gpt"
        ]
    );
    let queue = queue::Queue::new("fixture");
    let permits: Vec<_> = (0..16).map(|_| queue.reserve().unwrap()).collect();
    assert_eq!(queue.reserve().err().unwrap().code, "QUEUE_FULL");
    drop(permits);
    assert_eq!(queue.status()["pending"], 0);
    service.close().await;
    stop.cancel();
}
