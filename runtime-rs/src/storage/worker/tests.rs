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
    // Typed reads keep the ordinary read error and cancel-on-drop contract.
    for abort_caller in [false, true] {
        let (sender, mut receiver) = mpsc::channel(1);
        let mut reader = storage.clone();
        reader.sender = sender;
        let caller = tokio::spawn(async move { reader.task_record("task", "test").await });
        let Some(Work::TaskRecord(_, _, cancel, reply)) = receiver.recv().await else {
            panic!("expected typed task read");
        };
        if abort_caller {
            caller.abort();
            assert!(caller.await.unwrap_err().is_cancelled());
            assert!(cancel.load(Ordering::Relaxed));
            assert!(reply.is_closed());
        } else {
            drop(reply);
            assert_eq!(
                caller.await.unwrap().unwrap_err().code,
                "STORAGE_UNAVAILABLE"
            );
        }
    }
    let (sender, mut receiver) = mpsc::channel(1);
    let mut reader = storage.clone();
    reader.sender = sender;
    let caller = tokio::spawn(async move {
        reader
            .request(
                json!({"kind":"readArtworkRecentIndex","candidateLimit":3}),
                "test",
            )
            .await
    });
    let Some(Work::ArtworkRead(_, _, first_cancel, reply)) = receiver.recv().await else {
        panic!("expected indexed read");
    };
    reply.send(Ok(None)).unwrap();
    let Some(Work::ArtworkRead(_, _, cancel, reply)) = receiver.recv().await else {
        panic!("expected requeued indexed read");
    };
    assert!(Arc::ptr_eq(&first_cancel, &cancel));
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    assert!(cancel.load(Ordering::Relaxed));
    assert!(reply.is_closed());
    storage.close().await.unwrap();
}

#[tokio::test]
async fn cold_index_yields_to_status_before_publishing_a_complete_read() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("workspace");
    let storage = Storage::open(root.clone(), "index-yield".into(), true)
        .await
        .unwrap();
    storage.close().await.unwrap();
    let mut db = Connection::open(root.join("huiyu.sqlite3")).unwrap();
    let transaction = db.transaction().unwrap();
    for id in 0..500 {
        transaction
            .execute(
                "INSERT INTO artworks VALUES(?1,?2,?3,1,NULL)",
                rusqlite::params![
                    id.to_string(),
                    id.to_string(),
                    json!({"id":id,"timestamp":id}).to_string()
                ],
            )
            .unwrap();
    }
    transaction
        .execute("UPDATE meta SET value='1' WHERE key='revision'", [])
        .unwrap();
    transaction.commit().unwrap();
    drop(db);
    let storage = Storage::open(root, "index-yield".into(), false)
        .await
        .unwrap();
    let (reply, first) = oneshot::channel();
    storage
        .sender
        .send(Work::ArtworkRead(
            json!({"kind":"readArtworkRecentIndex","candidateLimit":3}),
            "test".into(),
            Arc::new(AtomicBool::new(false)),
            reply,
        ))
        .await
        .unwrap();
    let status = storage
        .request(json!({"kind":"status"}), "test")
        .await
        .unwrap();
    assert!(
        first.await.unwrap().unwrap().is_none(),
        "a cold chunk must yield without a partial response"
    );
    assert_eq!(status["revision"], 1);
    let completed = storage
        .request(
            json!({"kind":"readArtworkRecentIndex","candidateLimit":3}),
            "test",
        )
        .await
        .unwrap();
    assert_eq!(
        completed["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["id"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        vec![497, 498, 499]
    );
    storage.close().await.unwrap();
}

#[tokio::test]
async fn background_search_warm_has_one_owner_and_stops_when_unused() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(
        directory.path().join("workspace"),
        "warm-owner".into(),
        true,
    )
    .await
    .unwrap();
    let (sender, mut receiver) = mpsc::channel(1);
    let mut reader = storage.clone();
    reader.sender = sender;
    artwork_search::warm(&reader);
    let Some(Work::WarmArtworkSearch(previous_cancel, warming, reply)) =
        tokio::time::timeout(std::time::Duration::from_secs(2), receiver.recv())
            .await
            .unwrap()
    else {
        panic!("expected warm work")
    };
    artwork_search::warm(&reader);
    assert!(
        receiver.try_recv().is_err(),
        "concurrent warm hints must coalesce"
    );
    // The actor clears a completed flight before publishing its result. A new
    // read may start another flight before the old producer observes completion.
    warming.store(false, Ordering::Release);
    reply.send(Ok(false)).unwrap();
    artwork_search::warm(&reader);
    let Some(Work::WarmArtworkSearch(cancel, warming, reply)) =
        tokio::time::timeout(std::time::Duration::from_secs(2), receiver.recv())
            .await
            .unwrap()
    else {
        panic!("expected new warm work")
    };
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while !previous_cancel.load(Ordering::Acquire) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(warming.load(Ordering::Acquire));
    drop(reader);
    reply.send(Ok(true)).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while warming.load(Ordering::Acquire) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(cancel.load(Ordering::Relaxed));
    storage.close().await.unwrap();
}
