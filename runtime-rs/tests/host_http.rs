use axum::{
    Router,
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode},
    response::Response,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, Mac};
use http_body_util::BodyExt;
use huiyu_runtime::{AppState, config::Config, host::HostAuthority, storage::Storage};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    net::SocketAddr,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;

const ORIGIN: &str = "http://127.0.0.1:3210";
const SECRET: &str = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";

async fn fixture() -> (TempDir, AppState, Router) {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(
        directory.path().join("workspace"),
        uuid::Uuid::new_v4().to_string(),
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
        desktop_secret: Some(SECRET.into()),
        source_profile_id: Some("host-test".into()),
        workspace_pointer: None,
        gateway_origin: ORIGIN.into(),
        workspace_root: None,
        workspace_id: None,
        create_workspace: false,
        config_root: None,
        workspace_candidate: None,
    };
    let state = AppState::new(
        Arc::new(config),
        Arc::new(HostAuthority::new(Some(storage), None, None)),
        CancellationToken::new(),
    );
    let router = huiyu_runtime::router(state.clone());
    (directory, state, router)
}

async fn request(
    app: &Router,
    method: &str,
    uri: &str,
    body: String,
    headers: &[(&str, &str)],
) -> Response {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header("host", "127.0.0.1:3210")
        .header("content-type", "application/json");
    for (key, value) in headers {
        request = request.header(*key, *value);
    }
    let mut request = request.body(Body::from(body)).unwrap();
    request.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:49201".parse::<SocketAddr>().unwrap(),
    ));
    app.clone().oneshot(request).await.unwrap()
}
async fn json_body(response: Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

#[tokio::test]
async fn bundled_native_origin_receives_cors_without_granting_proxy_authority() {
    let (_directory, mut state, _) = fixture().await;
    state.host = Arc::new(HostAuthority::new(
        state.host.storage(),
        Some(json!({"bundledUi":true})),
        None,
    ));
    let app = huiyu_runtime::router(state.clone());
    let preflight = request(
        &app,
        "OPTIONS",
        "/api/chat",
        String::new(),
        &[
            ("origin", "https://huiyu.localhost"),
            ("access-control-request-method", "POST"),
        ],
    )
    .await;
    assert_eq!(preflight.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        preflight.headers()["access-control-allow-origin"],
        "https://huiyu.localhost"
    );
    let resource = request(
        &app,
        "GET",
        "/api/health",
        String::new(),
        &[
            ("referer", "http://tauri.localhost/"),
            ("sec-fetch-site", "cross-site"),
        ],
    )
    .await;
    assert_eq!(resource.status(), StatusCode::OK);
    assert_eq!(
        resource.headers()["access-control-allow-origin"],
        "http://tauri.localhost"
    );
    let proxied = request(
        &app,
        "OPTIONS",
        "/api/chat",
        String::new(),
        &[
            ("origin", "https://huiyu.localhost"),
            ("x-forwarded-for", "127.0.0.1"),
        ],
    )
    .await;
    assert_eq!(proxied.status(), StatusCode::FORBIDDEN);
    assert!(
        !proxied
            .headers()
            .contains_key("access-control-allow-origin")
    );
    state.host.storage().unwrap().close().await.unwrap();
}
async fn signed(app: &Router, action: &str, window: &str) -> Response {
    signed_with(app, action, window, json!({})).await
}
async fn signed_with(app: &Router, action: &str, window: &str, extra: Value) -> Response {
    let mut payload = json!({"action": action, "windowId": window, "sourceProfileId": "host-test", "origin": ORIGIN,
        "timestamp": SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64,
        "nonce": format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())});
    payload
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    let payload = payload.to_string();
    let mut mac = Hmac::<Sha256>::new_from_slice(SECRET.as_bytes()).unwrap();
    mac.update(b"aics-desktop-host:v1\n");
    mac.update(payload.as_bytes());
    request(
        app,
        "POST",
        "/api/desktop-host",
        payload,
        &[(
            "x-aics-host-proof",
            &hex::encode(mac.finalize().into_bytes()),
        )],
    )
    .await
}

