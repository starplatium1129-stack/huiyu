//! Real gateway handlers plus a CPU-only upstream process; no GPU/model execution.
use super::*;
use axum::{Router, body::Body, extract::ConnectInfo, http::Request};
use base64::{Engine, engine::general_purpose::STANDARD};
use http_body_util::BodyExt;
use image::ImageEncoder;
use tower::ServiceExt;

async fn request(app: &Router, method: &str, path: &str, body: Value) -> (u16, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("host", "127.0.0.1:3210")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    req.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:49301".parse::<std::net::SocketAddr>().unwrap(),
    ));
    let response = app.clone().oneshot(req).await.unwrap();
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

fn application(control: Arc<ControlService>) -> (Router, Arc<crate::images::Service>) {
    let shutdown = CancellationToken::new();
    let images = Arc::new(
        crate::images::Service::new(
            crate::images::Config {
                sd_host: control.config.sd_host.clone(),
                sd_auth: None,
                comfy_host: control.config.comfy_host.clone(),
                ai_workspace_root: control.config.ai_workspace_root.clone(),
                runtime_root: control.config.runtime_root.clone(),
            },
            LocalUpstream::new(),
            shutdown.clone(),
        )
        .unwrap(),
    );
    let mut state = crate::AppState::new(
        control.config.clone(),
        Arc::new(crate::host::HostAuthority::new(None, None, None)),
        shutdown,
    );
    state.images = Some(images.clone());
    state.control = Some(control);
    (crate::router(state), images)
}

fn upstream(control: &ControlService, bytes: &[u8]) {
    let script = r#"
import base64, http.server, json, pathlib, sys
args = sys.argv
root = pathlib.Path(args[args.index('--input-directory') + 1])
pathlib.Path('fixture-starts.log').open('a').write(str(root) + '\n')
records = {}
class Handler(http.server.BaseHTTPRequestHandler):
    def send(self, value, status=200):
        self.send_response(status); self.end_headers(); self.wfile.write(json.dumps(value).encode())
    def do_GET(self):
        if self.path.startswith('/view'):
            self.send_response(200); self.send_header('Content-Type','image/png'); self.end_headers()
            self.wfile.write(base64.b64decode('FIXTURE_PNG')); return
        if self.path.startswith('/history/'):
            key = self.path.rsplit('/', 1)[-1]
            self.send({key:{'status':{'status_str':'success'},'outputs':{'10':{'images':[{'filename':records[key]+'_00001_.png','type':'output','subfolder':''}]}}}}); return
        self.send({'system':{},'devices':[],'queue_running':[],'queue_pending':[]})
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))) or b'{}')
        if self.path != '/prompt': self.send({}); return
        graph = body['prompt']
        pathlib.Path('fixture-prompts.log').open('a').write('prompt\n')
        for node in graph.values():
            if node['class_type'] == 'LoadImage': assert (root / node['inputs']['image']).is_file()
        pathlib.Path('fixture-workflow.json').write_text(json.dumps(graph))
        failed = pathlib.Path('fixture-rejected-once')
        if not failed.exists(): failed.touch(); self.send({'error':'intentional CPU fixture rejection'},400); return
        key = 'p' + str(len(records)+1)
        records[key] = graph['10']['inputs']['filename_prefix']
        self.send({'prompt_id':key})
http.server.HTTPServer(('127.0.0.1',int(args[args.index('--port')+1])),Handler).serve_forever()
"#;
    std::fs::write(
        control.comfy_root().join("main.py"),
        script.replace("FIXTURE_PNG", &STANDARD.encode(bytes)),
    )
    .unwrap();
}

async fn completed(app: &Router, job: &Value) -> Value {
    let path = format!("/api/anima/jobs/{}", job["id"].as_str().unwrap());
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let (status, value) = request(app, "GET", &path, Value::Null).await;
            assert_eq!(status, 200, "{value}");
            assert_ne!(value["job"]["status"], "failed", "{value}");
            if value["job"]["status"] == "succeeded" {
                return value["job"].clone();
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .unwrap()
}

async fn verify_result(app: &Router, job: &Value, expected: &[u8]) {
    let mut req = Request::builder()
        .uri(job["resultUrl"].as_str().unwrap())
        .header("host", "127.0.0.1:3210")
        .body(Body::empty())
        .unwrap();
    req.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:49301".parse::<std::net::SocketAddr>().unwrap(),
    ));
    let response = app.clone().oneshot(req).await.unwrap();
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(response.headers()["content-type"], "image/png");
    assert_eq!(
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .as_ref(),
        expected
    );
}

