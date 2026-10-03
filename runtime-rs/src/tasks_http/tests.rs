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
