use huiyu_runtime::storage::Storage;
use serde_json::{Value, json};

async fn request(storage: &Storage, command: Value) -> Value {
    storage
        .request(command, "desktop:batch-plan-test")
        .await
        .unwrap()
}

#[tokio::test]
async fn batch_planning_survives_reopen_and_keeps_window_ownership() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("workspace");
    let storage = Storage::open(root.clone(), "batch-plan-test".into(), true)
        .await
        .unwrap();
    for (operation, window, key) in [
        ("atelier-plan", "atelier", "atelier-request"),
        ("companion-plan", "companion", "companion-request"),
    ] {
        request(&storage, json!({"kind":"profile.saveDraft","operationId":operation,
            "key":"aics_pb_batch_plan_v1","windowId":window,"expectedRevision":null,"expectedReset":"",
            "value":{"version":1,"jobs":[{"requestKey":key,"status":"unknown"}]}})).await;
    }
    request(
        &storage,
        json!({"kind":"profile.saveSetting","operationId":"layout",
        "key":"aics_director_layout_v1","expectedRevision":null,"value":{"rightHidden":true}}),
    )
    .await;
    let filters = json!({"fixture":{"name":"Anima 收藏","filters":{"favoriteOnly":true,
        "projectFilter":"","searchQuery":"","tagFilter":"","generation":{"engine":"v:anima",
        "model":"","outfit":"","seed":"v:0","size":"","reviewState":""}}}});
    request(
        &storage,
        json!({"kind":"profile.saveSetting","operationId":"gallery-filters",
        "key":"aics_gallery_filter_presets_v1","expectedRevision":null,"value":filters}),
    )
    .await;
    storage.close().await.unwrap();
    let reopened = Storage::open(root, "batch-plan-test".into(), false)
        .await
        .unwrap();
    for (window, key) in [
        ("atelier", "atelier-request"),
        ("companion", "companion-request"),
    ] {
        let drafts = request(
            &reopened,
            json!({"kind":"profile.readDrafts","windowId":window}),
        )
        .await;
        assert_eq!(drafts["records"].as_array().unwrap().len(), 1);
        assert_eq!(drafts["records"][0]["key"], "aics_pb_batch_plan_v1");
        assert_eq!(drafts["records"][0]["value"]["jobs"][0]["requestKey"], key);
    }
    let settings = request(&reopened, json!({"kind":"profile.readSettings"})).await;
    assert_eq!(settings["records"][0]["key"], "aics_director_layout_v1");
    assert_eq!(settings["records"][0]["value"]["rightHidden"], true);
    let preset = settings["records"]
        .as_array()
        .unwrap()
        .iter()
        .find(|record| record["key"] == "aics_gallery_filter_presets_v1")
        .unwrap();
    assert_eq!(preset["value"], filters);
    reopened.close().await.unwrap();
}
