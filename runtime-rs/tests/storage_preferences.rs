use base64::{Engine, engine::general_purpose::STANDARD};
use huiyu_runtime::storage::Storage;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
async fn read(storage: &Storage, command: Value) -> Value {
    storage
        .request(command, "desktop:preference-test")
        .await
        .unwrap()
}
#[tokio::test]
async fn preference_projection_preserves_paging_types_and_revision_without_large_fields() {
    let temp = tempfile::tempdir().unwrap();
    let storage = Storage::open(
        temp.path().join("workspace"),
        "preference-test".into(),
        true,
    )
    .await
    .unwrap();
    let bytes = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=").unwrap();
    for id in 1..=3 {
        let operation = format!("add-{id}");
        read(&storage, json!({"kind":"prepareSave","operationId":operation,"artwork":{
            "id":id,"title":if id==1 {json!({"future":"title"})} else {json!("ΣΟΣ İ ẞ")},
            "sceneTitle":"Garden","scene":"sc001","character":"nene","story":"moonlight","project":"美術",
            "favorite":id==1,"timestamp":if id==2 {json!("Fri, 01 Jan 2021 00:00:00 GMT")} else {json!(100+id)},
            "prompt":"x".repeat(256*1024),"image_data":"unrelated legacy image".repeat(1024)
        },"media":{"alias":format!("image-{id}"),"sha256":hex::encode(Sha256::digest(&bytes)),"bytes":bytes.len(),"mime":"image/png"}})).await;
        read(&storage, json!({"kind":"uploadChunk","operationId":operation,"offset":0,"data":STANDARD.encode(&bytes)})).await;
        read(
            &storage,
            json!({"kind":"commitSave","operationId":operation}),
        )
        .await;
    }
    let row = read(&storage, json!({"kind":"getArtwork","id":3})).await;
    read(&storage, json!({"kind":"softDeleteArtwork","operationId":"delete-3","id":3,"expectedRevision":row["revision"]})).await;
    let full = read(&storage, json!({"kind":"listArtworks"})).await;
    let full_page = read(&storage, json!({"kind":"listArtworks","limit":1})).await;
    let first = read(
        &storage,
        json!({"kind":"listArtworks","projection":"preference","limit":1}),
    )
    .await;
    let next = read(&storage, json!({"kind":"listArtworks","projection":"preference","limit":1,"cursor":first["nextCursor"]})).await;
    assert_eq!(
        first["items"][0]["body"],
        json!({"id":1,"scene":"sc001","character":"nene","favorite":true,"timestamp":101})
    );
    assert_eq!(next["items"][0]["body"]["favorite"], false);
    assert!(next["nextCursor"].is_null());
    assert_eq!(first["revision"], full["revision"]);
    assert_eq!(next["revision"], full["revision"]);
    assert!(serde_json::to_vec(&first).unwrap().len() < 1024);
    assert!(serde_json::to_vec(&full).unwrap().len() > 500_000);
    let search = read(&storage, json!({"kind":"readArtworkSearchIndex"})).await;
    assert_eq!(search["revision"], full["revision"]);
    let items = search["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["id"], 1);
    assert_eq!(items[0]["title"], json!({"future":"title"}));
    assert_eq!(items[0]["timestamp"], 101);
    assert_eq!(items[1]["timestamp"], "Fri, 01 Jan 2021 00:00:00 GMT");
    assert!(
        items[0]["searchText"]
            .as_str()
            .unwrap()
            .starts_with("garden sc001 nene moonlight 美術 ")
    );
    assert!(
        items[1]["searchText"]
            .as_str()
            .unwrap()
            .starts_with("σος i\u{0307} ß garden")
    );
    assert!(
        items
            .iter()
            .all(|item| item.get("prompt").is_none() && item.get("image_data").is_none())
    );
    assert!(items[1]["searchText"].as_str().unwrap().len() > 256_000);
    let recent = read(&storage, json!({"kind":"readArtworkRecentIndex"})).await;
    assert_eq!(recent["revision"], full["revision"]);
    assert_eq!(recent["items"].as_array().unwrap().len(), 2);
    for (index, expected_id) in [1, 2].iter().enumerate() {
        let item = &recent["items"][index];
        let complete = read(&storage, json!({"kind":"getArtwork","id":expected_id})).await;
        assert_eq!(
            item,
            &json!({"id":expected_id,"timestamp":complete["body"]["timestamp"],"revision":complete["revision"]})
        );
    }
    assert!(serde_json::to_vec(&recent).unwrap().len() < 512);
    let deleted = read(&storage, json!({"kind":"getArtwork","id":3})).await;
    read(&storage, json!({"kind":"restoreArtwork","operationId":"restore-3","id":3,"expectedRevision":deleted["revision"]})).await;
    let candidates = read(
        &storage,
        json!({"kind":"readArtworkRecentIndex","candidateLimit":1}),
    )
    .await;
    assert_eq!(
        candidates["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["id"].clone())
            .collect::<Vec<_>>(),
        vec![json!(2), json!(3)]
    );
    assert_eq!(
        candidates["items"][0]["timestamp"],
        "Fri, 01 Jan 2021 00:00:00 GMT"
    );
    let restored = read(&storage, json!({"kind":"getArtwork","id":3})).await;
    read(&storage, json!({"kind":"patchArtwork","operationId":"tie-3","id":3,"expectedRevision":restored["revision"],"patch":{"timestamp":101}})).await;
    let legacy = read(&storage, json!({"kind":"getArtwork","id":2})).await;
    read(&storage, json!({"kind":"patchArtwork","operationId":"legacy-2","id":2,"expectedRevision":legacy["revision"],"patch":{"timestamp":"invalid"}})).await;
    let tied = read(
        &storage,
        json!({"kind":"readArtworkRecentIndex","candidateLimit":1}),
    )
    .await;
    assert_eq!(
        tied["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["id"].clone())
            .collect::<Vec<_>>(),
        vec![json!(1), json!(2)]
    );
    assert_eq!(tied["items"][1]["timestamp"], "invalid");

    assert!(
        read(&storage, json!({"kind":"getArtwork","id":"missing"}))
            .await
            .is_null()
    );
    assert_eq!(
        read(&storage, json!({"kind":"getArtwork","id":"1"})).await["id"],
        1
    );
    assert!(
        storage
            .request(
                json!({"kind":"listArtworks","projection":"unknown"}),
                "desktop:preference-test"
            )
            .await
            .is_err()
    );
    println!(
        "preference-projection fullBytes={} pageBytes={}",
        serde_json::to_vec(&full_page).unwrap().len(),
        serde_json::to_vec(&first).unwrap().len()
    );
    storage.close().await.unwrap();
}
