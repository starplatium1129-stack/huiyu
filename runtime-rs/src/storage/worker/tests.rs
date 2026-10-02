use super::*;
use std::time::Duration;

#[tokio::test]
async fn closing_waits_for_real_copy_and_then_refuses_new_admission() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("workspace");
    let storage = Storage::open(root.clone(), "closing-copy".into(), true)
        .await
        .unwrap();
    let (entered, ready) = oneshot::channel();
    let (resume, resume_rx) = std::sync::mpsc::sync_channel(1);
    let (finished, completed) = oneshot::channel();
    storage
        .sender
        .send(Work::PauseCopy(CopyPause {
            entered,
            resume: resume_rx,
            finished,
        }))
        .await
        .unwrap();
    let caller = storage.clone();
    let backup = tokio::spawn(async move {
        caller
            .request(
                json!({"kind":"backup","operationId":"closing-copy"}),
                "test",
            )
            .await
    });
    tokio::time::timeout(Duration::from_secs(3), ready)
        .await
        .unwrap()
        .unwrap();
    let close = storage.close();
    tokio::pin!(close);
    assert!(
        tokio::time::timeout(Duration::from_millis(10), &mut close)
            .await
            .is_err()
    );
    assert_eq!(
        storage
            .request(json!({"kind":"status"}), "test")
            .await
            .unwrap_err()
            .code,
        "STORAGE_UNAVAILABLE"
    );
    assert!(root.join(".workspace-owner.json").exists());
    // CopyFinished must still enter the receiver after Close was admitted.
    resume.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(3), completed)
        .await
        .unwrap()
        .unwrap();
    let result = tokio::time::timeout(Duration::from_secs(3), backup)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), &mut close)
        .await
        .unwrap()
        .unwrap();
    assert!(
        root.join("backups")
            .join(result["backupId"].as_str().unwrap())
            .join("manifest.json")
            .is_file()
    );
    assert!(!root.join(".workspace-owner.json").exists());
    assert_eq!(
        storage
            .request(
                json!({"kind":"profile.saveSetting","operationId":"after-close",
        "key":"aics_theme","value":"dark","expectedRevision":null}),
                "test"
            )
            .await
            .unwrap_err()
            .code,
        "STORAGE_UNAVAILABLE"
    );
}

#[tokio::test]
async fn admitted_binary_mutation_with_lost_reply_remains_commit_unknown() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(
        directory.path().join("workspace"),
        "admitted-reply".into(),
        true,
    )
    .await
    .unwrap();
    let (sender, mut receiver) = mpsc::channel(1);
    let mut admitted = storage.clone();
    admitted.sender = sender;
    let caller = tokio::spawn(async move {
        admitted
            .task_media_chunk(
                TaskMediaChunk {
                    task_id: "task".into(),
                    target: TaskMediaTarget::Result(0),
                    offset: 0,
                    bytes: axum::body::Bytes::from_static(b"bytes"),
                },
                "test",
            )
            .await
    });
    // Capture admission before dropping the actor response; never classify an
    // accepted mutation as definitely unwritten merely because its reply vanished.
    let Some(Work::AdmittedResult(work, permit)) = receiver.recv().await else {
        panic!("expected admitted result write");
    };
    let Work::TaskMediaChunk(_, _, _, reply) = *work else {
        panic!("expected admitted binary chunk");
    };
    drop(reply);
    assert_eq!(caller.await.unwrap().unwrap_err().code, "COMMIT_UNKNOWN");
    drop(permit);
    storage.close().await.unwrap();
}
