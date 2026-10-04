use super::*;
fn fixture() -> (tempfile::TempDir, Options, Catalog) {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("app");
    let directory = source.join("data/catalog");
    std::fs::create_dir_all(&directory).unwrap();
    let scene = |id: &str| json!({"id":id,"title":id,"story":"A quiet room.","char":"nene","rating":"All","mature":false,"prompt":"a quiet room","negative":"text","animaCaption":"A quiet room.","recommendedSize":"1024x1024","tags":["old"],"extension":{"preserved":[1,2]}});
    let pins = json!({"scenes":{"sc001":scene("sc001")}});
    let data = vec![
        (
            "character",
            "nene",
            json!({"id":"nene","profile":{"id":"nene","name":"Nene","lora":{"recommended_scene":["sc002"]}}}),
        ),
        ("scene", "sc001", scene("sc001")),
        ("scene", "sc002", scene("sc002")),
        ("document", "prompt-pinned-scenes", pins.clone()),
        (
            "document",
            "curation",
            json!({"curatedSceneIds":["sc002"],"signatureSceneIds":[],"reviewSceneIds":[],"personaCoreSceneIds":["sc002"],"recommendationReasons":{"sc002":"quiet"}}),
        ),
        (
            "document",
            "retired-scenes",
            json!({"records":[{"id":"sc005"}]}),
        ),
        (
            "document",
            "tags",
            json!([{"id":"tag_001","cat":"Scene","en":"old","cn":"旧","weight":1}]),
        ),
        (
            "document",
            "loras",
            json!([{"id":"lora","related_scenes":["sc002"]}]),
        ),
        ("document", "tag-dictionary-policy", json!({})),
    ];
    let mut files = Vec::new();
    for (index, (kind, id, data)) in data.into_iter().enumerate() {
        let record = Record {
            kind: kind.into(),
            id: id.into(),
            revision: 1,
            sort_order: index as i64,
            created_at: None,
            updated_at: None,
            data,
        };
        let file = format!("{index}.json");
        std::fs::write(directory.join(&file), serde_json::to_vec(&record).unwrap()).unwrap();
        files.push(file);
    }
    std::fs::write(
        directory.join("manifest.json"),
        json!({"version":1,"files":files}).to_string(),
    )
    .unwrap();
    std::fs::write(
        source.join("data/prompt-pinned-scenes.json"),
        pins.to_string(),
    )
    .unwrap();
    let options = Options {
        source,
        database: temp.path().join("runtime/content/catalog.sqlite"),
    };
    let catalog = Catalog::open(options.clone()).unwrap();
    (temp, options, catalog)
}
fn patch(kind: &str, id: &str, revision: i64, value: Value) -> Change {
    Change {
        kind: kind.into(),
        id: id.into(),
        expected_revision: revision,
        data: None,
        patch: Some(value),
        sort_order: None,
        remove: false,
    }
}
#[test]
fn import_preserves_values_unknown_dates_and_summary_queries() {
    let (_temp, _options, catalog) = fixture();
    assert!(catalog.get("scene", "sc001").unwrap().created_at.is_none());
    assert_eq!(
        catalog.get("scene", "sc001").unwrap().data["extension"],
        json!({"preserved":[1,2]})
    );
    let value = catalog
        .query(&Query {
            kind: "scene".into(),
            page_size: Some(1),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(value["total"], 2);
    assert_eq!(value["items"].as_array().unwrap().len(), 1);
    assert!(value["items"][0].get("data").is_none());
    let mut blueprint = catalog.get("scene", "sc001").unwrap();
    blueprint.kind = "blueprint".into();
    blueprint.id = "bp_fixture".into();
    blueprint.data = json!({"id":"bp_fixture","title":"角色蓝图","characterId":"nene","adult":false});
    write::put(&catalog.connection, &blueprint, false).unwrap();
    let media = catalog.query(&Query { kind:"media".into(), ..Default::default() }).unwrap();
    assert_eq!(media["total"], 3);
    let media_items = media["items"].as_array().unwrap();
    assert!(media_items.iter().any(|item| item["kind"] == "blueprint" && item["characterId"] == "nene"));
    assert!(media_items.iter().any(|item| item["kind"] == "scene"));
    assert!(media_items.iter().all(|item| item.get("data").is_none()));
    assert_eq!(catalog.next_scene_id().unwrap(), "sc006");
}
#[test]
fn unrelated_edits_merge_but_stale_records_rollback_the_entire_batch() {
    let (_temp, _options, mut catalog) = fixture();
    catalog
        .apply(&[patch("scene", "sc002", 1, json!({"title":"B"}))], false)
        .unwrap();
    catalog
        .apply(&[patch("scene", "sc001", 1, json!({"title":"A"}))], false)
        .unwrap();
    assert_eq!(
        catalog
            .apply(
                &[
                    patch("scene", "sc001", 2, json!({"title":"must rollback"})),
                    patch("scene", "sc002", 1, json!({"title":"stale"}))
                ],
                false
            )
            .unwrap_err()
            .code,
        "CATALOG_CONFLICT"
    );
    assert_eq!(catalog.get("scene", "sc001").unwrap().data["title"], "A");
    assert_eq!(
        catalog.history("scene", "sc001").unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}
#[test]
fn previews_leave_no_history_and_pins_and_relationships_remain_enforced() {
    let (_temp, _options, mut catalog) = fixture();
    let before = catalog.snapshot().unwrap();
    catalog
        .apply(
            &[patch("scene", "sc001", 1, json!({"title":"preview"}))],
            true,
        )
        .unwrap();
    assert_eq!(catalog.snapshot().unwrap(), before);
    assert_eq!(
        catalog.history("scene", "sc001").unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(
        catalog
            .apply(
                &[patch("scene", "sc001", 1, json!({"prompt":"unapproved"}))],
                false
            )
            .is_err()
    );
    assert!(
        catalog
            .apply(
                &[patch("scene", "sc002", 1, json!({"char":"missing"}))],
                false
            )
            .is_err()
    );
    assert_eq!(catalog.snapshot().unwrap(), before);
}
#[test]
fn tag_renames_and_scene_retirement_keep_all_references_in_one_transaction() {
    let (_temp, _options, mut catalog) = fixture();
    let tags = json!([{"id":"tag_001","cat":"Scene","en":"new","cn":"新","weight":1}]);
    catalog
        .apply(
            &[Change {
                kind: "document".into(),
                id: "tags".into(),
                expected_revision: 1,
                data: Some(tags),
                patch: None,
                sort_order: None,
                remove: false,
            }],
            false,
        )
        .unwrap();
    assert_eq!(
        catalog.get("scene", "sc002").unwrap().data["tags"],
        json!(["new"])
    );
    catalog
        .apply(
            &[Change {
                kind: "scene".into(),
                id: "sc002".into(),
                expected_revision: 2,
                data: None,
                patch: None,
                sort_order: None,
                remove: true,
            }],
            false,
        )
        .unwrap();
    assert_eq!(
        catalog.document("curation").unwrap()["curatedSceneIds"],
        json!([])
    );
    assert_eq!(
        catalog.document("loras").unwrap()[0]["related_scenes"],
        json!([])
    );
    assert_eq!(
        catalog.get("character", "nene").unwrap().data["profile"]["lora"]["recommended_scene"],
        json!([])
    );
    assert!(catalog.get("scene", "sc002").is_err());
    assert!(
        catalog
            .apply(
                &[patch("scene", "sc002", 0, json!({"title":"reuse"}))],
                false
            )
            .is_err()
    );
}
#[test]
fn snapshot_import_preserves_local_edits_and_exports_restore_current_and_retired_records() {
    let (temp, _options, mut catalog) = fixture();
    let original = catalog.snapshot().unwrap();
    catalog
        .apply(
            &[patch("scene", "sc002", 1, json!({"title":"local"}))],
            false,
        )
        .unwrap();
    let mut incoming = original.clone();
    incoming["records"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|v| v["kind"] == "scene" && v["id"] == "sc002")
        .unwrap()["data"]["title"] = "upstream".into();
    assert_eq!(
        catalog.import(&incoming, false).unwrap_err().code,
        "CATALOG_IMPORT_CONFLICT"
    );
    catalog.import(&original, false).unwrap();
    assert_eq!(
        catalog.get("scene", "sc002").unwrap().data["title"],
        "local"
    );
    catalog
        .apply(
            &[Change {
                kind: "scene".into(),
                id: "sc002".into(),
                expected_revision: 2,
                data: None,
                patch: None,
                sort_order: None,
                remove: true,
            }],
            false,
        )
        .unwrap();
    let target = temp.path().join("restored/data/catalog");
    catalog.export(&target).unwrap();
    let restored = Catalog::open(Options {
        source: temp.path().join("restored"),
        database: temp.path().join("restored-runtime/catalog.sqlite"),
    })
    .unwrap();
    assert_eq!(restored.snapshot().unwrap(), catalog.snapshot().unwrap());
    assert!(restored.get("scene", "sc002").is_err());
}
#[test]
fn activated_store_never_silently_reseeds_a_missing_database() {
    let (_temp, options, catalog) = fixture();
    drop(catalog);
    std::fs::remove_file(&options.database).unwrap();
    assert_eq!(
        Catalog::open(options).err().unwrap().code,
        "CATALOG_MISSING"
    );
}
