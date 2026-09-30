use super::*;
use axum::body::Bytes;
use base64::{Engine, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};
use std::time::Instant;

const PRINCIPAL: &str = "desktop:binary-media";
const ID: &str = "binary-task";

async fn fixture() -> (tempfile::TempDir, Storage) {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(
        directory.path().join("workspace"),
        "binary-media".into(),
        true,
    )
    .await
    .unwrap();
    let record = json!({"taskId":ID,"workspaceId":"binary-media","principalId":PRINCIPAL,
        "requestKey":"binary-request","requestFingerprint":"fixture","kind":"generation",
        "provider":"fixture","providerFingerprint":"fixture","upstreamId":null,
        "status":"succeeded","recoveryState":"normal","revision":0,"runtimeEpoch":"",
        "createdAt":1,"updatedAt":1,"submissionIntentAt":null,"submissionObservedAt":null,
        "cancelRequestedAt":null,"upstreamSettled":true,"executionDeadline":60000,
        "input":{},"inputMediaRefs":[],"resultState":"none","resultRefs":[],
        "deliveryState":"unseen","errorCode":null,"metadata":{},"checkpoint":null,
        "parentBatchId":null,"stepIndex":null});
    storage
        .task(
            TaskCommand::Accept {
                record: Box::new(serde_json::from_value(record).unwrap()),
            },
            PRINCIPAL,
        )
        .await
        .unwrap();
    (directory, storage)
}

fn command(target: &TaskMediaTarget, phase: &str) -> Value {
    match target {
        TaskMediaTarget::Input(name) => {
            json!({"kind":format!("task.input.{phase}"),"taskId":ID,"name":name})
        }
        TaskMediaTarget::Result(index) => {
            json!({"kind":format!("task.result.{phase}"),"taskId":ID,"index":index})
        }
    }
}

fn data(length: usize) -> Vec<u8> {
    let mut bytes = vec![93; length];
    bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
    bytes
}

async fn prepare(storage: &Storage, target: &TaskMediaTarget, bytes: &[u8]) -> String {
    let alias = match target {
        TaskMediaTarget::Input(name) => format!(
            "task-input-{}",
            canonical::digest(format!("input:{ID}:{name}"))
        ),
        TaskMediaTarget::Result(index) => format!("task-{ID}-{index}"),
    };
    let mut media = json!({"alias":alias,"sha256":hex::encode(Sha256::digest(bytes)),
        "bytes":bytes.len(),"mime":"image/png"});
    if let TaskMediaTarget::Result(index) = target {
        media["index"] = json!(index);
    }
    let mut request = command(target, "prepare");
    request["media"] = media;
    assert_eq!(
        storage.request(request, PRINCIPAL).await.unwrap()["offset"],
        0
    );
    alias
}

fn chunk(target: &TaskMediaTarget, offset: u64, bytes: Bytes) -> TaskMediaChunk {
    TaskMediaChunk {
        task_id: ID.into(),
        target: target.clone(),
        offset,
        bytes,
    }
}

async fn encoded(storage: &Storage, target: &TaskMediaTarget, offset: u64, bytes: &[u8]) -> u64 {
    let mut request = command(target, "chunk");
    request["offset"] = json!(offset);
    request["data"] = STANDARD.encode(bytes).into();
    storage.request(request, PRINCIPAL).await.unwrap()["offset"]
        .as_u64()
        .unwrap()
}

#[tokio::test]
async fn binary_and_encoded_chunks_share_retry_checks_leases_and_durable_bytes() {
    let (directory, storage) = fixture().await;
    let bytes = data(32);
    let db = Connection::open(directory.path().join("workspace/huiyu.sqlite3")).unwrap();
    for target in [
        TaskMediaTarget::Result(0),
        TaskMediaTarget::Input("image".into()),
    ] {
        let alias = prepare(&storage, &target, &bytes).await;
        let first = Bytes::copy_from_slice(&bytes[..16]);
        assert_eq!(
            storage
                .task_media_chunk(chunk(&target, 0, first.clone()), PRINCIPAL)
                .await
                .unwrap(),
            16
        );
        assert_eq!(encoded(&storage, &target, 0, &bytes[..16]).await, 16);
        assert_eq!(
            storage
                .task_media_chunk(chunk(&target, 0, first), PRINCIPAL)
                .await
                .unwrap(),
            16
        );
        for (offset, data) in [(0, vec![0; 16]), (8, bytes[8..24].to_vec()), (17, vec![1])] {
            assert_eq!(
                storage
                    .task_media_chunk(chunk(&target, offset, data.into()), PRINCIPAL)
                    .await
                    .unwrap_err()
                    .code,
                "OPERATION_CONFLICT"
            );
        }
        let leases: i64 = db
            .query_row("SELECT count(*) FROM leases", [], |row| row.get(0))
            .unwrap();
        assert_eq!(leases, 1, "chunks must not release their preparation lease");
        assert_eq!(encoded(&storage, &target, 16, &bytes[16..]).await, 32);
        storage
            .request(command(&target, "commit"), PRINCIPAL)
            .await
            .unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM leases", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        // A committed task chunk retains the established idempotent offset response.
        assert_eq!(
            storage
                .task_media_chunk(chunk(&target, u64::MAX, Bytes::new()), PRINCIPAL)
                .await
                .unwrap(),
            32
        );
        let media = storage.media(&alias).await.unwrap();
        assert_eq!(tokio::fs::read(media.path).await.unwrap(), bytes);
    }
    storage.close().await.unwrap();
    let storage = Storage::open(
        directory.path().join("workspace"),
        "binary-media".into(),
        false,
    )
    .await
    .unwrap();
    let stored = storage
        .request(json!({"kind":"task.get","taskId":ID}), PRINCIPAL)
        .await
        .unwrap();
    assert_eq!(stored["resultRefs"][0]["bytes"], 32);
    assert_eq!(stored["inputMediaRefs"].as_array().unwrap().len(), 1);
    storage.close().await.unwrap();
}

