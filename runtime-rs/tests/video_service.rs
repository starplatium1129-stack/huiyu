use axum::{
    Json, Router,
    extract::{Path, State},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::future::BoxFuture;
use huiyu_runtime::{
    error::{ApiError, Result},
    execution::{ExecutionHooks, Output},
    upstream::LocalUpstream,
    video::{Config, Service, Transcoder},
};
use image::ImageEncoder;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;
fn png() -> Vec<u8> {
    let mut bytes = Vec::new();
    image::codecs::png::PngEncoder::new(&mut bytes)
        .write_image(&[100, 120, 140], 1, 1, image::ExtendedColorType::Rgb8)
        .unwrap();
    bytes
}
fn movie() -> Vec<u8> {
    b"\0\0\0\x18ftypisom\0\0\0\0isomiso2".to_vec()
}
#[derive(Default)]
struct Hooks {
    checkpoint: Mutex<Value>,
    saved: Mutex<HashMap<String, Vec<u8>>>,
    outputs: Mutex<BTreeMap<usize, Output>>,
    concat_fail: AtomicBool,
}
impl ExecutionHooks for Hooks {
    fn checkpoint(&self, v: Value) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            *self.checkpoint.lock().unwrap() = v;
            Ok(())
        })
    }
    fn submitting(&self, _: String, _: String) -> BoxFuture<'_, Result<()>> {
        Box::pin(async { Ok(()) })
    }
    fn observed(&self, _: String, _: Value) -> BoxFuture<'_, Result<()>> {
        Box::pin(async { panic!("Child upstream IDs must remain inside batch checkpoint") })
    }
    fn collect(&self, _: Vec<Output>) -> BoxFuture<'_, Result<()>> {
        Box::pin(async { panic!("Batch requires explicit output indices") })
    }
    fn collect_indexed(&self, values: Vec<(usize, Output)>) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            for (index, value) in values {
                if index == 3 && self.concat_fail.swap(false, Ordering::Relaxed) {
                    return Err(ApiError::new(
                        503,
                        "DISK_BUSY",
                        "fixture collection failure",
                    ));
                }
                self.outputs.lock().unwrap().insert(index, value);
            }
            Ok(())
        })
    }
    fn protect_input(&self, name: String, input: Output) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            let bytes = match input {
                Output::Bytes { bytes, .. } => bytes.as_ref().clone(),
                Output::File { path, .. } => tokio::fs::read(path).await?,
            };
            self.saved.lock().unwrap().insert(name, bytes);
            Ok(())
        })
    }
    fn restore_input(&self, name: String, path: PathBuf) -> BoxFuture<'_, Result<bool>> {
        Box::pin(async move {
            let bytes = self.saved.lock().unwrap().get(&name).cloned();
            if let Some(bytes) = bytes {
                tokio::fs::create_dir_all(path.parent().unwrap()).await?;
                tokio::fs::write(path, bytes).await?;
                Ok(true)
            } else {
                Ok(false)
            }
        })
    }
}
struct Mock {
    posts: AtomicUsize,
    graphs: Mutex<Vec<Value>>,
    hooks: Arc<Hooks>,
    unknown: bool,
    active: AtomicBool,
    missing: AtomicBool,
}
async fn prompt(State(mock): State<Arc<Mock>>, Json(body): Json<Value>) -> Json<Value> {
    let index = mock.posts.fetch_add(1, Ordering::SeqCst);
    let checkpoint = mock.hooks.checkpoint.lock().unwrap();
    assert!(
        checkpoint["shots"][index]["submissionIntentAt"].is_number(),
        "Intent must be durable before POST"
    );
    assert!(checkpoint["shots"][index]["gatewayJobId"].is_string());
    drop(checkpoint);
    mock.graphs.lock().unwrap().push(body["prompt"].clone());
    if mock.unknown {
        Json(json!({"fixture":"response lost after request accepted"}))
    } else {
        Json(json!({"prompt_id":format!("prompt-{index}")}))
    }
}
async fn history(State(mock): State<Arc<Mock>>, Path(id): Path<String>) -> Json<Value> {
    if mock.active.load(Ordering::Relaxed) || mock.missing.load(Ordering::Relaxed) {
        return Json(json!({}));
    }
    Json(
        json!({id:{"status":{"status_str":"success"},"outputs":{"11":{"videos":[{"filename":"aics_video_00001_.mp4","subfolder":"","type":"output"}]}}}}),
    )
}
#[derive(Default)]
struct FakeFfmpeg {
    calls: Mutex<Vec<Vec<String>>>,
    audio_failed: AtomicBool,
}
impl Transcoder for FakeFfmpeg {
    fn run(&self, args: Vec<String>, cancel: CancellationToken) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            assert!(!cancel.is_cancelled());
            self.calls.lock().unwrap().push(args.clone());
            if args.iter().any(|s| s == "aac") && !self.audio_failed.swap(true, Ordering::Relaxed) {
                return Err(ApiError::new(502, "FFMPEG_FAILED", "fixture missing audio"));
            }
            let target = args.last().unwrap();
            tokio::fs::write(
                target,
                if args.iter().any(|s| s == "-sseof") {
                    png()
                } else {
                    movie()
                },
            )
            .await?;
            Ok(())
        })
    }
}
struct Server(tokio::task::JoinHandle<()>);
impl Drop for Server {
    fn drop(&mut self) {
        self.0.abort();
    }
}
async fn fixture(
    unknown: bool,
) -> (
    tempfile::TempDir,
    Arc<Service>,
    Arc<Mock>,
    Arc<FakeFfmpeg>,
    Server,
    Config,
) {
    let temp = tempfile::tempdir().unwrap();
    let hooks = Arc::new(Hooks::default());
    let mock = Arc::new(Mock {
        posts: AtomicUsize::new(0),
        graphs: Mutex::new(Vec::new()),
        hooks,
        unknown,
        active: AtomicBool::new(false),
        missing: AtomicBool::new(false),
    });
    let app = Router::new()
        .route("/system_stats", get(|| async { Json(json!({})) }))
        .route(
            "/object_info/MiniMaxH3DualClockSamplerT8",
            get(|| async { Json(json!({"MiniMaxH3DualClockSamplerT8":{}})) }),
        )
        .route("/free", post(|| async { Json(json!({})) }))
        .route("/prompt", post(prompt))
        .route("/history/{id}", get(history))
        .route(
            "/queue",
            get(|State(mock):State<Arc<Mock>>| async move { Json(json!({"queue_running":if mock.active.load(Ordering::Relaxed){json!([[0,"known-upstream"]])}else{json!([])},"queue_pending":[]})) }),
        )
        .route("/view", get(|| async { movie() }))
        .with_state(mock.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let host = format!("http://{}", listener.local_addr().unwrap());
    let server = Server(tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap()
    }));
    let config = Config {
        sd_host: host.clone(),
        sd_auth: None,
        comfy_host: host,
        ai_workspace_root: temp.path().join("ai"),
        runtime_root: temp.path().join("runtime"),
    };
    for model in huiyu_runtime::video::catalog()["constants"]["MODEL_CATALOG"]
        .as_array()
        .unwrap()
    {
        for requirement in model["requirements"].as_array().unwrap() {
            let file = config
                .ai_workspace_root
                .join("ComfyUI/models")
                .join(requirement[0].as_str().unwrap())
                .join(requirement[1].as_str().unwrap());
            tokio::fs::create_dir_all(file.parent().unwrap())
                .await
                .unwrap();
            tokio::fs::write(file, []).await.unwrap();
        }
    }
    let runner = Arc::new(FakeFfmpeg::default());
    let service = Arc::new(
        Service::with_transcoder(
            config.clone(),
            LocalUpstream::new(),
            CancellationToken::new(),
            runner.clone(),
        )
        .unwrap(),
    );
    (temp, service, mock, runner, server, config)
}
async fn wait(service: &Service, id: &str, status: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let v = service.get_batch(id, "local").await.unwrap();
            if v["status"] == status {
                return v;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn protected_sequential_shots_skip_reference_tail_and_concat_retries_only_collection() {
    let (_temp, service, mock, runner, _server, config) = fixture(false).await;
    let image = service
        .upload(
            STANDARD.encode(png()),
            "local".into(),
            false,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let reference = service
        .upload(
            STANDARD.encode(png()),
            "local".into(),
            true,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let raw = json!({"modelId":"minimax-h3","aspectRatio":"landscape","linkLastFrame":true,"shots":[{"prompt":"A quiet room.","seed":1,"image":image},{"prompt":"A calm forest.","seed":2},{"prompt":"A sunlit garden.","seed":3,"references":[reference]}]});
    let prepared = service
        .prepare_batch(raw, true, CancellationToken::new())
        .await
        .unwrap();
    tokio::fs::remove_file(config.ai_workspace_root.join("ComfyUI/input").join(&image))
        .await
        .unwrap();
    let result = service
        .clone()
        .submit_batch(prepared, "local".into(), Some(mock.hooks.clone()))
        .await
        .unwrap();
    let id = result["id"].as_str().unwrap();
    wait(&service, id, "done").await;
    assert_eq!(mock.posts.load(Ordering::SeqCst), 3);
    assert!(
        config
            .ai_workspace_root
            .join("ComfyUI/input")
            .join(&image)
            .exists()
    );
    assert_eq!(
        mock.hooks
            .outputs
            .lock()
            .unwrap()
            .keys()
            .copied()
            .collect::<Vec<_>>(),
        vec![0, 1, 2]
    );
    assert_eq!(
        runner.calls.lock().unwrap().len(),
        1,
        "Only first-to-second tail extraction; reference third shot preserves identity"
    );
    let checkpoint = service.batch_checkpoint(id, "local").await.unwrap();
    assert!(checkpoint["shots"][1]["input"]["image"].is_string());
    assert!(checkpoint["shots"][2]["input"]["image"].is_null());
    assert_eq!(checkpoint["gatewayJobId"], id);
    mock.hooks.concat_fail.store(true, Ordering::Relaxed);
    assert_eq!(
        service
            .clone()
            .batch_action(id, "local", "concat", CancellationToken::new())
            .await
            .unwrap_err()
            .code,
        "DISK_BUSY"
    );
    assert_eq!(
        service.batch_checkpoint(id, "local").await.unwrap()["concatStage"],
        "available"
    );
    let call_count = runner.calls.lock().unwrap().len();
    assert_eq!(call_count, 3);
    service
        .clone()
        .batch_action(id, "local", "concat", CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        runner.calls.lock().unwrap().len(),
        call_count,
        "Existing concat is collected again, never transcoded twice"
    );
    assert!(mock.hooks.outputs.lock().unwrap().contains_key(&3));
    assert_eq!(
        service.batch_result(id, "intruder").await.unwrap_err().code,
        "BATCH_NOT_FOUND"
    );
    assert_eq!(
        service.batch_result(id, "local").await.unwrap().len(),
        movie().len() as u64
    );
    service.close().await;
}
#[tokio::test]
async fn restart_with_unacknowledged_submission_never_replays_or_claims_cancelled() {
    let (_temp, service, mock, runner, _server, config) = fixture(true).await;
    let raw = json!({"modelId":"minimax-h3","aspectRatio":"landscape","linkLastFrame":false,"shots":[{"prompt":"A quiet room.","seed":1},{"prompt":"A calm forest.","seed":2}]});
    let prepared = service
        .prepare_batch(raw, true, CancellationToken::new())
        .await
        .unwrap();
    let input = prepared.input.clone();
    let created = service
        .clone()
        .submit_batch(prepared, "local".into(), Some(mock.hooks.clone()))
        .await
        .unwrap();
    let id = created["id"].as_str().unwrap();
    wait(&service, id, "paused").await;
    let checkpoint = service.batch_checkpoint(id, "local").await.unwrap();
    assert!(checkpoint["shots"][0]["submissionIntentAt"].is_number());
    assert!(checkpoint["shots"][0]["upstreamId"].is_null());
    assert_eq!(
        service
            .clone()
            .batch_action(id, "local", "continue", CancellationToken::new())
            .await
            .unwrap_err()
            .code,
        "BATCH_RECOVERY_REVIEW"
    );
    service.close().await;
    let restarted = Arc::new(
        Service::with_transcoder(
            config,
            LocalUpstream::new(),
            CancellationToken::new(),
            runner,
        )
        .unwrap(),
    );
    let task = json!({"taskId":"durable-fixture","principalId":"local","kind":"video-batch","provider":"comfy","input":input,"checkpoint":checkpoint,"resultRefs":[],"status":"running","cancelRequestedAt":1234});
    let (observation, saved) = restarted
        .recover_batch(&task, mock.hooks.clone(), &mut HashMap::new())
        .await
        .unwrap();
    assert!(observation.unknown);
    assert!(!observation.settled);
    assert_eq!(saved["shots"][1]["status"], "cancelled");
    assert_eq!(mock.posts.load(Ordering::SeqCst), 1);
    assert_eq!(
        restarted
            .clone()
            .batch_action(id, "local", "continue", CancellationToken::new())
            .await
            .unwrap_err()
            .code,
        "BATCH_RECOVERY_REVIEW"
    );
    assert_eq!(mock.posts.load(Ordering::SeqCst), 1);
    // A different restored batch has one known active request and one future
    // shot. Future work must not terminate observation of the known request.
    let mut known = task.clone();
    known["cancelRequestedAt"] = Value::Null;
    known["checkpoint"]["gatewayJobId"] = json!("known-batch");
    known["checkpoint"]["shots"][0]["upstreamId"] = json!("known-upstream");
    mock.active.store(true, Ordering::Relaxed);
    let (active, checkpoint) = restarted
        .recover_batch(&known, mock.hooks.clone(), &mut HashMap::new())
        .await
        .unwrap();
    assert!(!active.unknown);
    assert!(!active.settled);
    assert_eq!(checkpoint["shots"][1]["status"], "pending");
    assert_eq!(mock.posts.load(Ordering::SeqCst), 1);
    mock.active.store(false, Ordering::Relaxed);
    let (paused, checkpoint) = restarted
        .recover_batch(&known, mock.hooks.clone(), &mut HashMap::new())
        .await
        .unwrap();
    assert!(paused.unknown);
    assert!(!paused.settled);
    assert_eq!(
        paused.error_code.as_deref(),
        Some("BATCH_AWAITING_EXPLICIT_CONTINUE")
    );
    assert_eq!(checkpoint["shots"][0]["status"], "succeeded");
    assert_eq!(mock.posts.load(Ordering::SeqCst), 1);
    restarted
        .clone()
        .batch_action("known-batch", "local", "continue", CancellationToken::new())
        .await
        .unwrap();
    wait(&restarted, "known-batch", "paused").await;
    assert_eq!(
        mock.posts.load(Ordering::SeqCst),
        2,
        "Only the never-submitted second shot is explicitly continued"
    );
    let mut cancellation = task.clone();
    cancellation["checkpoint"]["gatewayJobId"] = json!("cancel-existing");
    cancellation["checkpoint"]["shots"][0]["upstreamId"] = json!("known-upstream");
    mock.missing.store(true, Ordering::Relaxed);
    let mut ack = HashMap::new();
    for _ in 0..2 {
        let (o, _) = restarted
            .recover_batch(&cancellation, mock.hooks.clone(), &mut ack)
            .await
            .unwrap();
        assert!(o.unknown);
        assert!(
            !o.settled,
            "Empty queue/history without a cancellation acknowledgment never proves completion"
        );
    }
    mock.missing.store(false, Ordering::Relaxed);
    let (o, _) = restarted
        .recover_batch(&cancellation, mock.hooks.clone(), &mut ack)
        .await
        .unwrap();
    assert!(o.settled);
    assert!(!o.unknown);
    assert_eq!(o.status, "cancelled");
    assert_eq!(mock.posts.load(Ordering::SeqCst), 2);
    restarted.close().await;
}
