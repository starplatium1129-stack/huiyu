use super::*;
use crate::{config::Config, host::HostAuthority};
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use http_body_util::BodyExt;
use serde_json::json;
use std::io::Cursor;
use tower::ServiceExt;
fn config(root: &std::path::Path) -> Config {
    Config {
        app_root: root.into(),
        runtime_root: root.join("runtime"),
        ai_workspace_root: root.into(),
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
    }
}
fn app(config: Config) -> Router {
    crate::router(AppState::new(
        Arc::new(config),
        Arc::new(HostAuthority::new(None, None, None)),
        CancellationToken::new(),
    ))
}
async fn call(
    app: &Router,
    method: &str,
    path: &str,
    body: Value,
    remote: bool,
) -> (StatusCode, Vec<u8>) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("host", "127.0.0.1:3210")
        .header("content-type", "application/json")
        .body(if body.is_null() {
            Body::empty()
        } else {
            Body::from(body.to_string())
        })
        .unwrap();
    request.extensions_mut().insert(ConnectInfo(
        if remote {
            "203.0.113.2:12"
        } else {
            "127.0.0.1:12"
        }
        .parse::<SocketAddr>()
        .unwrap(),
    ));
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    (
        status,
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec(),
    )
}
fn fixture() -> (tempfile::TempDir, Config, String) {
    let dir = tempfile::tempdir().unwrap();
    let config = config(dir.path());
    std::fs::create_dir_all(dir.path().join("data")).unwrap();
    std::fs::write(
        dir.path().join("data/characters.json"),
        br#"[{"id":"nene"}]"#,
    )
    .unwrap();
    std::fs::create_dir_all(dir.path().join("data/catalog")).unwrap();
    std::fs::write(
        dir.path().join("data/catalog/manifest.json"),
        json!({"version":1,"files":["nene.json"]}).to_string(),
    )
    .unwrap();
    std::fs::write(dir.path().join("data/catalog/nene.json"),json!({"kind":"character","id":"nene","revision":1,"sortOrder":0,"createdAt":null,"updatedAt":null,"data":{"id":"nene","profile":{"id":"nene"}}}).to_string()).unwrap();
    let image = image::RgbaImage::from_fn(600, 900, |x, y| {
        if x < 200 && y < 200 {
            image::Rgba([0, 0, 0, 0])
        } else {
            image::Rgba([210, 80, 30, 255])
        }
    });
    let mut out = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image)
        .write_to(&mut out, image::ImageFormat::Png)
        .unwrap();
    (
        dir,
        config,
        format!(
            "data:image/png;base64,{}",
            STANDARD.encode(out.into_inner())
        ),
    )
}
#[tokio::test]
async fn upload_derivatives_restart_conflict_reset_and_local_authority() {
    let (_dir, config, image) = fixture();
    let router = app(config.clone());
    let (status, bytes) = call(
        &router,
        "GET",
        "/api/maintenance/character-art",
        Value::Null,
        false,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        serde_json::from_slice::<Value>(&bytes).unwrap()["version"],
        "0"
    );
    let body = json!({"baseVersion":"0","id":"nene","image":image});
    let (status, bytes) = call(
        &router,
        "POST",
        "/api/maintenance/character-art",
        body.clone(),
        false,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&bytes)
    );
    let saved: Value = serde_json::from_slice(&bytes).unwrap();
    let entry = &saved["entries"]["nene"];
    assert_eq!(entry["width"], 600);
    assert_eq!(entry["height"], 900);
    assert_eq!(entry["hasTransparency"], true);
    let (_, portrait) = call(
        &router,
        "GET",
        entry["portraitUrl"].as_str().unwrap(),
        Value::Null,
        false,
    )
    .await;
    assert_eq!(derive::hash(&portrait), entry["sourceSha256"]);
    let (_, thumb) = call(
        &router,
        "GET",
        entry["thumbnailUrl"].as_str().unwrap(),
        Value::Null,
        false,
    )
    .await;
    let thumb = image::load_from_memory(&thumb).unwrap().to_rgba8();
    assert!(thumb.width() <= 560);
    assert_eq!(thumb.get_pixel(0, 0)[3], 0);
    let (_, cloud) = call(
        &router,
        "GET",
        entry["particleUrl"].as_str().unwrap(),
        Value::Null,
        false,
    )
    .await;
    let cloud: Value = serde_json::from_slice(&cloud).unwrap();
    assert_eq!(cloud["sourceSha256"], entry["revision"]);
    assert!(cloud["grid"]["cells"].as_str().unwrap().contains('.'));
    assert!(cloud["palette"].as_array().unwrap().len() <= 32);
    assert_eq!(
        cloud["grid"]["cells"].as_str().unwrap().len() as u64,
        cloud["grid"]["w"].as_u64().unwrap() * cloud["grid"]["h"].as_u64().unwrap()
    );
    for (method, path, payload) in [
        ("GET", "/api/maintenance/character-art", Value::Null),
        ("POST", "/api/maintenance/character-art", body.clone()),
        ("GET", entry["portraitUrl"].as_str().unwrap(), Value::Null),
    ] {
        assert_eq!(
            call(&router, method, path, payload, true).await.0,
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        call(
            &router,
            "POST",
            "/api/maintenance/character-art",
            body,
            false
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let restarted = app(config.clone());
    let (_, bytes) = call(
        &restarted,
        "GET",
        "/api/maintenance/character-art",
        Value::Null,
        false,
    )
    .await;
    assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), saved);
    let (status, bytes) = call(
        &restarted,
        "POST",
        "/api/maintenance/character-art",
        json!({"baseVersion":saved["version"],"id":"nene","reset":true}),
        false,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let reset: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(reset["entries"], json!({}));
    assert_ne!(reset["version"], saved["version"]);
    assert_eq!(
        call(
            &restarted,
            "GET",
            entry["portraitUrl"].as_str().unwrap(),
            Value::Null,
            false
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        std::fs::read(config.app_root.join("data/characters.json")).unwrap(),
        br#"[{"id":"nene"}]"#
    );
}
#[tokio::test]
async fn invalid_inputs_and_corrupt_manifest_never_overwrite() {
    let (_dir, config, image) = fixture();
    let router = app(config.clone());
    for body in [
        json!({"baseVersion":"0","id":"unknown","image":image}),
        json!({"baseVersion":"0","id":"../nene","image":image}),
        json!({"baseVersion":"0","id":"nene","image":"data:image/png;base64,eA=="}),
    ] {
        assert_eq!(
            call(
                &router,
                "POST",
                "/api/maintenance/character-art",
                body,
                false
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    let root = config.runtime_root.join("character-art");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("manifest.json"), b"broken").unwrap();
    assert_eq!(
        call(
            &router,
            "GET",
            "/api/maintenance/character-art",
            Value::Null,
            false
        )
        .await
        .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        call(
            &router,
            "POST",
            "/api/maintenance/character-art",
            json!({"baseVersion":"0","id":"nene","reset":true}),
            false
        )
        .await
        .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        std::fs::read(root.join("manifest.json")).unwrap(),
        b"broken"
    );
}
#[test]
fn rejects_oversize_dimensions_and_cancelled_processing() {
    let image = image::DynamicImage::new_rgba8(8193, 1);
    let mut out = Cursor::new(Vec::new());
    image.write_to(&mut out, image::ImageFormat::Png).unwrap();
    let data = format!(
        "data:image/png;base64,{}",
        STANDARD.encode(out.into_inner())
    );
    assert!(derive::build("nene", &data, &CancellationToken::new(), Instant::now()).is_err());
    let (_dir, config, data) = fixture();
    let cancel = CancellationToken::new();
    cancel.cancel();
    let error = store::save(
        &config,
        &json!({"id":"nene","baseVersion":"0","image":data}),
        &cancel,
    )
    .unwrap_err();
    assert_eq!(error.code, "ABORT_ERR");
    assert!(
        !config
            .runtime_root
            .join("character-art/manifest.json")
            .exists()
    );
    assert!(store::lock(&config.runtime_root.join("character-art")).is_ok());
}
#[test]
fn os_lock_releases_and_orphan_staging_does_not_block_retry() {
    let (_dir, config, image) = fixture();
    let root = config.runtime_root.join("character-art");
    std::fs::create_dir_all(root.join("nene/.staging-interrupted")).unwrap();
    std::fs::write(
        root.join("nene/.staging-interrupted/portrait.png"),
        b"partial",
    )
    .unwrap();
    let held = store::lock(&root).unwrap();
    assert_eq!(store::lock(&root).unwrap_err().code, "CHARACTER_ART_BUSY");
    drop(held);
    assert!(root.join("write.lock").exists());
    let saved = store::save(
        &config,
        &json!({"id":"nene","baseVersion":"0","image":image}),
        &CancellationToken::new(),
    )
    .unwrap();
    let entry = &saved["entries"]["nene"];
    assert!(
        store::asset(
            &root,
            "nene",
            entry["revision"].as_str().unwrap(),
            "portrait.png"
        )
        .is_ok()
    );
    let reset = store::save(
        &config,
        &json!({"id":"nene","baseVersion":saved["version"],"reset":true}),
        &CancellationToken::new(),
    )
    .unwrap();
    let reuploaded = store::save(
        &config,
        &json!({"id":"nene","baseVersion":reset["version"],"image":image}),
        &CancellationToken::new(),
    )
    .unwrap();
    assert_eq!(reuploaded["entries"]["nene"], saved["entries"]["nene"]);
    let mut blank = Cursor::new(Vec::new());
    image::DynamicImage::new_rgba8(100, 150)
        .write_to(&mut blank, image::ImageFormat::Png)
        .unwrap();
    let error=store::save(&config,&json!({"id":"nene","baseVersion":reuploaded["version"],"image":format!("data:image/png;base64,{}",STANDARD.encode(blank.into_inner()))}),&CancellationToken::new()).unwrap_err();
    assert_eq!(error.message, "图片没有可生成粒子的可见内容");
    assert_eq!(store::read(&root).unwrap(), reuploaded);
}
#[test]
fn jpeg_orientation_and_particle_grid_minimum_are_normalized() {
    let pixels = image::RgbImage::from_pixel(12, 24, image::Rgb([180, 70, 20]));
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new(&mut bytes)
        .encode_image(&image::DynamicImage::ImageRgb8(pixels))
        .unwrap();
    // APP1 Exif, little-endian TIFF, Orientation=6 (rotate 90 degrees clockwise).
    let exif: &[u8] = b"Exif\0\0II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0\x06\0\0\0\0\0\0\0";
    let mut oriented = bytes[..2].to_vec();
    oriented.extend_from_slice(&[0xff, 0xe1]);
    oriented.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
    oriented.extend_from_slice(exif);
    oriented.extend_from_slice(&bytes[2..]);
    let art = derive::build(
        "nene",
        &format!("data:image/jpeg;base64,{}", STANDARD.encode(oriented)),
        &CancellationToken::new(),
        Instant::now(),
    )
    .unwrap();
    assert_eq!((art.width, art.height), (24, 12));
    let portrait = image::load_from_memory(&art.portrait).unwrap();
    assert_eq!((portrait.width(), portrait.height()), (24, 12));
    for (width, height) in [(4, 4), (5, 2000)] {
        let mut bytes = Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(width, height)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        assert!(
            derive::build(
                "nene",
                &format!(
                    "data:image/png;base64,{}",
                    STANDARD.encode(bytes.into_inner())
                ),
                &CancellationToken::new(),
                Instant::now()
            )
            .is_err()
        );
    }
}
