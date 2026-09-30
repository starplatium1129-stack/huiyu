use super::*;
use std::time::Duration;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bundled_asset_misses_skip_mount_control_reads() {
    let fixture = Fixture::new();
    let paths = [
        fixture.config_file.clone(),
        fixture.ctx.store.join("current.json"),
    ];
    let (configuration, snapshot) = fixture.service.mount(&fixture.entries[2].path).unwrap();
    let watch = Watch::new(&paths);
    // The previous overlay performed this control check before discovering
    // the asset was absent. Count real reads, not a wall-clock estimate.
    for _ in 0..10 {
        resolve::mount(&configuration.ctx, &snapshot).unwrap();
    }
    // access() checks configuration once directly and once through the
    // current release policy; current.json is read once per mount.
    assert_eq!(watch.take(&paths[0]).passes, 20);
    assert_eq!(watch.take(&paths[1]).passes, 10);
    for _ in 0..10 {
        let mounted = fixture.service.mount("assets/bundled-only.png");
        assert!(mounted.is_none_or(|(_, snapshot)| {
            !snapshot.entries.contains_key("assets/bundled-only.png")
        }));
    }
    for path in &paths {
        assert_eq!(watch.take(path), Reads::default());
    }
    // Actual resource hits still check current authorization and pointer bytes.
    assert!(fixture.service.mount(&fixture.entries[2].path).is_some());
    for path in &paths {
        assert!(watch.take(path).passes > 0);
    }
    let mut bytes = std::fs::read(&fixture.config_file).unwrap();
    bytes.push(b' ');
    write(&fixture.config_file, &bytes);
    assert!(fixture.service.mount(&fixture.entries[2].path).is_none());
    fixture.service.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mount_validation_does_not_hold_state_lock_or_publish_after_close() {
    let fixture = Fixture::new();
    let (pause, entered) = Pause::new(&fixture.config_file);
    let owner = fixture.service.clone();
    let path = fixture.entries[2].path.clone();
    let worker = tokio::task::spawn_blocking(move || owner.mount(&path));
    tokio::time::timeout(Duration::from_secs(2), entered)
        .await
        .unwrap()
        .unwrap();
    let owner = fixture.service.clone();
    // A separate blocking worker must acquire the state lock while the first
    // worker is paused inside an actual configuration read.
    let miss = tokio::task::spawn_blocking(move || owner.mount("assets/bundled-only.png"));
    assert!(
        tokio::time::timeout(Duration::from_secs(2), miss)
            .await
            .unwrap()
            .unwrap()
            .is_none()
    );
    fixture.service.close().await;
    drop(pause);
    assert!(worker.await.unwrap().is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn old_mount_validation_cannot_publish_or_revoke_refreshed_generation() {
    for invalid in [false, true] {
        let fixture = Fixture::new();
        let path = &fixture.entries[2].path;
        let (_, old) = fixture.service.mount(path).unwrap();
        let control = fixture.ctx.store.join("current.json");
        let original = std::fs::read(&control).unwrap();
        if invalid {
            write(&control, b"invalid JSON");
        }
        // bytes() has read the old control bytes when paused; the worker will
        // either pass or fail on its old generation after refresh completes.
        let (pause, entered) = Pause::new(&control);
        let owner = fixture.service.clone();
        let relative = path.clone();
        let worker = tokio::task::spawn_blocking(move || owner.mount(&relative));
        tokio::time::timeout(Duration::from_secs(2), entered)
            .await
            .unwrap()
            .unwrap();
        if invalid {
            write(&control, &original);
        }
        let owner = fixture.service.clone();
        let refreshed = tokio::task::spawn_blocking(move || owner.status(true));
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), refreshed)
                .await
                .unwrap()
                .unwrap()["mounted"],
            true
        );
        let (_, current) = fixture.service.mount(path).unwrap();
        assert_eq!(old.identity, current.identity);
        assert!(!Arc::ptr_eq(&old, &current));
        drop(pause);
        assert!(worker.await.unwrap().is_none());
        let (_, retained) = fixture.service.mount(path).unwrap();
        assert!(Arc::ptr_eq(&current, &retained));
        assert!(fixture.service.status(false)["issue"].is_null());
        fixture.service.close().await;
    }
}
