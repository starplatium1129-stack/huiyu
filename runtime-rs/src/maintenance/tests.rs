use super::*;
use crate::host::HostAuthority;
use axum::{body::Body, http::Request, routing::get};
use http_body_util::BodyExt;
use std::{convert::Infallible, path::Path, process::Command};
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;

fn write(path: &Path, value: &Value) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
}
fn fixture() -> (
    tempfile::TempDir,
    Options,
    Arc<MaintenanceService>,
    AppState,
) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("app");
    std::fs::create_dir_all(&root).unwrap();
    for name in context::VERSIONED_FILES {
        write(&root.join("data").join(name), &json!([]));
    }
    let scene = json!({"id":"sc001","char":"nene","category":"Core","title":"neutral fixture","prompt":"neutral fixture","negative":"","rating":"All","mature":false});
    write(
        &root.join("data/scenes/manifest.json"),
        &json!({"files":[{"file":"nene-core.json","character":"nene"}],"batchSize":50}),
    );
    write(&root.join("data/scenes/nene-core.json"), &json!([scene]));
    let blueprint = json!({"id":"bp_fixture","characterId":"alpha","outfitId":"coat","title":"neutral blueprint","promptTokens":["book"],"negativeTokens":[],"promptProse":"A book on a desk."});
    write(
        &root.join("data/scene-blueprints.json"),
        &json!({"version":2,"blueprints":[blueprint]}),
    );
    write(
        &root.join("data/blueprints/manifest.json"),
        &json!({"version":1,"files":[{"file":"fixture.json","franchise":"Fixture","count":1}]}),
    );
    write(
        &root.join("data/blueprints/fixture.json"),
        &json!({"version":2,"franchise":"Fixture","blueprints":[blueprint]}),
    );
    write(
        &root.join("data/popular/manifest.json"),
        &json!({"version":1,"files":[{"file":"fixture.json","franchise":"Fixture","count":1}]}),
    );
    write(
        &root.join("data/popular/fixture.json"),
        &json!({"franchise":"Fixture","characters":[{"id":"alpha","franchise":"Fixture","outfits":[{"id":"coat"}]}]}),
    );
    write(
        &root.join("data/prompt-pinned-scenes.json"),
        &json!({"scenes":{"sc001":{"fixture":true}}}),
    );
    write(
        &root.join("data/retired-scenes.json"),
        &json!({"records":[{"id":"sc007"}]}),
    );
    write(
        &root.join("data/curation.json"),
        &json!({"curatedSceneIds":["sc001"],"personaCoreSceneIds":["sc001"]}),
    );
    std::fs::create_dir_all(root.join("src/stores")).unwrap();
    std::fs::write(
        root.join("src/stores/sceneStore.ts"),
        b"// neutral fixture\n",
    )
    .unwrap();
    let config = Arc::new(Config {
        app_root: root.clone(),
        runtime_root: directory.path().join("runtime"),
        ai_workspace_root: directory.path().join("AI"),
        sd_host: "http://127.0.0.1:1".into(),
        sd_auth: None,
        comfy_host: "http://127.0.0.1:1".into(),
        bind: "127.0.0.1:3210".parse().unwrap(),
        token: String::new(),
        desktop_secret: None,
        source_profile_id: None,
        workspace_pointer: None,
        workspace_candidate: None,
        config_root: None,
        gateway_origin: "http://127.0.0.1:3210".into(),
        workspace_root: None,
        workspace_id: None,
        create_workspace: false,
    });
    let options = Options {
        root,
        runtime: config.runtime_root.clone(),
        showcase: None,
    };
    let service = Arc::new(MaintenanceService {
        options: options.clone(),
        packaged: false,
        cache: Mutex::new(None),
        hero: Mutex::new(None),
        write_slots: Arc::new(tokio::sync::Semaphore::new(8)),
        write_lock: Arc::new(tokio::sync::Mutex::new(())),
    });
    let app = AppState::new(
        config,
        Arc::new(HostAuthority::new(None, None, None)),
        CancellationToken::new(),
    );
    (directory, options, service, app)
}
async fn call(app: &Router, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    request.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:12345".parse::<std::net::SocketAddr>().unwrap(),
    ));
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}
fn node_oracle(options: &Options) -> Value {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    // Development-only oracle invokes the original compiled metadata readers.
    // Every read root is this disposable fixture; no Node fallback ships in runtime.
    let script = "const p=require('node:path'); const io=require(p.join(process.argv[1],'scripts/lib/maintenance-recovery-fs.js')); const lease=require(p.join(process.argv[1],'scripts/lib/maintenance-lease.js')); const state=require(p.join(process.argv[1],'routes/maintenance-scene-state.js')); const options={rootDir:process.argv[2],runtimeRoot:process.argv[3]}; console.log(JSON.stringify({identity:io.context(options).root,version:state.sceneContentVersion(options.rootDir),lease:lease.inspectMaintenanceLease(options)}));";
    let mut command = Command::new("node");
    command
        .arg("-e")
        .arg(script)
        .arg(repo)
        .arg(&options.root)
        .arg(&options.runtime);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "Node fixture oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[tokio::test]
async fn scene_preview_preserves_readonly_baseline_ids_pins_and_content_contract_boundary() {
    let (_directory, options, service, state) = fixture();
    let app = router(service).with_state(state);
    let (status, snapshot) = call(&app, "GET", "/api/maintenance/scenes-state", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(snapshot["nextSceneId"], "sc008");
    assert_eq!(snapshot["version"], node_oracle(&options)["version"]);
    let mut changed = snapshot["snapshot"]["scenes"][0].clone();
    changed["title"] = json!("changed title");
    let body = json!({"baseVersion":snapshot["version"],"changeSet":{"version":1,"scenes":{"upsert":[changed],"remove":[]}}});
    let (status, preview) = call(
        &app,
        "POST",
        "/api/maintenance/scenes/preview",
        body.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(preview["updated"], json!(["sc001"]));
    assert_eq!(preview["writesEnabled"], true);
    let mut pinned = body.clone();
    pinned["changeSet"]["scenes"]["upsert"][0]["prompt"] = json!("refused change");
    assert_eq!(
        call(&app, "POST", "/api/maintenance/scenes/preview", pinned)
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let mut blueprint = body.clone();
    blueprint["changeSet"]["blueprints"] = json!({"upsert":[],"remove":[]});
    assert_eq!(
        call(&app, "POST", "/api/maintenance/scenes/preview", blueprint)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        call(&app, "POST", "/api/maintenance/scenes/changes", body)
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert!(!options.runtime.exists());
    assert!(!options.root.join("runtime").exists());
    assert_eq!(
        fs::json(&options.root.join("data/scenes/nene-core.json")).unwrap()[0]["title"],
        "neutral fixture"
    );
}

#[test]
fn transactions_interoperate_with_node_lease_identity_and_restore_only_declared_bytes() {
    let (_directory, options, _service, _state) = fixture();
    let old = options.root.join("data/tags.json");
    let created = options.root.join("data/scenes/new.1.json");
    let unrelated = options.root.join("data/scenes/unrelated.json");
    let before = std::fs::read(&old).unwrap();
    let token = journal::read_token(&options).unwrap();
    let mut transaction = transaction::Transaction::acquire(&options).unwrap();
    let oracle = node_oracle(&options);
    assert_eq!(
        oracle["identity"],
        fs::directory_identity(&options.root).unwrap()
    );
    assert_eq!(oracle["lease"]["status"], "active");
    let other = Options {
        runtime: options.runtime.with_file_name("other-runtime"),
        ..options.clone()
    };
    assert!(transaction::Transaction::acquire(&other).is_err());
    assert!(!other.runtime.exists());
    transaction
        .prepare(&[old.clone(), created.clone()], "fixture")
        .unwrap();
    transaction.write(&old, b"[\"temporary\"]").unwrap();
    transaction.write(&created, b"[]").unwrap();
    std::fs::write(&unrelated, b"[]").unwrap();
    assert!(
        transaction
            .write(&options.root.join("data/prompt-pinned-scenes.json"), b"{}")
            .is_err()
    );
    transaction.rollback().unwrap();
    assert_eq!(std::fs::read(old).unwrap(), before);
    assert!(!created.exists());
    assert!(unrelated.exists());
    assert_eq!(journal::inspect(&options)["status"], "free");
    assert!(journal::assert_token(&options, &token).is_err());
}

#[test]
fn signed_recovery_rejects_stale_plans_restores_snapshots_and_keeps_pre_recovery_backup() {
    let (_directory, options, _service, _state) = fixture();
    let file = options.root.join("data/tags.json");
    let before = std::fs::read(&file).unwrap();
    let mut transaction = transaction::Transaction::acquire(&options).unwrap();
    transaction
        .prepare(std::slice::from_ref(&file), "interrupted")
        .unwrap();
    transaction.write(&file, b"[\"partial\"]").unwrap();
    drop(transaction);
    let ctx = context::Context::new(&options).unwrap();
    let mut lease = journal::read(&ctx).unwrap().unwrap().value;
    let dead = 2_147_483_000_u64;
    assert_eq!(identity::process(dead), "dead");
    lease["pid"] = json!(dead);
    journal::write(&ctx, lease).unwrap();
    assert_eq!(node_oracle(&options)["lease"]["status"], "stale");
    let plan = recovery::preview(&options, None).unwrap();
    assert_eq!(plan["executable"], true);
    let mut tampered = plan.clone();
    tampered["action"] = json!("release-unstarted");
    assert!(recovery::apply(&options, tampered).is_err());
    std::fs::write(&file, b"[\"later change\"]").unwrap();
    assert!(recovery::apply(&options, plan).is_err());
    let plan = recovery::preview(&options, None).unwrap();
    let result = recovery::apply(&options, plan).unwrap();
    assert_eq!(result["ok"], true);
    assert!(result["undoBackup"].is_string());
    assert_eq!(std::fs::read(file).unwrap(), before);
    assert_eq!(journal::inspect(&options)["status"], "free");
}

#[tokio::test]
async fn read_barrier_never_releases_bytes_after_transaction_epoch_changed() {
    let (_directory, options, service, state) = fixture();
    let captured = options.clone();
    let app = Router::new()
        .route(
            "/data/fixture.json",
            get(move || {
                let options = captured.clone();
                async move {
                    let source = futures_util::stream::once(async move {
                        let mut transaction = transaction::Transaction::acquire(&options).unwrap();
                        transaction.rollback().unwrap();
                        Ok::<_, Infallible>(Bytes::from_static(b"{\"old\":true}"))
                    });
                    Body::from_stream(source)
                }
            }),
        )
        .layer(axum::middleware::from_fn_with_state(service, read_barrier))
        .with_state(state);
    let (status, body) = call(&app, "GET", "/data/fixture.json", Value::Null).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["code"], "MAINTENANCE_CONFLICT");
    assert!(body.get("old").is_none());
}
