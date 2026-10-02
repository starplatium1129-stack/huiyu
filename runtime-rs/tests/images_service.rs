use axum::{
    Json, Router,
    extract::{Path, State},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::future::BoxFuture;
use huiyu_runtime::{
    error::Result,
    execution::{ExecutionHooks, Output},
    images::{Config, Limits, Service},
    upstream::LocalUpstream,
};
use image::ImageEncoder;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;

fn png(red: u8) -> Vec<u8> {
    let mut bytes = Vec::new();
    image::codecs::png::PngEncoder::new(&mut bytes)
        .write_image(&[red, 0, 0], 1, 1, image::ExtendedColorType::Rgb8)
        .unwrap();
    bytes
}
fn config(temp: &tempfile::TempDir, host: &str) -> Config {
    Config {
        sd_host: host.into(),
        sd_auth: None,
        comfy_host: host.into(),
        ai_workspace_root: temp.path().join("ai"),
        runtime_root: temp.path().join("runtime"),
    }
}
#[tokio::test]
async fn uploaded_originals_are_decoded_deduplicated_and_held_to_owner_quota() {
    let temp = tempfile::tempdir().unwrap();
    let service = Service::with_limits(
        config(&temp, "http://127.0.0.1:1"),
        LocalUpstream::new(),
        CancellationToken::new(),
        Limits {
            bytes: 1024 * 1024,
            files: 2,
        },
    )
    .unwrap();
    let invalid = service
        .upload(
            STANDARD.encode(b"\x89PNG\r\n\x1a\ncorrupt"),
            "alice".into(),
            CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(invalid.code, "INVALID_IMAGE");
    let bytes = png(128);
    let image = STANDARD.encode(&bytes);
    let root = temp.path().join("ai/ComfyUI/input");
    let alice = service
        .upload(image.clone(), "alice".into(), CancellationToken::new())
        .await
        .unwrap();
    // Read synchronously before any further await can give a queued write time to finish.
    let stored = std::fs::read(root.join(&alice)).unwrap();
    assert_eq!(stored, bytes);
    assert_eq!(Sha256::digest(&stored), Sha256::digest(&bytes));
    assert_eq!(
        alice,
        service
            .upload(image.clone(), "alice".into(), CancellationToken::new())
            .await
            .unwrap()
    );
    let bob = service
        .upload(image.clone(), "bob".into(), CancellationToken::new())
        .await
        .unwrap();
    assert_ne!(alice, bob);
    assert_eq!(
        service
            .upload(image, "carol".into(), CancellationToken::new())
            .await
            .unwrap_err()
            .code,
        "IMAGE_QUOTA"
    );
    assert_eq!(tokio::fs::read(root.join(alice)).await.unwrap(), png(128));
    assert!(!root.join(".aics-image-admission.lock").exists());
    service.close().await;
}

struct Mock {
    prefixes: Mutex<HashMap<String, String>>,
    workflows: Mutex<Vec<Value>>,
    events: Arc<Mutex<Vec<String>>>,
    next: AtomicUsize,
}
async fn prompt(State(state): State<Arc<Mock>>, Json(body): Json<Value>) -> Json<Value> {
    let id = format!("p{}", state.next.fetch_add(1, Ordering::Relaxed));
    let prefix = body["prompt"]["10"]["inputs"]["filename_prefix"]
        .as_str()
        .unwrap()
        .to_owned();
    state.prefixes.lock().unwrap().insert(id.clone(), prefix);
    state.workflows.lock().unwrap().push(body);
    state.events.lock().unwrap().push("POST".into());
    Json(json!({"prompt_id":id}))
}
async fn history(State(state): State<Arc<Mock>>, Path(id): Path<String>) -> Json<Value> {
    let prefix = state.prefixes.lock().unwrap().get(&id).unwrap().clone();
    Json(
        json!({id:{"status":{"status_str":"success"},"outputs":{"10":{"images":[{"filename":format!("{prefix}_00001_.png"),"type":"output","subfolder":""}]}}}}),
    )
}
async fn free(State(state): State<Arc<Mock>>) -> Json<Value> {
    state.events.lock().unwrap().push("free".into());
    Json(json!({}))
}
struct Server(tokio::task::JoinHandle<()>);
impl Drop for Server {
    fn drop(&mut self) {
        self.0.abort();
    }
}
struct Hooks {
    bytes: Mutex<HashMap<String, Vec<u8>>>,
    events: Arc<Mutex<Vec<String>>>,
    restored: AtomicUsize,
}
impl ExecutionHooks for Hooks {
    fn checkpoint(&self, _: Value) -> BoxFuture<'_, Result<()>> {
        Box::pin(async {
            self.events.lock().unwrap().push("checkpoint".into());
            Ok(())
        })
    }
    fn submitting(&self, _: String, _: String) -> BoxFuture<'_, Result<()>> {
        Box::pin(async {
            assert_eq!(self.bytes.lock().unwrap().len(), 2);
            self.events.lock().unwrap().push("intent".into());
            Ok(())
        })
    }
    fn observed(&self, _: String, _: Value) -> BoxFuture<'_, Result<()>> {
        Box::pin(async {
            self.events.lock().unwrap().push("observed".into());
            Ok(())
        })
    }
    fn collect(&self, _: Vec<Output>) -> BoxFuture<'_, Result<()>> {
        Box::pin(async {
            self.events.lock().unwrap().push("collected".into());
            Ok(())
        })
    }
    fn protect_input(&self, name: String, input: Output) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            let Output::Bytes { bytes, .. } = input else {
                panic!("prepare must hold immutable original bytes")
            };
            self.bytes
                .lock()
                .unwrap()
                .insert(name, bytes.as_ref().clone());
            self.events.lock().unwrap().push("protected".into());
            Ok(())
        })
    }
    fn restore_input(&self, name: String, path: PathBuf) -> BoxFuture<'_, Result<bool>> {
        Box::pin(async move {
            let bytes = self.bytes.lock().unwrap().get(&name).cloned().unwrap();
            tokio::fs::write(path, bytes).await?;
            self.restored.fetch_add(1, Ordering::Relaxed);
            Ok(true)
        })
    }
}
async fn wait(service: &Service, id: &str, family: &str) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let state = service.query(id, "owner", family).await.unwrap();
            if state.status == "succeeded" && state.settled {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn original_input_protection_precedes_post_and_family_outputs_remain_isolated() {
    let temp = tempfile::tempdir().unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let state = Arc::new(Mock {
        prefixes: Mutex::new(HashMap::new()),
        workflows: Mutex::new(Vec::new()),
        events: events.clone(),
        next: AtomicUsize::new(1),
    });
    let router = Router::new()
        .route("/system_stats", get(|| async { Json(json!({})) }))
        .route("/free", post(free))
        .route("/prompt", post(prompt))
        .route("/history/{id}", get(history))
        .route(
            "/view",
            get(|| async { ([(axum::http::header::CONTENT_TYPE, "image/png")], png(192)) }),
        )
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let host = format!("http://{}", listener.local_addr().unwrap());
    let _server = Server(tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    }));
    let cfg = config(&temp, &host);
    for (kind, name) in [
        ("diffusion_models", "miaomiaoHarem_anima16.safetensors"),
        ("diffusion_models", "krea2_turbo_fp8_scaled.safetensors"),
        ("text_encoders", "qwen_3_06b_base.safetensors"),
        (
            "text_encoders",
            "qwen3-vl-4b-heretic_fp8_e4m3fn.safetensors",
        ),
        ("vae", "qwen_image_vae.safetensors"),
        ("loras", "krea2_retroanime.safetensors"),
    ] {
        let dir = cfg.ai_workspace_root.join("ComfyUI/models").join(kind);
        tokio::fs::create_dir_all(&dir).await.unwrap();
        tokio::fs::write(dir.join(name), b"isolated fixture")
            .await
            .unwrap();
    }
    let service = Arc::new(
        Service::new(cfg.clone(), LocalUpstream::new(), CancellationToken::new()).unwrap(),
    );
    let original = service
        .upload(
            STANDARD.encode(png(10)),
            "local".into(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let mask = service
        .upload(
            STANDARD.encode(png(255)),
            "local".into(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let input = json!({"modelId":"anima-miaomiao-v1.6","prompt":"literal_trigger, a clear illustrated scene","negative":"source_negative_anchor","width":896,"height":1280,"seed":1234,"initImage":original,"maskImage":mask,"growMaskBy":0});
    let prepared = service
        .prepare(input, "anima", true, CancellationToken::new())
        .await
        .unwrap();
    tokio::fs::remove_file(cfg.ai_workspace_root.join("ComfyUI/input").join(&original))
        .await
        .unwrap();
    let hooks = Arc::new(Hooks {
        bytes: Mutex::new(HashMap::new()),
        events: events.clone(),
        restored: AtomicUsize::new(0),
    });
    let job = service
        .clone()
        .submit(prepared, "owner".into(), Some(hooks.clone()))
        .await
        .unwrap();
    let id = job["id"].as_str().unwrap();
    wait(&service, id, "anima").await;
    assert_eq!(hooks.restored.load(Ordering::Relaxed), 1);
    assert_eq!(
        tokio::fs::read(cfg.ai_workspace_root.join("ComfyUI/input").join(&original))
            .await
            .unwrap(),
        png(10)
    );
    let order = events.lock().unwrap().clone();
    assert!(order.iter().rposition(|e| e == "protected") < order.iter().position(|e| e == "POST"));
    assert!(order.iter().position(|e| e == "intent") < order.iter().position(|e| e == "POST"));
    assert!(service.get_job(id, "owner", "krea2").await.is_err());
    assert!(service.result(id, "other", "anima").await.is_err());
    assert!(
        service.get_job(id, "owner", "anima").await.unwrap()["resultUrl"]
            .as_str()
            .unwrap()
            .starts_with("/api/anima/")
    );
    let Output::File { path, .. } = service.result(id, "owner", "anima").await.unwrap() else {
        panic!("expected controlled file")
    };
    assert!(path.starts_with(cfg.runtime_root.join("outputs/anima")));
    let krea=service.prepare(json!({"modelId":"krea2-turbo-fp8","prompt":"A quiet illustrated scene.","width":1024,"height":1024,"seed":23,"styleLoraId":"retroanime"}),"krea2",true,CancellationToken::new()).await.unwrap();
    let krea = service
        .clone()
        .submit(krea, "owner".into(), None)
        .await
        .unwrap();
    let krea_id = krea["id"].as_str().unwrap();
    wait(&service, krea_id, "krea2").await;
    assert!(service.get_job(krea_id, "owner", "anima").await.is_err());
    assert!(
        service.get_job(krea_id, "owner", "krea2").await.unwrap()["resultUrl"]
            .as_str()
            .unwrap()
            .starts_with("/api/creative/")
    );
    assert_eq!(
        events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.as_str() == "free")
            .count(),
        2
    );
    service.close().await;
}
