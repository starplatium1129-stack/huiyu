use super::*;
use axum::http::Request as HttpRequest;
use base64::{Engine, engine::general_purpose::STANDARD};
use http_body_util::BodyExt;
use std::fs;
use tower::ServiceExt;

fn profile() -> Value {
    json!({"schemaVersion":1,"profileId":"profile-fixture","avatarId":"avatar-fixture","profileVersion":"1.0.0","backendCompatibility":["browser"],"parameterBindings":{},"verification":{"status":"verified"}})
}
fn fixture() -> (tempfile::TempDir, Arc<Live2dService>, Router) {
    fixture_with_library(None)
}
fn fixture_with_library(
    library: Option<PathBuf>,
) -> (tempfile::TempDir, Arc<Live2dService>, Router) {
    let directory = tempfile::tempdir().unwrap();
    let canonical_root = fs::canonicalize(directory.path()).unwrap();
    manifest::no_links(&canonical_root).unwrap();
    let shutdown = CancellationToken::new();
    let mut service = Live2dService::with_roots(
        canonical_root.join("builtins"),
        canonical_root.join("imports"),
        shutdown.clone(),
    );
    if let Some(library) = library {
        service.native_library = library;
    }
    let service = Arc::new(service);
    let config = Config {
        app_root: directory.path().into(),
        runtime_root: directory.path().join("runtime"),
        ai_workspace_root: directory.path().join("AI"),
        sd_host: "http://127.0.0.1:7860".into(),
        sd_auth: None,
        comfy_host: "http://127.0.0.1:8188".into(),
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
    };
    let state = AppState::new(
        Arc::new(config),
        Arc::new(crate::host::HostAuthority::new(None, None, None)),
        shutdown,
    );
    (
        directory,
        service.clone(),
        router(service).with_state(state),
    )
}
async fn call(
    app: &Router,
    method: &str,
    url: &str,
    bytes: Vec<u8>,
    content_type: &str,
) -> Response {
    let mut request = HttpRequest::builder()
        .method(method)
        .uri(url)
        .header("host", "127.0.0.1:3210")
        .header("origin", "http://127.0.0.1:3210")
        .header("content-type", content_type)
        .body(Body::from(bytes))
        .unwrap();
    request.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:41000".parse::<SocketAddr>().unwrap(),
    ));
    app.clone().oneshot(request).await.unwrap()
}
async fn json_response(response: Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}
fn multipart() -> Vec<u8> {
    let metadata = json!({"id":"fixture","name":"测试角色","persona":"用于隔离测试","author":"fixture","terms":"test only","entryPath":"nested/main.model3.json","profile":profile()});
    let paths = json!([
        "nested/main.model3.json",
        "nested/model.moc3",
        "nested/texture.png"
    ]);
    let model = json!({"Version":3,"Controllers":{"unknown":"must not be published"},"Options":{},"FileReferences":{"Moc":"model.moc3","Textures":["texture.png"]}});
    let mut bytes = Vec::new();
    for (name, value) in [("metadata", metadata), ("paths", paths)] {
        bytes.extend_from_slice(format!("--fixture-boundary\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes());
    }
    let image = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=").unwrap();
    for (index, file) in [
        serde_json::to_vec(&model).unwrap(),
        b"MOC3\0\0\0\0".to_vec(),
        image,
    ]
    .iter()
    .enumerate()
    {
        bytes.extend_from_slice(format!("--fixture-boundary\r\nContent-Disposition: form-data; name=\"files\"; filename=\"{index}\"\r\nContent-Type: application/octet-stream\r\n\r\n").as_bytes());
        bytes.extend_from_slice(file);
        bytes.extend_from_slice(b"\r\n");
    }
    bytes.extend_from_slice(b"--fixture-boundary--\r\n");
    bytes
}

#[tokio::test]
#[ignore = "Requires explicit neutral fixture directory and selected libvips DLL"]
async fn native_texture_http_preserves_manifest_etag_and_scale() {
    let library = PathBuf::from(std::env::var_os("AICS_TEST_VIPS_DLL").expect("explicit DLL"));
    let pixels =
        PathBuf::from(std::env::var_os("AICS_TEST_INTERROGATE_PIXELS").expect("neutral fixtures"));
    let (_root, service, app) = fixture_with_library(Some(library));
    let model = service.builtins.join("nene");
    fs::create_dir_all(&model).unwrap();
    fs::write(
        model.join("nene.model3.json"),
        serde_json::to_vec(
            &json!({"Version":3,"FileReferences":{"Moc":"model.moc3","Textures":["texture.png"]}}),
        )
        .unwrap(),
    )
    .unwrap();
    fs::write(model.join("model.moc3"), b"MOC3").unwrap();
    fs::copy(pixels.join("transparent.png"), model.join("texture.png")).unwrap();
    let document = json_response(
        call(
            &app,
            "GET",
            "/api/live2d-model/nene/standard",
            vec![],
            "application/json",
        )
        .await,
    )
    .await;
    assert_eq!(
        document["FileReferences"]["Moc"],
        "/assets/live2d-current/nene/model.moc3"
    );
    assert_eq!(
        document["FileReferences"]["Textures"][0],
        "/api/live2d-texture/nene/standard/0.webp"
    );
    let endpoint = "/api/live2d-texture/nene/standard/0.webp";
    let (first, second) = tokio::join!(
        call(&app, "GET", endpoint, vec![], "application/json"),
        call(&app, "GET", endpoint, vec![], "application/json")
    );
    assert_eq!(first.status(), StatusCode::OK);
    let etag = first.headers()["etag"].clone();
    assert_eq!(second.headers()["etag"], etag);
    let bytes = first.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(
        &bytes[..],
        fs::read(pixels.join("transparent.standard")).unwrap()
    );
    assert_eq!(
        second.into_body().collect().await.unwrap().to_bytes(),
        bytes
    );
    let mut request = HttpRequest::builder()
        .uri(endpoint)
        .header("host", "localhost:3210")
        .header("if-none-match", etag)
        .body(Body::empty())
        .unwrap();
    request.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:41000".parse::<SocketAddr>().unwrap(),
    ));
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
    assert!(
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .is_empty()
    );
    service.shutdown.cancel();
}

