use base64::{Engine, engine::general_purpose::STANDARD};
use huiyu_runtime::storage::{Storage, fingerprint};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

async fn request(storage: &Storage, command: Value) -> Value {
    storage.request(command, "desktop:test").await.unwrap()
}
fn image() -> (Vec<u8>, Value) {
    let bytes=STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=").unwrap();
    let media = json!({"alias":"test-original","sha256":hex::encode(Sha256::digest(&bytes)),"bytes":bytes.len(),"mime":"image/png"});
    (bytes, media)
}
#[tokio::test]
async fn durable_save_project_trash_profile_and_backup_round_trip() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("workspace");
    let storage = Storage::open(root.clone(), "test-workspace".into(), true)
        .await
        .unwrap();
    let (bytes, media) = image();
    let prepare = json!({"kind":"prepareSave","operationId":"save","artwork":{"id":17,"custom":{"future":[1,"二"]}},"media":media});
    request(&storage, prepare.clone()).await;
    let chunk = json!({"kind":"uploadChunk","operationId":"save","offset":0,"data":STANDARD.encode(&bytes)});
    request(&storage, chunk.clone()).await;
    request(&storage, chunk.clone()).await;
    let saved = request(&storage, json!({"kind":"commitSave","operationId":"save"})).await;
    assert_eq!(
        saved,
        request(&storage, json!({"kind":"commitSave","operationId":"save"})).await
    );
    assert_eq!(request(&storage, prepare).await["receipt"], saved);
    request(&storage, chunk).await;
    request(&storage,json!({"kind":"saveProject","operationId":"project","project":{"id":"p","future":"retained"},"artworkIds":[17],"expectedRevision":null})).await;
    let deleted=request(&storage,json!({"kind":"softDeleteArtwork","operationId":"delete","id":17,"expectedRevision":saved["revision"]})).await;
    assert_eq!(
        request(&storage, json!({"kind":"listProjects"})).await["items"][0]["body"]["history_ids"],
        json!([])
    );
    let restored=request(&storage,json!({"kind":"restoreArtwork","operationId":"restore","id":17,"expectedRevision":deleted["revision"]})).await;
    assert_eq!(
        restored["artwork"]["body"]["custom"],
        json!({"future":[1,"二"]})
    );
    assert_eq!(
        request(&storage, json!({"kind":"listProjects"})).await["items"][0]["body"]["history_ids"],
        json!([17])
    );
    let setting=request(&storage,json!({"kind":"profile.saveSetting","operationId":"setting","key":"aics_theme","value":"dark","expectedRevision":null})).await;
    assert_eq!(
        request(&storage, json!({"kind":"profile.readSettings"})).await["records"][0],
        setting
    );
    for (operation, window, text) in [
        ("global-draft", None, "legacy"),
        ("own-draft", Some("绘遇_%[测试]"), "current window"),
        ("other-draft", Some("other"), "other window"),
    ] {
        let mut command = json!({"kind":"profile.saveDraft","operationId":operation,"key":"aics_pb_last_draft","value":{"text":text},"expectedRevision":null});
        if let Some(window) = window {
            command["windowId"] = window.into();
        }
        request(&storage, command).await;
    }
    for (window, text) in [
        ("绘遇_%[测试]", "current window"),
        ("other", "other window"),
    ] {
        let drafts = request(
            &storage,
            json!({"kind":"profile.readDrafts","windowId":window}),
        )
        .await;
        let values: Vec<_> = drafts["records"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["value"]["text"].as_str().unwrap())
            .collect();
        assert_eq!(values, ["legacy", text]);
    }
    let backup = request(&storage, json!({"kind":"backup","operationId":"backup"})).await;
    assert_eq!(
        backup,
        request(&storage, json!({"kind":"backup","operationId":"backup"})).await
    );
    let candidate = request(
        &storage,
        json!({"kind":"restoreBackup","operationId":"candidate","backupId":backup["backupId"]}),
    )
    .await;
    assert_eq!(backup["revision"], candidate["revision"]);
    assert_eq!(candidate["mediaCount"], 1);
    let candidate_root = root
        .join("restore-candidates")
        .join(candidate["candidateId"].as_str().unwrap());
    assert!(candidate_root.join("candidate.json").is_file());
    storage.close().await.unwrap();
    storage.close().await.unwrap();
    let restored_storage = Storage::open(candidate_root, "test-workspace".into(), false)
        .await
        .unwrap();
    assert_eq!(
        request(&restored_storage, json!({"kind":"getArtwork","id":"17"})).await["body"],
        restored["artwork"]["body"]
    );
    let read = request(
        &restored_storage,
        json!({"kind":"readMedia","alias":"test-original","offset":4,"length":7}),
    )
    .await;
    assert_eq!(
        STANDARD.decode(read["data"].as_str().unwrap()).unwrap(),
        bytes[4..11]
    );
    restored_storage.close().await.unwrap();
}

#[tokio::test]
async fn classified_migration_only_publishes_after_media_and_domain_verification() {
    let temp = tempfile::tempdir().unwrap();
    let storage = Storage::open(temp.path().join("candidate"), "migration-test".into(), true)
        .await
        .unwrap();
    let (bytes, mut media) = image();
    media["metadata"] = json!({});
    media["derived"] = json!(false);
    let record = json!({"source":"kv","key":"aics_pb_history","domain":"artwork","value":[{"id":"source","image_id":"test-original","unknown":true}]});
    let mut envelope = json!({"format":"huiyu-migration","version":1,"migrationId":"import-1","source":{"sourceProfileId":"test","origin":"https://example.test","windowIds":[]},"createdAt":100,"records":[{"id":"history","source":"kv","key":"aics_pb_history","domain":"artwork","sha256":fingerprint(&record)}],"media":[media],"blockers":[],"credentials":{"references":[],"verified":true}});
    envelope["fingerprint"] = json!(fingerprint(&envelope));
    request(
        &storage,
        json!({"kind":"migration.begin","operationId":"begin","envelope":envelope}),
    )
    .await;
    request(&storage,json!({"kind":"migration.record","operationId":"record","migrationId":"import-1","itemId":"history","record":record})).await;
    assert!(
        request(&storage, json!({"kind":"getArtwork","id":"source"}))
            .await
            .is_null()
    );
    let blocked = request(
        &storage,
        json!({"kind":"migration.verify","operationId":"verify-missing","migrationId":"import-1"}),
    )
    .await;
    assert_eq!(blocked["state"], "importing");
    assert!(!blocked["blockers"].as_array().unwrap().is_empty());
    request(&storage,json!({"kind":"migration.media","operationId":"media","migrationId":"import-1","alias":"test-original","offset":0,"data":STANDARD.encode(bytes)})).await;
    let verified = request(
        &storage,
        json!({"kind":"migration.verify","operationId":"verify","migrationId":"import-1"}),
    )
    .await;
    assert_eq!(verified["state"], "verified");
    assert_eq!(verified["importedRecords"], 1);
    assert_eq!(verified["importedMedia"], 1);
    assert_eq!(
        request(&storage, json!({"kind":"getArtwork","id":"source"})).await["body"]["unknown"],
        true
    );
    let activated=request(&storage,json!({"kind":"migration.activate","operationId":"activate","migrationId":"import-1","expectedFingerprint":envelope["fingerprint"]})).await;
    assert_eq!(activated["state"], "activated");
    storage.close().await.unwrap();
}
