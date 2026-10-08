use super::*;
use crate::{config::Config, host::HostAuthority};
use axum::{body::Body, http::Request};
use base64::{Engine, engine::general_purpose::STANDARD};
use http_body_util::BodyExt;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;

const ORIGIN: &str = "http://127.0.0.1:3210";

async fn fixture() -> (tempfile::TempDir, AppState, Router, Session) {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(
        directory.path().join("workspace"),
        "task-http-fixture".into(),
        true,
    )
    .await
    .unwrap();
    let config = Config {
        app_root: directory.path().to_path_buf(),
        runtime_root: directory.path().join("runtime"),
        ai_workspace_root: directory.path().join("ai"),
        sd_host: "http://127.0.0.1:1".into(),
        sd_auth: None,
        comfy_host: "http://127.0.0.1:1".into(),
        bind: "127.0.0.1:3210".parse().unwrap(),
        token: String::new(),
        desktop_secret: None,
        source_profile_id: Some("fixture".into()),
        workspace_pointer: None,
        workspace_candidate: None,
        config_root: None,
        gateway_origin: ORIGIN.into(),
        workspace_root: None,
        workspace_id: None,
        create_workspace: false,
    };
    let host = Arc::new(HostAuthority::new(Some(storage.clone()), None, None));
    let session = host
        .issue(
            storage.workspace_id(),
            storage.runtime_epoch(),
            "alice",
            ORIGIN,
            false,
        )
        .unwrap();
    let state = AppState::new(Arc::new(config), host, CancellationToken::new());
    (
        directory,
        state.clone(),
        router().with_state(state),
        session,
    )
}

fn task(id: &str, principal: &str, settled: bool) -> Value {
    json!({"taskId":id,"workspaceId":"task-http-fixture","principalId":principal,"requestKey":format!("key/{id}"),
        "requestFingerprint":id,"kind":"generation","provider":"fixture","providerFingerprint":"fixture",
        "upstreamId":null,"status":if settled {"succeeded"} else {"running"},"recoveryState":"normal","revision":0,"runtimeEpoch":"previous-epoch",
        "createdAt":1,"updatedAt":1,"submissionIntentAt":1,"submissionObservedAt":1,"cancelRequestedAt":null,
        "upstreamSettled":settled,"executionDeadline":9999999999999_u64,"input":{},"inputMediaRefs":[],"resultState":"none","resultRefs":[],
        "deliveryState":"unseen","errorCode":if settled {Value::Null} else {json!("PRESERVED_DIAGNOSTIC")},"metadata":{},"checkpoint":null,"parentBatchId":null,"stepIndex":null})
}

async fn call(router: &Router, session: &Session, method: &str, uri: &str) -> Response {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header("host", "127.0.0.1:3210")
        .header("origin", ORIGIN)
        .header("x-aics-workspace-session", &session.token)
        .body(Body::empty())
        .unwrap();
    request.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:43210".parse::<SocketAddr>().unwrap(),
    ));
    router.clone().oneshot(request).await.unwrap()
}