#[tokio::test]
async fn session_requires_bound_browser_origin_scope_and_current_epoch() {
    let (_directory, state, app) = fixture().await;
    let grant = json_body(signed(&app, "session", "companion").await).await;
    let token = grant["workspace"]["token"].as_str().unwrap();
    let valid = [("origin", ORIGIN), ("x-aics-workspace-session", token)];
    for path in [
        "/api/workspace/artwork-search-index",
        "/api/workspace/artwork-recent-index",
        "/api/workspace/artworks/missing",
    ] {
        assert_eq!(
            request(&app, "GET", path, String::new(), &valid)
                .await
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            request(&app, "GET", path, String::new(), &[("origin", ORIGIN)])
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        request(&app, "GET", "/api/workspace/status", String::new(), &valid)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        request(
            &app,
            "GET",
            "/api/workspace/status",
            String::new(),
            &[("origin", ORIGIN)]
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &app,
            "GET",
            "/api/workspace/status",
            String::new(),
            &[("x-aics-workspace-session", token)]
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &app,
            "GET",
            "/api/workspace/status",
            String::new(),
            &[
                ("origin", "http://localhost:3210"),
                ("x-aics-workspace-session", token)
            ]
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    let referer = [
        ("sec-fetch-site", "same-origin"),
        ("referer", "http://127.0.0.1:3210/atelier"),
        ("x-aics-workspace-session", token),
    ];
    assert_eq!(
        request(
            &app,
            "GET",
            "/api/workspace/status",
            String::new(),
            &referer
        )
        .await
        .status(),
        StatusCode::OK
    );
    let input = json!({"workspaceId": state.host.storage().unwrap().workspace_id(), "protocolVersion": 1, "operationId": "backup"}).to_string();
    assert_eq!(
        request(&app, "POST", "/api/workspace/backups", input, &valid)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        signed(&app, "shutdown", "companion").await.status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        signed(&app, "prepare-candidate", "atelier").await.status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        signed(&app, "shutdown", "atelier").await.status(),
        StatusCode::OK
    );
    assert!(state.shutdown.is_cancelled());
    assert_eq!(
        signed(&app, "shutdown", "atelier").await.status(),
        StatusCode::OK
    );
    assert_eq!(
        request(&app, "GET", "/api/workspace/status", String::new(), &valid)
            .await
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
}

#[tokio::test]
async fn media_capability_grants_one_object_and_streams_only_requested_bytes() {
    let (_directory, state, app) = fixture().await;
    let storage = state.host.storage().unwrap();
    let bytes = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=").unwrap();
    let meta = json!({"alias": "fixture-image", "sha256": hex::encode(Sha256::digest(&bytes)), "bytes": bytes.len(), "mime": "image/png"});
    storage
        .request(
            json!({"kind": "prepareMedia", "operationId": "fixture", "media": meta}),
            "desktop:host-test",
        )
        .await
        .unwrap();
    storage.request(json!({"kind": "uploadMediaChunk", "operationId": "fixture", "offset": 0, "data": STANDARD.encode(&bytes)}), "desktop:host-test").await.unwrap();
    storage
        .request(
            json!({"kind": "commitMedia", "operationId": "fixture"}),
            "desktop:host-test",
        )
        .await
        .unwrap();
    let session = json_body(signed(&app, "session", "atelier").await).await;
    let session = session["workspace"]["token"].as_str().unwrap();
    let capability = request(
        &app,
        "POST",
        "/api/workspace/media-capabilities",
        json!({"alias": "fixture-image"}).to_string(),
        &[("origin", ORIGIN), ("x-aics-workspace-session", session)],
    )
    .await;
    assert_eq!(capability.status(), StatusCode::OK);
    let capability = json_body(capability).await;
    let url = capability["url"].as_str().unwrap();
    let headers = [("origin", ORIGIN), ("range", "bytes=2-9")];
    let ranged = request(&app, "GET", url, String::new(), &headers).await;
    assert_eq!(ranged.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(ranged.headers()["content-length"], "8");
    assert_eq!(
        ranged
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .as_ref(),
        &bytes[2..10]
    );
    let head = request(&app, "HEAD", url, String::new(), &headers).await;
    assert_eq!(head.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(head.headers()["content-length"], "8");
    assert!(
        head.into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .is_empty()
    );
    assert_eq!(
        request(
            &app,
            "GET",
            url,
            String::new(),
            &[("sec-fetch-site", "same-origin")]
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        request(&app, "GET", url, String::new(), &[]).await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &app,
            "GET",
            &url.replace("fixture-image", "other-image"),
            String::new(),
            &headers
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &app,
            "GET",
            url,
            String::new(),
            &[("origin", "http://localhost:3210")]
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &app,
            "GET",
            url,
            String::new(),
            &[("origin", ORIGIN), ("range", "bytes=0-1,3-4")]
        )
        .await
        .status(),
        StatusCode::RANGE_NOT_SATISFIABLE
    );
    storage.close().await.unwrap();
}

#[tokio::test]
async fn verified_candidate_is_backed_up_activated_and_reopened_with_new_epoch() {
    let (directory, mut state, _) = fixture().await;
    state.host.storage().unwrap().close().await.unwrap();
    let root = directory.path().join("desktop");
    Arc::make_mut(&mut state.config).config_root = Some(root.clone());
    state.host = Arc::new(HostAuthority::new(None, None, None));
    let app = huiyu_runtime::router(state.clone());
    assert!(json_body(signed(&app, "session", "atelier").await).await["workspace"].is_null());
    let prepared = signed(&app, "prepare-candidate", "atelier").await;
    assert_eq!(prepared.status(), StatusCode::OK);
    let prepared = json_body(prepared).await;
    let session = &prepared["workspace"];
    let workspace_id = session["workspaceId"].as_str().unwrap();
    let token = session["token"].as_str().unwrap();
    assert_eq!(session["domains"], json!([]));
    assert_eq!(session["generation"], 0);
    let candidate: Value =
        serde_json::from_slice(&std::fs::read(root.join("workspace-candidate.json")).unwrap())
            .unwrap();
    assert_eq!(candidate["workspaceId"], workspace_id);
    let mut envelope = json!({"format": "huiyu-migration", "version": 1, "migrationId": "empty-migration",
        "source": {"sourceProfileId": "host-test", "origin": ORIGIN, "windowIds": ["atelier"]}, "createdAt": 1,
        "records": [], "media": [], "blockers": [], "credentials": {"references": [], "verified": true}});
    envelope["fingerprint"] = json!(huiyu_runtime::storage::fingerprint(&envelope));
    let headers = [("origin", ORIGIN), ("x-aics-workspace-session", token)];
    let begin = json!({"operationId": "begin", "workspaceId": workspace_id, "protocolVersion": 1, "envelope": envelope}).to_string();
    assert_eq!(
        request(&app, "POST", "/api/workspace/migrations", begin, &headers)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        signed_with(
            &app,
            "activate",
            "atelier",
            json!({"migrationId": "empty-migration"})
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    let verify =
        json!({"operationId": "verify", "workspaceId": workspace_id, "protocolVersion": 1})
            .to_string();
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/workspace/migrations/empty-migration/verify",
            verify,
            &headers
        )
        .await
        .status(),
        StatusCode::OK
    );
    let activated = signed_with(
        &app,
        "activate",
        "atelier",
        json!({"migrationId": "empty-migration"}),
    )
    .await;
    let status = activated.status();
    let activated = json_body(activated).await;
    assert_eq!(status, StatusCode::OK, "{activated}");
    assert_eq!(activated["workspace"]["generation"], 1);
    assert_eq!(activated["workspace"]["bundledUi"], false);
    assert_eq!(
        activated["workspace"]["domains"],
        json!(["artwork", "settings", "chat", "draft"])
    );
    let enabled = signed(&app, "enable-bundled", "atelier").await;
    let status = enabled.status();
    let enabled = json_body(enabled).await;
    assert_eq!(status, StatusCode::OK, "{enabled}");
    assert_eq!(enabled["workspace"]["generation"], 2);
    assert_eq!(enabled["workspace"]["bundledUi"], true);
    let active: Value =
        serde_json::from_slice(&std::fs::read(root.join("workspace-active.json")).unwrap())
            .unwrap();
    assert!(active["backupId"].is_string());
    assert!(active["restoreCandidateId"].is_string());
    let old_epoch = state.host.storage().unwrap().runtime_epoch().to_owned();
    assert_eq!(
        signed(&app, "shutdown", "atelier").await.status(),
        StatusCode::OK
    );
    let storage = Storage::open(
        root.join("workspaces").join(workspace_id),
        workspace_id.into(),
        false,
    )
    .await
    .unwrap();
    state.host = Arc::new(HostAuthority::new(
        Some(storage.clone()),
        Some(active),
        None,
    ));
    state.shutdown = CancellationToken::new();
    let reopened = huiyu_runtime::router(state.clone());
    assert_eq!(
        request(
            &reopened,
            "GET",
            "/api/workspace/status",
            String::new(),
            &headers
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    let resumed = json_body(signed(&reopened, "session", "atelier").await).await;
    assert_ne!(resumed["workspace"]["runtimeEpoch"], old_epoch);
    assert_eq!(resumed["workspace"]["bundledUi"], true);
    storage.close().await.unwrap();
}
