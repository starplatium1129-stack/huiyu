use super::*;

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