async fn body(response: Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

#[tokio::test]
async fn task_reads_are_principal_scoped_and_never_claim_resumed_execution() {
    let (directory, mut state, router, alice) = fixture().await;
    let storage = state.host.storage().unwrap();
    for (id, principal, settled) in [
        ("a1", "alice", true),
        ("b1", "bob", true),
        ("a2", "alice", false),
    ] {
        storage
            .request(
                json!({"kind":"task.accept","record":task(id,principal,settled)}),
                principal,
            )
            .await
            .unwrap();
    }
    let before = storage
        .request(json!({"kind":"task.get","taskId":"a2"}), "alice")
        .await
        .unwrap();
    let response = call(&router, &alice, "GET", "/api/tasks/v1/").await;
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert_eq!(response.headers()["access-control-allow-origin"], ORIGIN);
    let listed = body(response).await;
    let tasks = listed["result"]["items"].as_array().unwrap();
    assert_eq!(tasks.len(), 2);
    let summary = body(
        call(
            &router,
            &alice,
            "GET",
            "/api/tasks/v1?summary=true&scope=overview&limit=1",
        )
        .await,
    )
    .await;
    assert_eq!(summary["result"]["items"][0]["taskId"], "a2");
    assert!(summary["result"]["items"][0].get("input").is_none());
    assert_eq!(summary["result"]["items"][0]["recoveryState"], "unknown");
    let next = format!(
        "/api/tasks/v1?summary=true&limit=1&before={}&throughRevision={}",
        summary["result"]["nextCursor"], summary["result"]["throughRevision"]
    );
    let history = body(call(&router, &alice, "GET", &next).await).await;
    assert_eq!(history["result"]["items"][0]["taskId"], "a1");
    assert_eq!(
        call(&router, &alice, "GET", "/api/tasks/v1?scope=invalid")
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(tasks[0]["taskId"], "a2");
    assert_eq!(tasks[1]["taskId"], "a1");
    assert_eq!(tasks[0]["status"], "running");
    assert_eq!(tasks[0]["recoveryState"], "unknown");
    assert_eq!(tasks[0]["errorCode"], "PRESERVED_DIAGNOSTIC");
    assert_eq!(tasks[0]["executionAvailable"], false);
    assert_eq!(listed["runtimeEpoch"], storage.runtime_epoch());
    assert_eq!(
        body(call(&router, &alice, "GET", "/api/tasks/v1/by-key/key%2Fa2").await).await["result"]["taskId"],
        "a2"
    );
    assert!(
        body(call(&router, &alice, "GET", "/api/tasks/v1/by-key/missing").await).await["result"]
            .is_null()
    );
    assert_eq!(
        call(&router, &alice, "GET", "/api/tasks/v1/b1")
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(&router, &alice, "DELETE", "/api/tasks/v1/a2")
            .await
            .status(),
        StatusCode::NOT_IMPLEMENTED
    );
    let foreign = state
        .host
        .issue(
            "another-workspace",
            storage.runtime_epoch(),
            "alice",
            ORIGIN,
            false,
        )
        .unwrap();
    assert_eq!(
        call(&router, &foreign, "GET", "/api/tasks/v1/a1")
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let after = storage
        .request(json!({"kind":"task.get","taskId":"a2"}), "alice")
        .await
        .unwrap();
    assert_eq!(before, after);

    let provider = Arc::new(
        crate::generation::GenerationService::new(
            crate::generation::Config {
                sd_host: state.config.sd_host.clone(),
                sd_auth: None,
                comfy_host: state.config.comfy_host.clone(),
                ai_workspace_root: state.config.ai_workspace_root.clone(),
                runtime_root: state.config.runtime_root.clone(),
            },
            crate::upstream::LocalUpstream::new(),
            state.shutdown.clone(),
        )
        .unwrap(),
    );
    let runtime = Arc::new(
        crate::task_runtime::TaskRuntime::new(provider, None, None, state.shutdown.clone())
            .unwrap(),
    );
    state.tasks = Some(runtime.clone());
    let router = super::router().with_state(state);
    // The old task's recovery cannot commit. Stable-key queries and a new
    // cancellation intent must still work without recovering that task first.
    let fault =
        rusqlite::Connection::open(directory.path().join("workspace/huiyu.sqlite3")).unwrap();
    fault
        .execute_batch(
            "CREATE TRIGGER fail_task_recovery BEFORE UPDATE ON tasks
             WHEN OLD.task_id='a2'
             BEGIN SELECT RAISE(ABORT, 'isolated recovery failure'); END;",
        )
        .unwrap();
    assert_eq!(
        body(call(&router, &alice, "GET", "/api/tasks/v1/by-key/key%2Fa2").await).await["result"]["taskId"],
        "a2"
    );
    let response = call(
        &router,
        &alice,
        "DELETE",
        "/api/tasks/v1/by-key/cancel-before-accept",
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(body(response).await["result"].is_null());
    let mut cancelled = task("cancelled", "alice", false);
    cancelled["requestKey"] = json!("cancel-before-accept");
    let accepted = storage
        .request(json!({"kind":"task.accept","record":cancelled}), "alice")
        .await
        .unwrap();
    assert_eq!(accepted["task"]["status"], "cancelled");
    assert!(accepted["task"]["cancelRequestedAt"].is_number());
    fault
        .execute_batch("DROP TRIGGER fail_task_recovery;")
        .unwrap();
    drop(fault);
    runtime.close().await;
    storage.close().await.unwrap();
}

#[tokio::test]
async fn task_results_require_owned_reference_and_verified_original_bytes() {
    let (_directory, state, router, alice) = fixture().await;
    let storage = state.host.storage().unwrap();
    storage
        .request(
            json!({"kind":"task.accept","record":task("output","alice",true)}),
            "alice",
        )
        .await
        .unwrap();
    let bytes = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=").unwrap();
    let hash = hex::encode(Sha256::digest(&bytes));
    let output = json!({"alias":"task-output-0","sha256":hash,"bytes":bytes.len(),"mime":"image/png","index":0});
    storage
        .request(
            json!({"kind":"task.result.prepare","taskId":"output","media":output}),
            "alice",
        )
        .await
        .unwrap();
    storage.request(json!({"kind":"task.result.chunk","taskId":"output","index":0,"offset":0,"data":STANDARD.encode(&bytes)}), "alice").await.unwrap();
    storage
        .request(
            json!({"kind":"task.result.commit","taskId":"output","index":0}),
            "alice",
        )
        .await
        .unwrap();
    let response = call(&router, &alice, "GET", "/api/tasks/v1/output/results/0").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "image/png");
    assert_eq!(
        response.headers()["content-length"],
        bytes.len().to_string()
    );
    let received = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(hex::encode(Sha256::digest(received)), hash);
    let bob = state
        .host
        .issue(
            storage.workspace_id(),
            storage.runtime_epoch(),
            "bob",
            ORIGIN,
            false,
        )
        .unwrap();
    assert_eq!(
        call(&router, &bob, "GET", "/api/tasks/v1/output/results/0")
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(&router, &alice, "GET", "/api/tasks/v1/output/results/1")
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    let media = storage.media("task-output-0").await.unwrap();
    std::fs::write(media.path, b"corrupted isolated fixture").unwrap();
    let response = call(&router, &alice, "GET", "/api/tasks/v1/output/results/0").await;
    assert!(!response.status().is_success());
    assert_eq!(body(response).await["code"], "TASK_RESULT_UNAVAILABLE");
    storage.close().await.unwrap();
}

// Held provider replies must not block the durable list or replay work.
#[tokio::test]
async fn task_list_starts_one_owned_recovery_and_converges_before_shutdown() {
    let (directory, mut state, _, alice) = fixture().await;
    let entered = Arc::new(tokio::sync::Notify::new());
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let histories = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let endpoint = {
        let entered = entered.clone();
        let gate = gate.clone();
        let histories = histories.clone();
        move || {
            let entered = entered.clone();
            let gate = gate.clone();
            let histories = histories.clone();
            async move {
                histories.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                entered.notify_one();
                gate.acquire().await.unwrap().forget();
                Json(json!({}))
            }
        }
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let host = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new()
                .route("/history/{id}", axum::routing::get(endpoint))
                .route(
                    "/queue",
                    axum::routing::get(|| async {
                        Json(json!({"queue_running":[[0,"task-0"]],"queue_pending":[]}))
                    }),
                ),
        )
        .await
        .unwrap();
    });
    let config = crate::generation::Config {
        sd_host: host.clone(),
        sd_auth: None,
        comfy_host: host.clone(),
        ai_workspace_root: directory.path().join("AI"),
        runtime_root: directory.path().join("runtime"),
    };
    std::fs::create_dir_all(config.ai_workspace_root.join("ComfyUI")).unwrap();
    let output = std::process::Command::new("node")
        .arg(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/task_recovery/legacy-provider.cjs"),
        )
        .arg(&config.ai_workspace_root)
        .arg(&host)
        .output()
        .unwrap();
    assert!(output.status.success());
    let fingerprint = String::from_utf8(output.stdout).unwrap();
    let runtime = Arc::new(
        crate::task_runtime::TaskRuntime::new(
            Arc::new(
                crate::generation::GenerationService::new(
                    config,
                    crate::upstream::LocalUpstream::new(),
                    state.shutdown.clone(),
                )
                .unwrap(),
            ),
            None,
            None,
            state.shutdown.clone(),
        )
        .unwrap(),
    );
    state.tasks = Some(runtime.clone());
    let storage = state.host.storage().unwrap();
    let mut old = task("task-0", "alice", false);
    old["provider"] = json!("comfy");
    old["providerFingerprint"] = json!(fingerprint);
    old["upstreamId"] = json!("task-0");
    old["errorCode"] = Value::Null;
    storage
        .request(json!({"kind":"task.accept","record":old}), "alice")
        .await
        .unwrap();
    let app = super::router().with_state(state.clone());
    // An explicit no-op observation owns the lock before the first list starts.
    let explicit_runtime = runtime.clone();
    let explicit_storage = storage.clone();
    let explicit = tokio::spawn(async move {
        explicit_runtime
            .reconcile(&explicit_storage, "alice", "task-0")
            .await
    });
    tokio::time::timeout(Duration::from_secs(2), entered.notified())
        .await
        .unwrap();
    let first = tokio::time::timeout(
        Duration::from_secs(2),
        call(&app, &alice, "GET", "/api/tasks/v1"),
    )
    .await
    .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let mut revision = 0;
    for _ in 0..3 {
        let response = tokio::time::timeout(
            Duration::from_secs(2),
            call(&app, &alice, "GET", "/api/tasks/v1"),
        )
        .await
        .unwrap();
        let page = body(response).await;
        revision = page["result"]["throughRevision"].as_i64().unwrap();
        assert_eq!(page["result"]["items"][0]["recoveryState"], "unknown");
    }
    assert_eq!(histories.load(std::sync::atomic::Ordering::SeqCst), 1);
    let mut post = Box::pin(call(&app, &alice, "POST", "/api/tasks/v1"));
    assert!(futures_util::poll!(&mut post).is_pending());
    for path in [
        "/api/tasks/v1/task-0",
        "/api/tasks/v1/by-key/key%2Ftask-0",
        "/api/tasks/v1/by-key/new",
    ] {
        let response =
            tokio::time::timeout(Duration::from_secs(2), call(&app, &alice, "GET", path))
                .await
                .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let value = body(response).await;
        if path.ends_with("/new") {
            assert!(value["result"].is_null());
        }
    }
    let error = storage
        .request(
            json!({"kind":"task.accept","record":task("new", "alice", false)}),
            "alice",
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "TASK_PROVIDER_BUSY");
    assert!(futures_util::poll!(&mut post).is_pending());
    drop(post);
    gate.add_permits(1);
    explicit.await.unwrap().unwrap();
    // Startup must not skip the held lock and complete at the old revision.
    tokio::time::timeout(Duration::from_secs(2), entered.notified())
        .await
        .unwrap();
    assert_eq!(histories.load(std::sync::atomic::Ordering::SeqCst), 2);
    let reconciling = crate::task_runtime::TaskRuntime::get(&storage, "alice", "task-0")
        .await
        .unwrap();
    assert!(reconciling.revision > revision);
    assert_eq!(
        reconciling.recovery_state,
        crate::task_contract::RecoveryState::Reconciling
    );
    gate.add_permits(1);
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let record = crate::task_runtime::TaskRuntime::get(&storage, "alice", "task-0")
                .await
                .unwrap();
            if record.revision > reconciling.revision
                && record.recovery_state == crate::task_contract::RecoveryState::Normal
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let response = call(
        &app,
        &alice,
        "GET",
        &format!("/api/tasks/v1?afterRevision={revision}"),
    )
    .await;
    let page = body(response).await;
    assert_eq!(page["result"]["items"][0]["recoveryState"], "normal");
    assert_ne!(page["result"]["items"][0]["executionAvailable"], false);
    assert!(runtime.owns(&storage, "task-0"));
    // The observer is now held at its next probe; shutdown must drain it.
    tokio::time::timeout(Duration::from_secs(2), entered.notified())
        .await
        .unwrap();
    assert_eq!(histories.load(std::sync::atomic::Ordering::SeqCst), 3);
    state.shutdown.cancel();
    tokio::time::timeout(Duration::from_secs(2), runtime.close())
        .await
        .unwrap();
    storage.close().await.unwrap();
    server.abort();
}
