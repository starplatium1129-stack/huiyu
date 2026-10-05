use super::*;
use std::time::Duration;

async fn until(mut ready: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(2), async {
        while !ready() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}
async fn response(
    fixture: Arc<Fixture>,
    index: usize,
    method: &str,
    etag: Option<String>,
) -> axum::response::Response {
    let mut request = Request::builder()
        .method(method)
        .uri(format!("/{}", fixture.entries[index].path))
        .header("host", "127.0.0.1:3210");
    if let Some(etag) = etag {
        request = request.header("if-none-match", etag);
    }
    let mut request = request.body(Body::empty()).unwrap();
    request.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:1234".parse::<std::net::SocketAddr>().unwrap(),
    ));
    fixture.app.clone().oneshot(request).await.unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_bodies_share_one_verified_group_and_hold_budget_through_last_frame() {
    let fixture = Arc::new(Fixture::new());
    let paths = fixture.paths();
    let watch = Watch::new(&paths);
    let total = fixture
        .entries
        .iter()
        .map(|e| e.bytes as usize)
        .sum::<usize>();
    let (pause, entered) = Pause::new(&paths[2]);
    let first = tokio::spawn(response(fixture.clone(), 2, "GET", None));
    entered.await.unwrap();
    let second = tokio::spawn(response(fixture.clone(), 2, "GET", None));
    let third = tokio::spawn(response(fixture.clone(), 1, "GET", None));
    until(|| fixture.service.group_reads.listeners() == 3).await;
    assert_eq!(fixture.service.group_reads.retained_bytes(), total);
    drop(pause);
    let first = first
        .await
        .unwrap()
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let second = second
        .await
        .unwrap()
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    let third = third
        .await
        .unwrap()
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes();
    assert_eq!(first.as_ref(), fixture.texture);
    assert_eq!(
        first.as_ptr(),
        second.as_ptr(),
        "Shared Bytes must not copy the texture Vec"
    );
    assert_eq!(third.as_ref(), std::fs::read(&paths[1]).unwrap());
    for (index, path) in paths.iter().enumerate() {
        let bytes = fixture.entries[index].bytes;
        assert_eq!(
            watch.take(path),
            Reads {
                passes: 1,
                bytes,
                collected: bytes
            }
        );
    }
    drop(first);
    drop(third);
    assert_eq!(fixture.service.group_reads.retained_bytes(), total);
    drop(second);
    until(|| fixture.service.group_reads.retained_bytes() == 0).await;
    let modified = std::fs::metadata(&paths[1]).unwrap().modified().unwrap();
    let mut bytes = std::fs::read(&paths[1]).unwrap();
    bytes[0] ^= 1;
    std::fs::write(&paths[1], bytes).unwrap();
    std::fs::File::options()
        .write(true)
        .open(&paths[1])
        .unwrap()
        .set_modified(modified)
        .unwrap();
    assert_eq!(
        fixture.request("GET", None, false).await.2.as_ref(),
        b"bundled"
    );
    fixture.service.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn abandoned_changed_and_failed_flights_cannot_publish_or_poison_later_reads() {
    for action in ["cancel", "switch", "damage"] {
        let fixture = Arc::new(Fixture::new());
        let path = fixture.paths()[2].clone();
        let (pause, entered) = Pause::new(&path);
        let first = tokio::spawn(response(fixture.clone(), 2, "GET", None));
        entered.await.unwrap();
        let second = tokio::spawn(response(fixture.clone(), 2, "GET", None));
        until(|| fixture.service.group_reads.listeners() == 2).await;
        match action {
            "cancel" => {
                first.abort();
                second.abort();
            }
            "switch" => {
                let mut current = state::read(&fixture.ctx).unwrap();
                current["sequence"] = (current["sequence"].as_u64().unwrap() + 1).into();
                fs::write_json(&fixture.ctx.store.join("current.json"), &current).unwrap();
            }
            _ => {
                let mut bytes = fixture.texture.clone();
                *bytes.last_mut().unwrap() ^= 1;
                std::fs::write(&path, bytes).unwrap();
            }
        }
        if action == "cancel" {
            assert!(first.await.unwrap_err().is_cancelled());
            assert!(second.await.unwrap_err().is_cancelled());
            drop(pause);
            until(|| fixture.service.group_reads.retained_bytes() == 0).await;
            assert!(fixture.service.mount(&fixture.entries[2].path).is_some());
        } else {
            drop(pause);
            for response in [first.await.unwrap(), second.await.unwrap()] {
                assert!(!response.headers().contains_key("x-resource-version"));
                assert_eq!(
                    response
                        .into_body()
                        .collect()
                        .await
                        .unwrap()
                        .to_bytes()
                        .as_ref(),
                    b"bundled"
                );
            }
        }
        std::fs::write(&path, &fixture.texture).unwrap();
        assert_eq!(fixture.service.status(true)["mounted"], true);
        assert_eq!(
            fixture.request("GET", None, false).await.2.as_ref(),
            fixture.texture
        );
        fixture.service.close().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn saturated_admission_waiters_join_a_matching_flight_without_second_verification() {
    let fixture = Arc::new(Fixture::new());
    let paths = fixture.paths();
    let watch = Watch::new(&paths);
    let snapshot = fixture.service.mount(&fixture.entries[2].path).unwrap().1;
    let group = snapshot
        .groups
        .iter()
        .position(|g| g.paths.contains(&fixture.entries[2].path))
        .unwrap();
    let file = snapshot.groups[group]
        .paths
        .iter()
        .position(|p| p == &fixture.entries[2].path)
        .unwrap();
    let read = |snapshot| {
        let fixture = fixture.clone();
        async move {
            fixture
                .service
                .group_reads
                .get(&fixture.service, snapshot, group, file, true)
                .await
                .unwrap()
        }
    };
    let (pause_y, y_entered) = Pause::new(&paths[2]);
    let y = tokio::spawn(read(Arc::new((*snapshot).clone())));
    y_entered.await.unwrap();
    let (pause_z, z_entered) = Pause::new(&paths[0]);
    let z = tokio::spawn(read(Arc::new((*snapshot).clone())));
    z_entered.await.unwrap();
    let x1 = read(snapshot.clone());
    let x2 = read(snapshot);
    tokio::pin!(x1, x2);
    assert!(futures_util::poll!(x1.as_mut()).is_pending());
    assert!(futures_util::poll!(x2.as_mut()).is_pending());
    drop(pause_y);
    drop(y.await.unwrap());
    for path in &paths {
        watch.take(path);
    }
    let (pause_x, x_entered) = Pause::new(&paths[2]);
    assert!(futures_util::poll!(x1.as_mut()).is_pending());
    x_entered.await.unwrap();
    assert!(futures_util::poll!(x2.as_mut()).is_pending());
    assert_eq!(
        fixture.service.group_reads.listeners(),
        3,
        "Z and both X readers must be attached"
    );
    drop(pause_x);
    let (one, two) = tokio::join!(x1, x2);
    assert_eq!(one.as_ptr(), two.as_ptr());
    for (index, path) in paths.iter().enumerate() {
        let bytes = fixture.entries[index].bytes;
        assert_eq!(
            watch.take(path),
            Reads {
                passes: 1,
                bytes,
                collected: bytes
            }
        );
    }
    drop(one);
    drop(two);
    drop(pause_z);
    drop(z.await.unwrap());
    fixture.service.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bodyless_flight_shares_hashing_but_keeps_conditions_and_body_mode_independent() {
    let fixture = Arc::new(Fixture::new());
    let paths = fixture.paths();
    let watch = Watch::new(&paths);
    let etag = format!("\"{}\"", fixture.entries[2].sha256);
    let (pause, entered) = Pause::new(&paths[2]);
    let head = tokio::spawn(response(fixture.clone(), 2, "HEAD", None));
    entered.await.unwrap();
    let fresh = tokio::spawn(response(fixture.clone(), 2, "GET", Some(etag.clone())));
    until(|| fixture.service.group_reads.listeners() == 2).await;
    assert_eq!(fixture.service.group_reads.retained_bytes(), 0);
    let normal = response(fixture.clone(), 2, "GET", None).await;
    assert_eq!(normal.status(), StatusCode::OK);
    let body = normal.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(body.as_ref(), fixture.texture);
    assert!(fixture.service.group_reads.retained_bytes() > 0);
    drop(body);
    until(|| fixture.service.group_reads.retained_bytes() == 0).await;
    drop(pause);
    let head = head.await.unwrap();
    let fresh = fresh.await.unwrap();
    assert_eq!(head.status(), StatusCode::OK);
    assert_eq!(fresh.status(), StatusCode::NOT_MODIFIED);
    assert_eq!(
        head.headers()["content-length"],
        fixture.entries[2].bytes.to_string()
    );
    assert_eq!(fresh.headers()["content-length"], "0");
    assert_eq!(head.headers()["etag"], etag);
    assert_eq!(fresh.headers()["etag"], etag);
    for (index, path) in paths.iter().enumerate() {
        let bytes = fixture.entries[index].bytes;
        assert_eq!(
            watch.take(path),
            Reads {
                passes: 2,
                bytes: bytes * 2,
                collected: bytes
            }
        );
    }
    fixture.service.close().await;
}