#[tokio::test]
async fn multipart_import_publishes_only_bound_assets_and_profile_changes_require_cas() {
    let (_directory, service, app) = fixture();
    assert!(!service.local.exists());
    assert!(!service.available().await);
    assert!(!service.local.exists());
    let created = call(
        &app,
        "POST",
        "/api/live2d-import",
        multipart(),
        "multipart/form-data; boundary=fixture-boundary",
    )
    .await;
    let status = created.status();
    let created = json_response(created).await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    assert_eq!(
        created["profile"]["verification"]["status"],
        "needs-confirmation"
    );
    let companions = json_response(
        call(
            &app,
            "GET",
            "/api/live2d-companions",
            vec![],
            "application/json",
        )
        .await,
    )
    .await;
    assert_eq!(companions.as_array().unwrap().len(), 1);
    for path in [
        "/api/live2d-status",
        "/api/live2d-companions",
        "/api/live2d-local/fixture/companion.json",
    ] {
        let mut request = HttpRequest::builder()
            .uri(path)
            .header("host", "localhost:3210")
            .header("x-forwarded-for", "198.51.100.5")
            .body(Body::empty())
            .unwrap();
        request.extensions_mut().insert(ConnectInfo(
            "127.0.0.1:41000".parse::<SocketAddr>().unwrap(),
        ));
        let response = app.clone().oneshot(request).await.unwrap();
        if path.contains("local/") {
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
            continue;
        }
        assert_eq!(response.status(), StatusCode::OK);
        let projection = json_response(response).await;
        if path.ends_with("companions") {
            assert_eq!(projection, json!([]));
        } else {
            assert_eq!(projection["models"].as_object().unwrap().len(), 2);
            assert!(projection["models"].get("fixture").is_none());
            assert_eq!(projection["available"], false);
        }
    }
    assert!(service.available().await);
    let model_url = companions[0]["avatar"]["modelPath"].as_str().unwrap();
    let model = json_response(call(&app, "GET", model_url, vec![], "application/json").await).await;
    assert!(model.get("Controllers").is_none());
    assert!(model.get("Options").is_none());
    assert_eq!(
        model["FileReferences"]["Textures"],
        json!(["nested/texture.png"])
    );
    assert_eq!(
        call(
            &app,
            "GET",
            "/api/live2d-local/fixture/nested/main.model3.json",
            vec![],
            "application/json"
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &app,
            "GET",
            "/api/live2d-local/fixture/companion.json",
            vec![],
            "application/json"
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &app,
            "GET",
            "/api/live2d-model/fixture/compact",
            vec![],
            "application/json"
        )
        .await
        .status(),
        StatusCode::OK
    );
    let mut native = created.clone();
    native["profile"]["backendCompatibility"] = json!(["browser", "native"]);
    assert_eq!(
        call(
            &app,
            "PUT",
            "/api/live2d-import/fixture",
            serde_json::to_vec(&native).unwrap(),
            "application/json"
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    let mut updated = created.clone();
    updated["profile"]["layout"] = json!({"scale":1.2});
    let saved = call(
        &app,
        "PUT",
        "/api/live2d-import/fixture",
        serde_json::to_vec(&updated).unwrap(),
        "application/json",
    )
    .await;
    assert_eq!(saved.status(), StatusCode::OK);
    let saved = json_response(saved).await;
    assert_eq!(saved["canRollback"], true);
    assert_eq!(
        call(
            &app,
            "PUT",
            "/api/live2d-import/fixture",
            serde_json::to_vec(&updated).unwrap(),
            "application/json"
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    let restored = call(
        &app,
        "POST",
        "/api/live2d-import/fixture/rollback",
        serde_json::to_vec(&saved).unwrap(),
        "application/json",
    )
    .await;
    assert_eq!(restored.status(), StatusCode::OK);
    let restored = json_response(restored).await;
    assert!(restored["profile"].get("layout").is_none());
    fs::write(
        service.local.join("fixture/nested/model.moc3"),
        b"MOC3changed",
    )
    .unwrap();
    assert_eq!(
        call(
            &app,
            "DELETE",
            "/api/live2d-import/fixture",
            serde_json::to_vec(&restored).unwrap(),
            "application/json"
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    let current = json_response(
        call(
            &app,
            "GET",
            "/api/live2d-import/fixture",
            vec![],
            "application/json",
        )
        .await,
    )
    .await;
    assert_eq!(
        call(
            &app,
            "DELETE",
            "/api/live2d-import/fixture",
            serde_json::to_vec(&current).unwrap(),
            "application/json"
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        call(&app, "GET", model_url, vec![], "application/json")
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn legacy_cubism2_receipt_stays_browser_readable_and_traversal_never_becomes_a_model() {
    let (directory, service, app) = fixture();
    let root = service.local.join("legacy");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("core.moc"), b"legacy fixture").unwrap();
    fs::write(root.join("texture.png"), b"fixture resource").unwrap();
    fs::write(
        root.join("model.json"),
        serde_json::to_vec(&json!({"model":"core.moc","textures":["texture.png"]})).unwrap(),
    )
    .unwrap();
    let receipt = json!({"character":{"id":"legacy","personaPrompt":"test","defaultAvatarId":"avatar-fixture"},"avatar":{"id":"avatar-fixture","characterId":"legacy","profileId":"profile-fixture","modelPath":"/api/live2d-local/legacy/model.json"},"profile":profile(),"manifest":"model.json","files":["model.json","core.moc","texture.png"]});
    fs::write(
        root.join("companion.json"),
        serde_json::to_vec(&receipt).unwrap(),
    )
    .unwrap();
    service.catalog.clear();
    assert!(service.available().await);
    let response = call(
        &app,
        "GET",
        "/api/live2d-local/legacy/model.json",
        vec![],
        "application/json",
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json_response(response).await["model"], "core.moc");
    assert_eq!(
        call(
            &app,
            "GET",
            "/assets/live2d-current/legacy/model.json",
            vec![],
            "application/json"
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    fs::write(directory.path().join("escape.png"), b"private").unwrap();
    fs::write(
        root.join("model.json"),
        serde_json::to_vec(&json!({"model":"core.moc","textures":["../../escape.png"]})).unwrap(),
    )
    .unwrap();
    service.catalog.clear();
    assert!(!service.available().await);
    assert!(manifest::no_links(std::path::Path::new("relative-imports")).is_err());
    assert!(manifest::no_links(std::path::Path::new("C:relative-imports")).is_err());
    let link = fs::canonicalize(directory.path())
        .unwrap()
        .join("linked-import");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let status = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:AICS_TEST_LINK -Target $env:AICS_TEST_TARGET | Out-Null"])
            .env("AICS_TEST_LINK", &link)
            .env("AICS_TEST_TARGET", &root)
            .creation_flags(0x08000000)
            .status().unwrap();
        assert!(status.success());
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(&root, &link).unwrap();
    #[cfg(any(windows, unix))]
    assert!(manifest::no_links(&link.join("model.json")).is_err());
    assert_eq!(
        call(
            &app,
            "GET",
            "/api/live2d-local/legacy/model.json",
            vec![],
            "application/json"
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert!(manifest::relative("nested/CON.png").is_err());
    assert!(manifest::relative("../escape.png").is_err());
    assert!(
        manifest::references(
            &json!({"model":"core.moc","textures":["texture.png"],"expressions":[42]})
        )
        .is_err()
    );
}
