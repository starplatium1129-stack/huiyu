use super::*;
use huiyu_runtime::{generation, images, upstream::LocalUpstream};

fn test_python() -> std::path::PathBuf {
    if let Some(path) = std::env::var_os("HUIYU_TEST_PYTHON") {
        return std::fs::canonicalize(path).expect("existing test Python must be available");
    }
    let launcher = if cfg!(windows) { "py" } else { "python3" };
    let output = std::process::Command::new(launcher)
        .args(["-c", "import sys; print(sys.executable)"])
        .output()
        .expect("protocol fixture needs an existing Python, not model dependencies");
    assert!(output.status.success(), "test Python probe failed");
    std::fs::canonicalize(String::from_utf8(output.stdout).unwrap().trim()).unwrap()
}

#[tokio::test]
async fn native_memory_result_is_served_by_legacy_image_route_with_owner_and_headers() {
    let (directory, mut state, _) = fixture().await;
    let root = directory.path();
    let models = root.join("simulation-models");
    let loras = root.join("simulation-loras");
    let worker = root.join("explicit-protocol-fixture.py");
    std::fs::create_dir_all(models.join("anima-aesthetic-v1.1")).unwrap();
    std::fs::create_dir_all(&loras).unwrap();
    std::fs::create_dir_all(&state.config.runtime_root).unwrap();
    std::fs::write(
        models.join("anima-aesthetic-v1.1/model_index.json"),
        r#"{"simulation":true}"#,
    )
    .unwrap();
    // Explicit neutral protocol output; no model or third-party ML imports.
    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    std::fs::write(
        &worker,
        format!("import base64,json,sys\nr=json.loads(sys.stdin.readline())\nopen(r['outputPath'],'wb').write(base64.b64decode('{PNG}'))\nprint(json.dumps({{'id':r['id'],'event':'result','outputPath':r['outputPath']}}),flush=True)\n"),
    )
    .unwrap();
    std::fs::write(
        state.config.runtime_root.join("config.json"),
        json!({"inference":{"engine":"native","python":test_python(),"worker":worker,
            "modelsRoot":models,"lorasRoot":loras}})
        .to_string(),
    )
    .unwrap();
    let images = Arc::new(
        images::Service::new(
            generation::Config {
                sd_host: state.config.sd_host.clone(),
                sd_auth: None,
                comfy_host: state.config.comfy_host.clone(),
                ai_workspace_root: state.config.ai_workspace_root.clone(),
                runtime_root: state.config.runtime_root.clone(),
            },
            LocalUpstream::new(),
            state.shutdown.clone(),
        )
        .unwrap(),
    );
    state.images = Some(images.clone());
    let app = huiyu_runtime::router(state.clone());
    let submitted = request(
        &app,
        "POST",
        "/api/anima/jobs",
        json!({"modelId":"anima-aesthetic-v1.1","prompt":"explicit protocol simulation; no model inference",
            "width":832,"height":1216,"steps":2,"cfg":4.5,"seed":42,"teaCache":false}).to_string(),
        &[],
    )
    .await;
    assert_eq!(submitted.status(), StatusCode::ACCEPTED);
    let submitted = json_body(submitted).await;
    let id = submitted["job"]["id"].as_str().unwrap();
    let job = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let job = images.get_job(id, "local", "anima").await.unwrap();
            if matches!(
                job["status"].as_str(),
                Some("succeeded" | "failed" | "cancelled")
            ) {
                break job;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(job["status"], "succeeded", "{job}");
    assert_eq!(job["resultAvailable"], true);
    assert_eq!(
        images
            .result(id, "foreign-owner", "anima")
            .await
            .unwrap_err()
            .code,
        "JOB_NOT_FOUND"
    );
    let expected = STANDARD.decode(PNG).unwrap();
    let response = request(
        &app,
        "GET",
        job["resultUrl"].as_str().unwrap(),
        String::new(),
        &[],
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "image/png");
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert_eq!(response.headers()["x-content-type-options"], "nosniff");
    assert_eq!(
        response.headers()["content-length"],
        expected.len().to_string()
    );
    assert_eq!(
        response.into_body().collect().await.unwrap().to_bytes(),
        expected
    );
    let missing = request(
        &app,
        "GET",
        "/api/anima/jobs/missing/result",
        String::new(),
        &[],
    )
    .await;
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    assert_eq!(json_body(missing).await["code"], "JOB_NOT_FOUND");
    images.close().await;
    state.shutdown.cancel();
    state.host.storage().unwrap().close().await.unwrap();
}
