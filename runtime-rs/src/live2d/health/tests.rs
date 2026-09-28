use super::*;
use crate::{AppState, config::Config, host::HostAuthority};
use axum::{body::Body, extract::ConnectInfo, http::Request};
use http_body_util::BodyExt;
use std::{fs, net::SocketAddr};
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;

fn fixture() -> (tempfile::TempDir, Arc<Live2dService>, AppState) {
    let root = tempfile::tempdir().unwrap();
    let shutdown = CancellationToken::new();
    let config = Config {
        app_root: root.path().into(),
        runtime_root: root.path().join("runtime"),
        ai_workspace_root: root.path().join("AI"),
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
    let service = Arc::new(Live2dService::with_roots(
        root.path().join("builtins"),
        root.path().join("imports"),
        shutdown.clone(),
    ));
    let mut state = AppState::new(
        Arc::new(config),
        Arc::new(HostAuthority::new(None, None, None)),
        shutdown,
    );
    state.live2d = Some(service.clone());
    (root, service, state)
}

async fn wait_refresh(service: &Live2dService) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while service.health.refreshing.load(Ordering::Acquire) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("health refresh should finish");
}

#[tokio::test]
async fn health_route_responds_while_all_live2d_workers_are_busy() {
    let (_root, service, state) = fixture();
    let _permits = service.workers.clone().acquire_many_owned(2).await.unwrap();
    let app = crate::router(state);
    for _ in 0..20 {
        let mut request = Request::builder()
            .uri("/api/health")
            .header("host", "127.0.0.1:3210")
            .body(Body::empty())
            .unwrap();
        request.extensions_mut().insert(ConnectInfo(
            "127.0.0.1:41000".parse::<SocketAddr>().unwrap(),
        ));
        let response =
            tokio::time::timeout(Duration::from_millis(200), app.clone().oneshot(request))
                .await
                .expect("health must not wait for a worker")
                .unwrap();
        assert_eq!(response.status(), 200);
        let value: Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(value["ok"], true);
        assert_eq!(value["capabilities"]["live2d"], false);
        assert_eq!(value["capabilityStatus"]["live2d"]["stale"], true);
    }
    assert_eq!(
        service.health.tasks.len(),
        1,
        "concurrent polls share one refresh"
    );
    tokio::time::timeout(Duration::from_millis(200), service.close())
        .await
        .unwrap();
    assert!(service.health.tasks.is_empty());
    assert!(!service.health.refreshing.load(Ordering::Acquire));
    service.health_status();
    assert!(
        service.health.tasks.is_empty(),
        "closed service must not restart work"
    );
}

#[tokio::test]
async fn cold_start_refreshes_and_invalidated_snapshot_retains_last_observation() {
    let (_root, service, _state) = fixture();
    let model = service.builtins.join("nene");
    fs::create_dir_all(&model).unwrap();
    fs::write(model.join("core.moc3"), b"MOC3").unwrap();
    fs::write(model.join("texture.png"), b"fixture").unwrap();
    fs::write(
        model.join("nene.model3.json"),
        json!({"Version":3,"FileReferences":{"Moc":"core.moc3","Textures":["texture.png"]}})
            .to_string(),
    )
    .unwrap();
    let initial = service.health_status();
    assert_eq!(initial["available"], false);
    assert_eq!(initial["checkedAt"], Value::Null);
    wait_refresh(&service).await;
    let ready = service.health_status();
    assert_eq!(ready["available"], true);
    assert_eq!(ready["stale"], false);
    assert!(ready["checkedAt"].as_u64().unwrap() > 0);
    fs::remove_file(model.join("texture.png")).unwrap();
    let permits = service.workers.clone().acquire_many_owned(2).await.unwrap();
    service.health.invalidate();
    let stale = service.health_status();
    assert_eq!(stale["available"], true);
    assert_eq!(stale["stale"], true);
    assert_eq!(stale["checkedAt"], ready["checkedAt"]);
    drop(permits);
    wait_refresh(&service).await;
    assert_eq!(service.health_status()["available"], false);
    // Age expiry also schedules a fresh check, without a mutation notification.
    service
        .health
        .observation
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .at = Instant::now() - MAX_AGE;
    assert_eq!(service.health_status()["stale"], true);
    wait_refresh(&service).await;
    assert_eq!(service.health_status()["stale"], false);
    service.close().await;
}

#[tokio::test(start_paused = true)]
async fn queued_refresh_times_out_and_releases_deduplication_guard() {
    let (_root, service, _state) = fixture();
    let _permits = service.workers.clone().acquire_many_owned(2).await.unwrap();
    service.health_status();
    tokio::task::yield_now().await;
    tokio::time::advance(REFRESH_TIMEOUT + Duration::from_secs(1)).await;
    tokio::task::yield_now().await;
    assert!(!service.health.refreshing.load(Ordering::Acquire));
    assert_eq!(service.health_status()["stale"], true);
    service.close().await;
}