async fn operation_finished(app: &Router) {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let (_, operation) =
                request(app, "GET", "/api/local-setup/operation", Value::Null).await;
            if operation["operation"]["status"] != "running" {
                assert_eq!(operation["operation"]["status"], "completed", "{operation}");
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn gateway_upload_mask_lora_hires_retry_and_reopen_share_managed_installation() {
    let _upload_isolation = crate::images::UPLOAD_TEST_LOCK.lock().await;
    let (_temp, control) = fixture(0.0).await;
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(&[32, 64, 96], 1, 1, image::ExtendedColorType::Rgb8)
        .unwrap();
    upstream(&control, &png);
    let (app, images) = application(control.clone());
    let (status, stopped) =
        request(&app, "POST", "/api/service/comfy", json!({"action":"stop"})).await;
    assert_eq!(status, 200, "{stopped}");
    operation_finished(&app).await;
    let mut input = json!({"modelId":"anima-miaomiao-v1.6","prompt":"CPU contract scene",
        "width":1024,"height":1024,"seed":42,"character":"nene","loraId":"L_NENE_V21_ANIMA","loraStrength":0.8,
        "hiresFix":true,"hiresUpscaler":"Auto"});
    let (status, missing) = request(&app, "POST", "/api/anima/jobs", input.clone()).await;
    assert_eq!(status, 503, "{missing}");
    assert!(!control.comfy_root().join("fixture-starts.log").exists());
    for (kind, name) in [
        ("diffusion_models", "miaomiaoHarem_anima16.safetensors"),
        ("text_encoders", "qwen_3_06b_base.safetensors"),
        ("vae", "qwen_image_vae.safetensors"),
        ("loras", "ayachi_nene_v21_anima.safetensors"),
    ] {
        let directory = control
            .config
            .ai_workspace_root
            .join("ComfyUI/models")
            .join(kind);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join(name), b"CPU fixture, not a real model").unwrap();
    }
    let (status, upload) = request(
        &app,
        "POST",
        "/api/anima/images",
        json!({"image":STANDARD.encode(&png)}),
    )
    .await;
    assert_eq!(status, 200, "{upload}");
    input["initImage"] = upload["name"].clone();
    input["maskImage"] = upload["name"].clone();
    let (status, unavailable) = request(&app, "POST", "/api/anima/jobs", input.clone()).await;
    assert_eq!(status, 503, "{unavailable}");
    assert_eq!(unavailable["code"], "COMFY_UNAVAILABLE");
    assert!(!control.comfy_root().join("fixture-starts.log").exists());
    let (status, started) = request(
        &app,
        "POST",
        "/api/service/comfy",
        json!({"action":"start"}),
    )
    .await;
    assert_eq!(status, 200, "{started}");
    operation_finished(&app).await;
    let (status, failed) = request(&app, "POST", "/api/anima/jobs", input.clone()).await;
    assert_eq!(status, 502, "{failed}");
    let (status, retry) = request(&app, "POST", "/api/anima/jobs", input.clone()).await;
    assert_eq!(status, 202, "{retry}");
    let finished = completed(&app, &retry["job"]).await;
    verify_result(&app, &finished, &png).await;
    let workflow: Value = serde_json::from_slice(
        &std::fs::read(control.comfy_root().join("fixture-workflow.json")).unwrap(),
    )
    .unwrap();
    assert!(
        workflow
            .as_object()
            .unwrap()
            .values()
            .any(|node| node["inputs"]["lora_name"] == "ayachi_nene_v21_anima.safetensors")
    );
    assert!(
        workflow
            .as_object()
            .unwrap()
            .values()
            .any(|node| node["class_type"] == "LatentUpscaleBy")
    );
    images.close().await;
    control.close().await;
    let shutdown = CancellationToken::new();
    let reopened = ControlService::new(
        control.config.clone(),
        Arc::new(RemoteAccess::new(&control.config, shutdown.clone())),
        shutdown.clone(),
        Arc::new(crate::voice::VoiceService::new(&control.config, shutdown)),
    );
    let (app, images) = application(reopened.clone());
    let (status, ready) = request(&app, "GET", "/api/anima/status", Value::Null).await;
    assert_eq!(status, 200, "{ready}");
    assert_eq!(ready["managedStartAvailable"], true);
    assert!(reopened.comfy_process.lock().await.is_none());
    let (status, result) = request(&app, "POST", "/api/anima/jobs", input).await;
    assert_eq!(status, 202, "{result}");
    let finished = completed(&app, &result["job"]).await;
    verify_result(&app, &finished, &png).await;
    let (status, stopped) =
        request(&app, "POST", "/api/service/comfy", json!({"action":"stop"})).await;
    assert_eq!(status, 200, "{stopped}");
    operation_finished(&app).await;
    let (_, status) = request(&app, "GET", "/api/anima/status", Value::Null).await;
    assert_eq!(status["managedStartAvailable"], false);
    assert_eq!(
        std::fs::read_to_string(control.comfy_root().join("fixture-starts.log"))
            .unwrap()
            .lines()
            .count(),
        2
    );
    assert_eq!(
        std::fs::read_to_string(control.comfy_root().join("fixture-prompts.log"))
            .unwrap()
            .lines()
            .count(),
        3
    );
    images.close().await;
    reopened.close().await;
}

mod durable;
