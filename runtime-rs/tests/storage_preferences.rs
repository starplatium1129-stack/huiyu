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
            "sceneTitle":"Garden","scene":"sc001","character":"nene","story":"moonlight\u{0000}静かな庭","project":"美術",
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
    let search = read(
        &storage,
        json!({"kind":"searchArtworks","terms":["garden"]}),
    )
    .await;
    assert_eq!(
        search["artworkRevision"],
        read(&storage, json!({"kind":"status"})).await["artworkRevision"]
    );
    let items = search["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["id"], 1);
    assert_eq!(items[0]["title"], json!({"future":"title"}));
    assert_eq!(items[0]["timestamp"], 101);
    assert_eq!(items[1]["timestamp"], "Fri, 01 Jan 2021 00:00:00 GMT");
    assert!(items.iter().all(|item| item.get("searchText").is_none()
        && item.get("prompt").is_none()
        && item.get("image_data").is_none()));
    assert!(serde_json::to_vec(&search).unwrap().len() < 1024);
    let unicode = read(
        &storage,
        json!({"kind":"searchArtworks","terms":["σος", "i\u{0307}", "ß", "美術"]}),
    )
    .await;
    assert_eq!(unicode["items"].as_array().unwrap().len(), 1);
    assert_eq!(unicode["items"][0]["id"], 2);
    assert_eq!(
        read(
            &storage,
            json!({"kind":"searchArtworks","terms":["moonlight\u{0000}静かな庭"]})
        )
        .await["items"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
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
    let unchanged = read(
        &storage,
        json!({"kind":"searchArtworks","terms":["garden"]}),
    )
    .await;
    let status = read(&storage, json!({"kind":"status"})).await;
    read(&storage, json!({"kind":"profile.saveSetting","operationId":"theme","key":"aics_theme","value":"dark","expectedRevision":null})).await;
    let changed = read(&storage, json!({"kind":"status"})).await;
    assert_ne!(status["revision"], changed["revision"]);
    assert_eq!(status["artworkRevision"], changed["artworkRevision"]);
    assert_eq!(
        unchanged,
        read(
            &storage,
            json!({"kind":"searchArtworks","terms":["garden"]})
        )
        .await
    );
    storage.close().await.unwrap();
}

#[tokio::test]
async fn search_pages_keep_legacy_dates_and_bound_numeric_results_across_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("workspace");
    let storage = Storage::open(root.clone(), "search-pages".into(), true)
        .await
        .unwrap();
    storage.close().await.unwrap();
    let mut db = rusqlite::Connection::open(root.join("huiyu.sqlite3")).unwrap();
    // Simulate an existing v3 database before the additive read index existed.
    db.execute_batch("DROP TRIGGER artwork_read_insert; DROP TRIGGER artwork_read_update; DROP TRIGGER artwork_read_delete;
        DROP TABLE artwork_read_index; DROP TABLE artwork_read_dirty;
        DROP TABLE artwork_search_fts; DROP TABLE artwork_search_chars; DROP TABLE artwork_search_dirty;
        DELETE FROM meta WHERE key IN ('artworkRevision','artworkReadIndexVersion','artworkSearchIndexVersion');").unwrap();
    let transaction = db.transaction().unwrap();
    for index in 0..245 {
        let id = format!("item-{index:03}");
        let timestamp = if index < 40 {
            json!(index as f64 + 0.5)
        } else {
            json!("January 1, 2020")
        };
        transaction.execute("INSERT INTO artworks VALUES(?1,?2,?3,1,NULL)", rusqlite::params![id,serde_json::to_string(&id).unwrap(),
            json!({"id":id,"timestamp":timestamp,"title":"Night room","prompt":if index==0 {"blue flower CAFÉ \"静かな庭\" a\u{0000}b"} else {"blue flower"}}).to_string()]).unwrap();
    }
    transaction
        .execute("UPDATE meta SET value='1' WHERE key='revision'", [])
        .unwrap();
    transaction.commit().unwrap();
    drop(db);
    let storage = Storage::open(root.clone(), "search-pages".into(), false)
        .await
        .unwrap();
    let page = read(
        &storage,
        json!({"kind":"searchArtworks","terms":["night","flower"]}),
    )
    .await;
    assert_eq!(page["items"].as_array().unwrap().len(), 205);
    assert_eq!(page["items"][0]["id"], "item-039");
    assert_eq!(page["items"][4]["id"], "item-035");
    let next = read(
        &storage,
        json!({"kind":"searchArtworks","terms":["night","flower"],"cursor":page["nextCursor"]}),
    )
    .await;
    assert_eq!(next["items"].as_array().unwrap().len(), 5);
    assert_eq!(next["items"][0]["id"], "item-240");
    assert!(next["nextCursor"].is_null());
    assert_eq!(page["artworkRevision"], next["artworkRevision"]);
    // Exercise the indexed path after its independent warmup, not only the
    // correct linear fallback that answers the first request immediately.
    let reader = rusqlite::Connection::open(root.join("huiyu.sqlite3")).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while reader
            .query_row("SELECT count(*) FROM artwork_search_dirty", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap()
            > 0
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    drop(reader);
    for term in [
        "café",
        "静かな庭",
        "\"静か",
        "a\u{0000}b",
        "fé",
        "かな",
        "庭",
    ] {
        let found = read(&storage, json!({"kind":"searchArtworks","terms":[term]})).await;
        assert_eq!(found["items"].as_array().unwrap().len(), 1, "{term:?}");
        assert_eq!(found["items"][0]["id"], "item-000");
    }
    assert!(
        read(&storage, json!({"kind":"searchArtworks","terms":["な静"]})).await["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        read(
            &storage,
            json!({"kind":"searchArtworks","terms":["flower","flown"]})
        )
        .await["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    read(&storage, json!({"kind":"patchArtwork","id":"item-000","expectedRevision":1,"operationId":"replace-search-text","patch":{"prompt":"blue flower only"}})).await;
    assert!(
        read(&storage, json!({"kind":"searchArtworks","terms":["café"]})).await["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        read(
            &storage,
            json!({"kind":"searchArtworks","terms":["no match"]})
        )
        .await["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    // A completed derived index survives reopen and a source deletion invalidates
    // it transactionally, without replaying the full build or changing authority.
    storage.close().await.unwrap();
    let db = rusqlite::Connection::open(root.join("huiyu.sqlite3")).unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM artwork_read_dirty", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    db.execute("DELETE FROM artworks WHERE id_key='item-039'", [])
        .unwrap();
    drop(db);
    let storage = Storage::open(root, "search-pages".into(), false)
        .await
        .unwrap();
    let updated = read(
        &storage,
        json!({"kind":"searchArtworks","terms":["night","flower"]}),
    )
    .await;
    assert_eq!(updated["items"][0]["id"], "item-038");
    assert_ne!(page["artworkRevision"], updated["artworkRevision"]);
    storage.close().await.unwrap();
}
