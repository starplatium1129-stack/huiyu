use super::*;
use sha2::{Digest, Sha256};
use std::{sync::atomic::Ordering, time::Duration};

async fn fixture() -> (tempfile::TempDir, Storage) {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(
        directory.path().join("workspace"),
        "verify-test".into(),
        true,
    )
    .await
    .unwrap();
    let bytes = b"\x89PNG\r\n\x1a\nfixture";
    let metadata = json!({"alias":"image","sha256":hex::encode(Sha256::digest(bytes)),"bytes":bytes.len(),"mime":"image/png"});
    for command in [
        json!({"kind":"prepareSave","operationId":"save","artwork":{"id":1},"media":metadata}),
        json!({"kind":"uploadChunk","operationId":"save","offset":0,"data":STANDARD.encode(bytes)}),
        json!({"kind":"commitSave","operationId":"save"}),
    ] {
        storage.request(command, "test").await.unwrap();
    }
    (directory, storage)
}
fn pause(
    storage: &Storage,
) -> (
    tokio::sync::oneshot::Receiver<()>,
    std::sync::mpsc::Sender<()>,
) {
    let (entered, ready) = tokio::sync::oneshot::channel();
    let (resume, receiver) = std::sync::mpsc::channel();
    *storage.verification.pause.lock().unwrap() = Some(Pause {
        entered,
        resume: receiver,
    });
    (ready, resume)
}
fn read(storage: &Storage) -> tokio::task::JoinHandle<Result<Media>> {
    let storage = storage.clone();
    tokio::spawn(async move { storage.media("image").await })
}
async fn ready(entered: tokio::sync::oneshot::Receiver<()>) {
    tokio::time::timeout(Duration::from_secs(3), entered)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn cold_hash_does_not_block_database_and_duplicates_share_verification() {
    let (_directory, storage) = fixture().await;
    let (entered, resume) = pause(&storage);
    let first = read(&storage);
    ready(entered).await;
    let duplicate = read(&storage);
    // The paused filesystem read cannot consume the database worker.
    for command in [
        json!({"kind":"status"}),
        json!({"kind":"profile.readSettings"}),
    ] {
        tokio::time::timeout(Duration::from_secs(2), storage.request(command, "test"))
            .await
            .unwrap()
            .unwrap();
    }
    tokio::time::timeout(
        Duration::from_secs(2),
        storage.task(
            crate::task_contract::TaskCommand::List {
                query: Default::default(),
            },
            "test",
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(!first.is_finished());
    resume.send(()).unwrap();
    first.await.unwrap().unwrap();
    duplicate.await.unwrap().unwrap();
    assert_eq!(storage.verification.hashes.load(Ordering::Relaxed), 1);
    storage.close().await.unwrap();
}

#[tokio::test]
async fn identity_change_invalidates_warm_cache_and_closed_cache_cannot_be_read() {
    let (_directory, storage) = fixture().await;
    let source = storage.media("image").await.unwrap();
    storage.media("image").await.unwrap();
    assert_eq!(storage.verification.hashes.load(Ordering::Relaxed), 1);
    std::fs::write(&source.path, b"changed").unwrap();
    assert_eq!(
        storage.media("image").await.unwrap_err().code,
        "MEDIA_INVALID"
    );
    assert_eq!(storage.verification.hashes.load(Ordering::Relaxed), 2);
    storage.close().await.unwrap();
    assert!(storage.media("image").await.is_err());
}

#[tokio::test]
async fn warm_media_does_not_wait_for_cold_hash_worker_capacity() {
    let (_directory, storage) = fixture().await;
    let source = storage.media("image").await.unwrap();
    let held = storage
        .verification
        .workers
        .acquire_many(WORKERS)
        .await
        .unwrap();
    let cached = tokio::time::timeout(Duration::from_secs(1), storage.media("image")).await;
    drop(held);
    storage.close().await.unwrap();
    let cached = cached
        .expect("verified media must bypass cold hash admission")
        .unwrap();
    assert_eq!(cached.sha256, source.sha256);
    assert_eq!(storage.verification.hashes.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn disconnect_cancels_verification_and_close_waits_for_blocking_worker() {
    for warm in [false, true] {
        let (_directory, storage) = fixture().await;
        if warm {
            storage.media("image").await.unwrap();
        }
        let (entered, resume) = pause(&storage);
        let first = read(&storage);
        ready(entered).await;
        first.abort();
        assert!(first.await.unwrap_err().is_cancelled());
        let closing_storage = storage.clone();
        let mut closing = tokio::spawn(async move { closing_storage.close().await });
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut closing)
                .await
                .is_err()
        );
        resume.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(2), closing)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            storage.verification.cache.lock().unwrap().len(),
            usize::from(warm)
        );
        assert_eq!(
            storage.verification.workers.available_permits(),
            WORKERS as usize
        );
        assert_eq!(
            storage.verification.checks.available_permits(),
            CHECKERS as usize
        );
    }
}

#[tokio::test]
async fn thumbnail_close_drains_detached_decoder_before_releasing_workspace() {
    let (_directory, storage) = fixture().await;
    let (entered, resume) = storage.thumbnails.pause();
    let request_storage = storage.clone();
    let request = tokio::spawn(async move {
        request_storage
            .request(json!({"kind":"readThumbnail","alias":"image"}), "test")
            .await
    });
    ready(entered).await;
    request.abort();
    assert!(request.await.unwrap_err().is_cancelled());
    let closing_storage = storage.clone();
    let mut closing = tokio::spawn(async move { closing_storage.close().await });
    assert!(
        tokio::time::timeout(Duration::from_millis(20), &mut closing)
            .await
            .is_err()
    );
    assert!(
        Storage::open(storage.root.as_ref().clone(), "verify-test".into(), false)
            .await
            .is_err()
    );
    resume.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(2), closing)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(!storage.root.join("cache").exists());
    assert!(
        storage
            .request(json!({"kind":"readThumbnail","alias":"image"}), "test")
            .await
            .is_err()
    );
    let reopened = Storage::open(storage.root.as_ref().clone(), "verify-test".into(), false)
        .await
        .unwrap();
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn verification_admission_is_bounded_and_waiters_observe_close() {
    let (_directory, storage) = fixture().await;
    let held = storage
        .verification
        .workers
        .acquire_many(WORKERS)
        .await
        .unwrap();
    let waiting = read(&storage);
    assert!(
        tokio::time::timeout(Duration::from_secs(2), async {
            while storage.verification.paths.lock().unwrap().is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .is_ok()
    );
    assert_eq!(storage.verification.hashes.load(Ordering::Relaxed), 0);
    storage.verification.closed.cancel();
    assert!(
        tokio::time::timeout(Duration::from_secs(2), waiting)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
    drop(held);
    storage.close().await.unwrap();
}

#[tokio::test]
async fn changing_file_during_verification_never_populates_cache() {
    let (_directory, storage) = fixture().await;
    let (entered, resume) = pause(&storage);
    let reading = read(&storage);
    ready(entered).await;
    let hash = hex::encode(Sha256::digest(b"\x89PNG\r\n\x1a\nfixture"));
    let path = media::object_path(&storage.root, &hash).unwrap();
    std::fs::write(path, b"\x89PNG\r\n\x1a\nchanged").unwrap();
    resume.send(()).unwrap();
    assert_eq!(reading.await.unwrap().unwrap_err().code, "MEDIA_INVALID");
    assert!(storage.verification.cache.lock().unwrap().is_empty());
    storage.close().await.unwrap();
}