#[tokio::test]
async fn binary_chunks_enforce_identity_bounds_and_discard_before_filesystem_writes() {
    let (directory, storage) = fixture().await;
    let target = TaskMediaTarget::Result(0);
    let bytes = data(media::CHUNK + 16);
    prepare(&storage, &target, &bytes).await;
    for (offset, data) in [
        (0, Vec::new()),
        (0, vec![1; media::CHUNK + 1]),
        (u64::MAX, vec![1]),
    ] {
        assert_eq!(
            storage
                .task_media_chunk(chunk(&target, offset, data.into()), PRINCIPAL)
                .await
                .unwrap_err()
                .code,
            "MEDIA_INVALID"
        );
    }
    for (principal, expected) in [("", "UNAUTHORIZED"), ("other", "TASK_NOT_FOUND")] {
        assert_eq!(
            storage
                .task_media_chunk(chunk(&target, 0, Bytes::from_static(b"x")), principal)
                .await
                .unwrap_err()
                .code,
            expected
        );
    }
    let mut absent = chunk(&target, 0, Bytes::from_static(b"x"));
    absent.task_id = "missing".into();
    assert_eq!(
        storage
            .task_media_chunk(absent, PRINCIPAL)
            .await
            .unwrap_err()
            .code,
        "TASK_NOT_FOUND"
    );
    for (target, expected) in [
        (
            TaskMediaTarget::Input("../escape".into()),
            "TASK_INPUT_INVALID",
        ),
        (
            TaskMediaTarget::Input("unprepared".into()),
            "TASK_INPUT_MISSING",
        ),
        (TaskMediaTarget::Result(1), "TASK_RESULT_MISSING"),
        (
            TaskMediaTarget::Result(9_007_199_254_740_992),
            "INVALID_COMMAND",
        ),
    ] {
        assert_eq!(
            storage
                .task_media_chunk(chunk(&target, 0, Bytes::from_static(b"x")), PRINCIPAL)
                .await
                .unwrap_err()
                .code,
            expected
        );
    }
    assert_eq!(
        encoded(&storage, &target, 0, &bytes[..media::CHUNK]).await,
        media::CHUNK as u64
    );
    assert_eq!(
        storage
            .task_media_chunk(
                chunk(
                    &target,
                    media::CHUNK as u64,
                    Bytes::copy_from_slice(&bytes[media::CHUNK..])
                ),
                PRINCIPAL
            )
            .await
            .unwrap(),
        bytes.len() as u64
    );
    let task = storage
        .request(command(&target, "commit"), PRINCIPAL)
        .await
        .unwrap();
    // Keep a second, uncommitted output; discarding must still reject late binary chunks.
    let pending = TaskMediaTarget::Result(2);
    prepare(&storage, &pending, &data(32)).await;
    let current = storage
        .request(json!({"kind":"task.get","taskId":ID}), PRINCIPAL)
        .await
        .unwrap();
    let available = storage
        .request(
            json!({"kind":"task.patch","taskId":ID,
        "expectedRevision":current["revision"],"patch":{"resultState":"available"}}),
            PRINCIPAL,
        )
        .await
        .unwrap();
    storage
        .request(
            json!({"kind":"task.patch","taskId":ID,"expectedRevision":available["revision"],
        "patch":{"deliveryState":"discarded"}}),
            PRINCIPAL,
        )
        .await
        .unwrap();
    assert_eq!(
        storage
            .task_media_chunk(chunk(&pending, 0, Bytes::from_static(b"x")), PRINCIPAL)
            .await
            .unwrap_err()
            .code,
        "TASK_RESULT_DISCARDED"
    );
    let key = canonical::digest(format!("task:{ID}:2"));
    assert!(
        !media::staging_path(
            &directory.path().join("workspace"),
            &key,
            "task-binary-task-2"
        )
        .unwrap()
        .exists()
    );
    assert_eq!(task["resultState"], "available");
    storage.close().await.unwrap();
}

