use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};
use std::time::Duration;

async fn command(storage: &Storage, command: Value) -> Value {
    storage.request(command, "backup-test").await.unwrap()
}
struct PausedCopy {
    entered: oneshot::Receiver<()>,
    resume: std::sync::mpsc::SyncSender<()>,
    finished: oneshot::Receiver<()>,
}
async fn pause(storage: &Storage) -> PausedCopy {
    let (entered, entered_rx) = oneshot::channel();
    let (resume, resume_rx) = std::sync::mpsc::sync_channel(1);
    let (finished, finished_rx) = oneshot::channel();
    storage
        .sender
        .send(Work::PauseCopy(worker::CopyPause {
            entered,
            resume: resume_rx,
            finished,
        }))
        .await
        .unwrap();
    PausedCopy {
        entered: entered_rx,
        resume,
        finished: finished_rx,
    }
}
async fn responsive(storage: &Storage) -> Value {
    tokio::time::timeout(Duration::from_secs(2), async {
        let status = command(storage, json!({"kind":"status"})).await;
        assert_eq!(
            command(storage, json!({"kind":"listArtworks"})).await["items"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        status
    })
    .await
    .expect("large copy must release the SQLite writer lane")
}

#[tokio::test]
async fn copies_release_writer_preserve_snapshot_and_cancel_without_receipt() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("workspace");
    let storage = Storage::open(root.clone(), "background-copy".into(), true)
        .await
        .unwrap();
    let bytes=STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=").unwrap();
    command(&storage,json!({"kind":"prepareSave","operationId":"save","artwork":{"id":"original","title":"snapshot"},"media":{"alias":"original.png","sha256":hex::encode(Sha256::digest(&bytes)),"bytes":bytes.len(),"mime":"image/png"}})).await;
    command(&storage,json!({"kind":"uploadChunk","operationId":"save","offset":0,"data":STANDARD.encode(&bytes)})).await;
    let saved = command(&storage, json!({"kind":"commitSave","operationId":"save"})).await;

    let gate = pause(&storage).await;
    let caller = storage.clone();
    let backup = tokio::spawn(async move {
        caller
            .request(
                json!({"kind":"backup","operationId":"snapshot"}),
                "backup-test",
            )
            .await
    });
    gate.entered.await.unwrap();
    assert_eq!(responsive(&storage).await["revision"], saved["revision"]);
    let busy = storage
        .request(
            json!({"kind":"backup","operationId":"concurrent"}),
            "backup-test",
        )
        .await
        .unwrap_err();
    assert_eq!(busy.code, "WORKSPACE_BUSY");
    command(&storage,json!({"kind":"patchArtwork","operationId":"later-write","id":"original","expectedRevision":saved["revision"],"patch":{"title":"newer"}})).await;
    gate.resume.send(()).unwrap();
    let backup = backup.await.unwrap().unwrap();
    assert_eq!(backup["revision"], saved["revision"]);

    let restore_gate = pause(&storage).await;
    let caller = storage.clone();
    let backup_id = backup["backupId"].clone();
    let restored = tokio::spawn(async move {
        caller
            .request(
                json!({"kind":"restoreBackup","operationId":"candidate","backupId":backup_id}),
                "backup-test",
            )
            .await
    });
    restore_gate.entered.await.unwrap();
    responsive(&storage).await;
    restore_gate.resume.send(()).unwrap();
    let restored = restored.await.unwrap().unwrap();
    assert_eq!(restored["mediaCount"], 1);
    let candidate_root = root
        .join("restore-candidates")
        .join(restored["candidateId"].as_str().unwrap());
    assert!(candidate_root.join("candidate.json").is_file());
    let candidate = Storage::open(candidate_root, "background-copy".into(), false)
        .await
        .unwrap();
    assert_eq!(
        command(&candidate, json!({"kind":"getArtwork","id":"original"})).await["body"]["title"],
        "snapshot"
    );
    assert_eq!(
        std::fs::read(candidate.media("original.png").await.unwrap().path).unwrap(),
        bytes
    );
    candidate.close().await.unwrap();

    let cancel_gate = pause(&storage).await;
    let caller = storage.clone();
    let cancelled = tokio::spawn(async move {
        caller
            .request(
                json!({"kind":"backup","operationId":"cancelled-copy"}),
                "backup-test",
            )
            .await
    });
    cancel_gate.entered.await.unwrap();
    responsive(&storage).await;
    cancelled.abort();
    assert!(cancelled.await.unwrap_err().is_cancelled());
    cancel_gate.resume.send(()).unwrap();
    cancel_gate.finished.await.unwrap();
    let prepared = command(
        &storage,
        json!({"kind":"getOperation","operationId":"cancelled-copy"}),
    )
    .await;
    assert_eq!(prepared["state"], "prepared");
    assert!(prepared.get("receipt").is_none());
    command(
        &storage,
        json!({"kind":"backup","operationId":"cancelled-copy"}),
    )
    .await;
    assert_eq!(
        command(
            &storage,
            json!({"kind":"getOperation","operationId":"cancelled-copy"})
        )
        .await["state"],
        "committed"
    );
    storage.close().await.unwrap();
}

#[cfg(unix)]
#[test]
fn backup_metadata_rejects_fifo_before_opening_and_keeps_regular_json() {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};

    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("incomplete.json");
    let fifo = CString::new(path.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    let (done, waiting) = std::sync::mpsc::channel();
    let unblock_path = path.clone();
    let unblock = std::thread::spawn(move || {
        // Keep a regression bounded: the old reader blocks until this writer
        // supplies valid JSON, then fails the expected regular-file rejection.
        if matches!(
            waiting.recv_timeout(Duration::from_secs(2)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ) {
            fs::write(unblock_path, b"{}").unwrap();
        }
    });
    let result = read_json(directory.path(), "incomplete.json");
    let _ = done.send(());
    unblock.join().unwrap();
    assert_eq!(result.unwrap_err().code, "BACKUP_INVALID");
    fs::remove_file(&path).unwrap();
    fs::write(&path, br#"{"identity":"fixture","workspaceId":"test"}"#).unwrap();
    assert_eq!(
        read_json(directory.path(), "incomplete.json").unwrap(),
        json!({"identity":"fixture","workspaceId":"test"})
    );
}
