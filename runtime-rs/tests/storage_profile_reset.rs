use huiyu_runtime::storage::Storage;
use serde_json::{Value, json};

async fn request(storage: &Storage, command: Value) -> Value {
    storage
        .request(command, "desktop:profile-reset-test")
        .await
        .unwrap()
}

async fn save_draft(storage: &Storage, operation: &str, key: &str, window: Option<&str>) {
    let mut command = json!({"kind":"profile.saveDraft","operationId":operation,
        "key":key,"value":operation,"expectedRevision":null,"expectedReset":""});
    if let Some(window) = window {
        command["windowId"] = window.into();
    }
    request(storage, command).await;
}

async fn drafts(storage: &Storage, window: &str) -> Vec<Value> {
    request(
        storage,
        json!({"kind":"profile.readDrafts","windowId":window}),
    )
    .await["records"]
        .as_array()
        .unwrap()
        .clone()
}

#[tokio::test]
async fn chat_reset_clears_all_chat_drafts_and_preserves_other_registered_drafts() {
    let temp = tempfile::tempdir().unwrap();
    let storage = Storage::open(
        temp.path().join("workspace"),
        "profile-reset-test".into(),
        true,
    )
    .await
    .unwrap();
    let main = json!({"histories":{"neutral":["old"]},"settings":{
        "model":"neutral-fixture","drafts":{"neutral":"old"}},"custom":"retained"});
    request(
        &storage,
        json!({"kind":"profile.saveChatRecord","operationId":"main",
        "key":"aics_chat_v1","value":main.to_string(),"expectedRevision":null,"expectedReset":""}),
    )
    .await;
    request(&storage, json!({"kind":"profile.saveChatRecord","operationId":"archive",
        "key":"aics_chat_archive_v1","value":"neutral archived text","expectedRevision":null,"expectedReset":""})).await;
    let windows = [
        None,
        Some("atelier"),
        Some("companion-chat"),
        Some("绘遇_%[测试]"),
    ];
    let model = "aics-model-draft-fixture:aics_chat_draft_v1:neutral";
    for (index, window) in windows.iter().enumerate() {
        save_draft(
            &storage,
            &format!("chat-{index}"),
            "aics_chat_draft_v1:neutral",
            *window,
        )
        .await;
        save_draft(
            &storage,
            &format!("video-{index}"),
            "aics_video_draft_v1",
            *window,
        )
        .await;
        save_draft(&storage, &format!("model-{index}"), model, *window).await;
        save_draft(
            &storage,
            &format!("queue-{index}"),
            "aics_sd_pending_queue_v1",
            *window,
        )
        .await;
    }
    let command =
        json!({"kind":"profile.resetChat","operationId":"reset-neutral","expectedReset":""});
    let reset = request(&storage, command.clone()).await;
    assert_eq!(
        request(&storage, command).await,
        reset,
        "The reset receipt remains idempotent"
    );
    assert_eq!(reset["resetRevision"], "reset-neutral");
    let records = reset["records"].as_array().unwrap();
    assert_eq!(
        records.len(),
        2,
        "Keep only the retained main record and reset identity"
    );
    let retained: Value = serde_json::from_str(
        records
            .iter()
            .find(|row| row["key"] == "aics_chat_v1")
            .unwrap()["value"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(retained["histories"], json!({}));
    assert_eq!(retained["settings"]["drafts"], json!({}));
    assert_eq!(retained["settings"]["model"], "neutral-fixture");
    assert_eq!(retained["custom"], "retained");
    for window in ["atelier", "companion-chat", "绘遇_%[测试]"] {
        let records = drafts(&storage, window).await;
        assert_eq!(
            records.len(),
            6,
            "Preserve the global and own video/model/queue drafts: {window}"
        );
        assert!(records.iter().all(|row| row["key"] == model
            || row["key"] == "aics_video_draft_v1"
            || row["key"] == "aics_sd_pending_queue_v1"));
        assert!(records.iter().any(|row| row["value"] == "model-0"));
        assert!(records.iter().any(|row| row["value"] == "queue-0"));
    }
    let stale = storage
        .request(
            json!({"kind":"profile.saveDraft","operationId":"stale-chat",
        "key":"aics_chat_draft_v1:neutral","value":"stale","expectedRevision":null,
        "expectedReset":"","windowId":"atelier"}),
            "desktop:profile-reset-test",
        )
        .await
        .unwrap_err();
    assert_eq!(stale.code, "PROFILE_RESET_CONFLICT");
    storage.close().await.unwrap();
}

#[tokio::test]
async fn model_drafts_obey_window_ownership_and_global_keys_keep_their_names() {
    let temp = tempfile::tempdir().unwrap();
    let storage = Storage::open(
        temp.path().join("workspace"),
        "profile-window-test".into(),
        true,
    )
    .await
    .unwrap();
    let key = "aics-model-draft-neutral";
    save_draft(&storage, "global", key, None).await;
    save_draft(&storage, "first-window", key, Some("绘遇_%[测试]")).await;
    save_draft(&storage, "other-window", key, Some("companion-chat")).await;
    for (window, own) in [
        ("绘遇_%[测试]", "first-window"),
        ("companion-chat", "other-window"),
    ] {
        let records = drafts(&storage, window).await;
        assert_eq!(records.len(), 2);
        assert!(records.iter().all(|row| row["key"] == key));
        assert!(records.iter().any(|row| row["value"] == "global"));
        assert!(records.iter().any(|row| row["value"] == own));
    }
    // A legal global chat key can start with the requested window's prefix.
    // Ownership must be determined before stripping a namespace from its name.
    save_draft(&storage, "global-chat", "aics_chat_draft_v1:neutral", None).await;
    let records = drafts(&storage, "aics_chat_draft_v1").await;
    assert_eq!(records.len(), 2);
    assert!(
        records
            .iter()
            .any(|row| row["key"] == "aics_chat_draft_v1:neutral")
    );
    storage.close().await.unwrap();
}
