use super::*;
use std::time::Duration;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn close_stops_overlay_reads_without_cancelling_gateway() {
    for (method, matching) in [("GET", false), ("HEAD", false), ("GET", true)] {
        let fixture = Arc::new(Fixture::new());
        let path = fixture.root.join(&fixture.entries[2].path);
        let watch = Watch::new(std::slice::from_ref(&path));
        let (pause, entered) = Pause::new(&path);
        let reading = fixture.clone();
        let worker = tokio::spawn(async move {
            let etag = format!("\"{}\"", reading.entries[2].sha256);
            reading
                .request(method, matching.then_some(etag.as_str()), false)
                .await
        });
        tokio::time::timeout(Duration::from_secs(2), entered)
            .await
            .unwrap()
            .unwrap();
        // The real 2 MiB file has reached its first 512 KiB read checkpoint.
        // Closing must stop the remaining read/hash loop, not merely discard
        // its fully collected result at the final mount check.
        fixture.service.close().await;
        assert!(!fixture.shutdown.is_cancelled());
        drop(pause);
        let (_, headers, body) = worker.await.unwrap();
        assert!(!headers.contains_key("x-resource-version"));
        if method == "GET" {
            assert_eq!(body.as_ref(), b"bundled");
        }
        assert_eq!(watch.take(&path), Reads::default());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gateway_shutdown_still_cancels_resource_read_token() {
    let fixture = Fixture::new();
    assert!(!fixture.service.read_cancel.is_cancelled());
    fixture.shutdown.cancel();
    assert!(fixture.service.read_cancel.is_cancelled());
    assert!(fixture.service.mount(&fixture.entries[2].path).is_none());
    fixture.service.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn close_cancels_snapshot_verification_before_waiting_for_state_lock() {
    let fixture = Fixture::new();
    let path = fixture.root.join(&fixture.entries[2].path);
    let watch = Watch::new(std::slice::from_ref(&path));
    let (pause, entered) = Pause::new(&path);
    let owner = fixture.service.clone();
    let refreshing = tokio::task::spawn_blocking(move || owner.status(true));
    tokio::time::timeout(Duration::from_secs(2), entered)
        .await
        .unwrap()
        .unwrap();
    let owner = fixture.service.clone();
    let runtime = tokio::runtime::Handle::current();
    // close waits on the synchronous state mutex held by refresh; keep that
    // wait off the async workers while observing its cancellation signal.
    let closing = tokio::task::spawn_blocking(move || runtime.block_on(owner.close()));
    tokio::time::timeout(
        Duration::from_secs(2),
        fixture.service.read_cancel.cancelled(),
    )
    .await
    .unwrap();
    drop(pause);
    let status = refreshing.await.unwrap();
    closing.await.unwrap();
    assert_eq!(status["mounted"], false);
    assert_eq!(status["issue"]["code"], "CANCELLED");
    assert_eq!(watch.take(&path), Reads::default());
    assert!(!fixture.shutdown.is_cancelled());
}
