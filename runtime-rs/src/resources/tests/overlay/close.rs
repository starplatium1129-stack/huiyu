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
        let closing = fixture.service.close();
        tokio::pin!(closing);
        let waiting = futures_util::poll!(closing.as_mut()).is_pending();
        assert!(
            waiting,
            "Close owns the shared verifier until its blocking read exits"
        );
        assert!(!fixture.shutdown.is_cancelled());
        drop(pause);
        closing.await;
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn close_during_start_refresh_rejects_admission_without_task_writes() {
    let fixture = Fixture::new();
    let task_file = fixture.ctx.store.join("gateway/task.json");
    assert!(!task_file.exists());
    let current_file = fixture.ctx.store.join("current.json");
    let before = std::fs::read(&current_file).unwrap();
    let path = fixture.root.join(&fixture.entries[2].path);
    let (pause, entered) = Pause::new(&path);
    let host = Arc::new(HostAuthority::new(None, None, None));
    let admission = host.admit_owned().unwrap();
    let owner = fixture.service.clone();
    let starting =
        tokio::task::spawn_blocking(move || owner.start("import", Some("neutral"), admission));
    tokio::time::timeout(Duration::from_secs(2), entered)
        .await
        .unwrap()
        .unwrap();
    let owner = fixture.service.clone();
    let runtime = tokio::runtime::Handle::current();
    let closing = tokio::task::spawn_blocking(move || runtime.block_on(owner.close()));
    tokio::time::timeout(
        Duration::from_secs(2),
        fixture.service.read_cancel.cancelled(),
    )
    .await
    .unwrap();
    drop(pause);
    let result = starting.await.unwrap();
    closing.await.unwrap();
    assert_eq!(result.unwrap_err().code, "ACCESS_DENIED");
    assert!(!task_file.exists());
    assert_eq!(std::fs::read(&current_file).unwrap(), before);
    assert_eq!(fixture.service.queue_status()["active"], 0);
    assert!(!fixture.shutdown.is_cancelled());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn close_waits_for_already_admitted_resource_worker() {
    let fixture = Fixture::new();
    // The source manifest is read only by the admitted import, not refresh.
    let source = PathBuf::from(
        fixture.ctx.policy["sources"]["source"]["root"]
            .as_str()
            .unwrap(),
    );
    let (pause, entered) = Pause::new(&source.join("neutral/manifest.json"));
    let host = Arc::new(HostAuthority::new(None, None, None));
    let admission = host.admit_owned().unwrap();
    let owner = fixture.service.clone();
    let task =
        tokio::task::spawn_blocking(move || owner.start("import", Some("neutral"), admission))
            .await
            .unwrap()
            .unwrap();
    tokio::time::timeout(Duration::from_secs(2), entered)
        .await
        .unwrap()
        .unwrap();
    let closing = fixture.service.close();
    tokio::pin!(closing);
    // Poll to the tracker wait rather than guessing with a fixed sleep.
    assert!(futures_util::poll!(closing.as_mut()).is_pending());
    assert!(fixture.service.read_cancel.is_cancelled());
    assert_eq!(fixture.service.queue_status()["active"], 1);
    drop(pause);
    tokio::time::timeout(Duration::from_secs(2), closing)
        .await
        .unwrap();
    assert_eq!(fixture.service.queue_status()["active"], 0);
    let saved = fs::json(&fixture.ctx.store.join("gateway/task.json"), false, false)
        .unwrap()
        .unwrap();
    assert_eq!(saved["id"], task["id"]);
    assert_eq!(saved["state"], "cancelled");
    assert!(!fixture.shutdown.is_cancelled());
}