#[tokio::test]
async fn cancelled_or_abandoned_binary_work_does_not_write_and_close_rejects_new_chunks() {
    let (directory, storage) = fixture().await;
    let target = TaskMediaTarget::Result(0);
    prepare(&storage, &target, &data(32)).await;
    let cancel = CancelOnDrop(Arc::new(AtomicBool::new(false)));
    let flag = cancel.0.clone();
    drop(cancel);
    let (reply, result) = oneshot::channel();
    storage
        .sender
        .send(Work::TaskMediaChunk(
            chunk(&target, 0, Bytes::from_static(b"x")),
            PRINCIPAL.into(),
            flag,
            reply,
        ))
        .await
        .unwrap();
    assert_eq!(result.await.unwrap().unwrap_err().code, "CANCELLED");
    let (reply, result) = oneshot::channel();
    drop(result);
    storage
        .sender
        .send(Work::TaskMediaChunk(
            chunk(&target, 0, Bytes::from_static(b"x")),
            PRINCIPAL.into(),
            Arc::new(AtomicBool::new(false)),
            reply,
        ))
        .await
        .unwrap();
    // FIFO status establishes that the actor passed both cancelled jobs.
    storage
        .request(json!({"kind":"status"}), PRINCIPAL)
        .await
        .unwrap();
    let key = canonical::digest(format!("task:{ID}:0"));
    assert!(
        !media::staging_path(
            &directory.path().join("workspace"),
            &key,
            "task-binary-task-0"
        )
        .unwrap()
        .exists()
    );
    storage.close().await.unwrap();
    assert_eq!(
        storage
            .task_media_chunk(chunk(&target, 0, Bytes::from_static(b"x")), PRINCIPAL)
            .await
            .unwrap_err()
            .code,
        "STORAGE_UNAVAILABLE"
    );
}

// Isolated codec and actor/staging-file measurements; not model or end-to-end
// generation latency. Run alone with --ignored --nocapture; no timing threshold.
#[tokio::test]
#[ignore = "manual transport benchmark; no wall-clock pass threshold"]
async fn benchmark_task_media_chunk_transport() {
    let (_directory, storage) = fixture().await;
    let bytes = Bytes::from(data(16 * media::CHUNK));
    let sample = bytes.slice(..media::CHUNK);
    assert_eq!(
        STANDARD
            .decode(STANDARD.encode(&sample))
            .unwrap()
            .as_slice(),
        sample.as_ref()
    );
    let mut codec = Vec::new();
    for phase in ["encoded-json", "shared-binary"] {
        let mut samples = Vec::new();
        for _ in 0..3 {
            let started = Instant::now();
            for _ in 0..8 {
                for index in 0..16 {
                    let block = bytes.slice(index * media::CHUNK..(index + 1) * media::CHUNK);
                    if phase == "encoded-json" {
                        let value = json!({"data":STANDARD.encode(&block)});
                        let decoded = STANDARD.decode(value["data"].as_str().unwrap()).unwrap();
                        std::hint::black_box(decoded);
                    } else {
                        std::hint::black_box(block);
                    }
                }
            }
            samples.push(started.elapsed().as_secs_f64() * 1000.0);
        }
        codec.push(json!({"phase":phase,"bytes":128 * media::CHUNK,"samplesMs":samples}));
    }
    let mut transport = Vec::new();
    for phase in ["encoded-json", "shared-binary"] {
        let mut samples = Vec::new();
        for iteration in 0..3 {
            let target =
                TaskMediaTarget::Result(iteration + if phase == "encoded-json" { 0 } else { 3 });
            prepare(&storage, &target, &bytes).await;
            let started = Instant::now();
            for index in 0..16 {
                let offset = index * media::CHUNK;
                let block = bytes.slice(offset..offset + media::CHUNK);
                let next = if phase == "encoded-json" {
                    encoded(&storage, &target, offset as u64, &block).await
                } else {
                    storage
                        .task_media_chunk(chunk(&target, offset as u64, block), PRINCIPAL)
                        .await
                        .unwrap()
                };
                assert_eq!(next, (offset + media::CHUNK) as u64);
            }
            samples.push(started.elapsed().as_secs_f64() * 1000.0);
        }
        transport.push(json!({"phase":phase,"bytes":bytes.len(),"chunks":16,
            "syncAllPerChunk":true,"samplesMs":samples}));
    }
    println!(
        "{}",
        json!({"codecOnly":codec,"actorAndStagingDisk":transport})
    );
    storage.close().await.unwrap();
}
