use super::*;

#[test]
fn import_preserves_values_unknown_dates_and_summary_queries() {
    let (_temp, options, catalog) = fixture();
    let version = catalog.version().unwrap();
    catalog.connection.execute_batch(
        "DROP INDEX catalog_newest; CREATE INDEX catalog_recent ON content_records(kind,deleted,created_at,id)"
    ).unwrap();
    drop(catalog);
    let catalog = Catalog::open(options).unwrap();
    assert_eq!(catalog.version().unwrap(), version);
    let indexes: i64 = catalog.connection.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type='index' AND name IN ('catalog_recent','catalog_newest')",
        [], |row| row.get(0)
    ).unwrap();
    assert_eq!(indexes, 1);
    catalog
        .connection
        .prepare("SELECT id FROM content_records INDEXED BY catalog_newest")
        .unwrap();
    assert!(catalog.get("scene", "sc001").unwrap().created_at.is_none());
    assert_eq!(
        catalog.projection("scenes-index.json").unwrap().unwrap(),
        json!({"version":2,"total":2,"shards":{
            "nene":{"file":"scenes-nene.json","count":2},
            "natsume":{"file":"scenes-natsume.json","count":0},
            "shared":{"file":"scenes-shared.json","count":0}},
            "tiers":{"core":["sc002"]},"orderedIds":["sc001","sc002"],
            "metadata":{"sc001":{"sortOrder":1,"createdAt":null,"updatedAt":null},
                "sc002":{"sortOrder":2,"createdAt":null,"updatedAt":null}}})
    );
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
    blueprint.data =
        json!({"id":"bp_fixture","title":"角色蓝图","characterId":"nene","adult":false});
    write::put(&catalog.connection, &blueprint, false).unwrap();
    let media = catalog
        .query(&Query {
            kind: "media".into(),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(media["total"], 3);
    let media_items = media["items"].as_array().unwrap();
    assert!(
        media_items
            .iter()
            .any(|item| item["kind"] == "blueprint" && item["characterId"] == "nene")
    );
    assert!(media_items.iter().any(|item| item["kind"] == "scene"));
    assert!(media_items.iter().all(|item| item.get("data").is_none()));
    let mut character = catalog.get("character", "nene").unwrap();
    character.data["popular"] = json!({"id":"nene"});
    write::put(&catalog.connection, &character, false).unwrap();
    for (id, owner, order, deleted) in [
        ("nene/b", "nene", 2, false),
        ("nene/a", "nene", 2, false),
        ("nene/first", "nene", 1, false),
        ("other/a", "other", 0, false),
        ("nene/retired", "nene", 0, true),
    ] {
        let mut outfit = character.clone();
        outfit.kind = "outfit".into();
        outfit.id = id.into();
        outfit.sort_order = order;
        outfit.data = json!({"characterId":owner,"outfit":{"id":id}});
        write::put(&catalog.connection, &outfit, deleted).unwrap();
    }
    let bundle = catalog.character_bundle("nene").unwrap();
    assert_eq!(
        bundle["character"]["outfits"],
        json!([
            {"id":"nene/first"}, {"id":"nene/a"}, {"id":"nene/b"}
        ])
    );
    assert_eq!(bundle["blueprints"], json!([blueprint.data]));
    assert_eq!(bundle["profile"], character.data["profile"]);
    assert_eq!(
        catalog.projection("characters.json").unwrap().unwrap(),
        json!([bundle["profile"]])
    );
    assert_eq!(
        catalog
            .projection("popular-characters.json")
            .unwrap()
            .unwrap(),
        json!({"version":1,"characters":[bundle["character"]]})
    );
    assert_eq!(
        catalog
            .projection("scene-blueprints.json")
            .unwrap()
            .unwrap(),
        json!({"version":2,"blueprints":bundle["blueprints"]})
    );
    // Restore the fixture before exercising validated edits below.
    character.data.as_object_mut().unwrap().remove("popular");
    write::put(&catalog.connection, &character, false).unwrap();
    catalog
        .connection
        .execute("DELETE FROM content_records WHERE kind='outfit'", [])
        .unwrap();
    assert_eq!(catalog.next_scene_id().unwrap(), "sc006");
    let mut known_date = patch("scene", "sc001", 1, json!({"category":"room"}));
    known_date.created_at = Some("2026-10-03T22:25:25+08:00".into());
    let mut catalog = catalog;
    catalog.apply(&[known_date.clone()], true).unwrap();
    assert!(catalog.get("scene", "sc001").unwrap().created_at.is_none());
    catalog.apply(&[known_date], false).unwrap();
    let newest = catalog
        .query(&Query {
            kind: "scene".into(),
            sort: "newest".into(),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(newest["items"][0]["id"], "sc001");
    assert_eq!(newest["items"][1]["id"], "sc002");
    let query = Query {
        kind: "scene".into(),
        created_from: "2026-10-03T00:00:00+08:00".into(),
        created_to: "2026-10-04T00:00:00+08:00".into(),
        ..Default::default()
    };
    let dates = catalog.query(&query).unwrap();
    assert_eq!(dates["total"], 1);
    assert_eq!(dates["items"][0]["id"], "sc001");
    let filtered = catalog
        .query(&Query {
            search: " SC001 ".into(),
            character: "nene".into(),
            category: "room".into(),
            rating: "All".into(),
            page: Some(100),
            ..query
        })
        .unwrap();
    assert_eq!(filtered, dates);
    assert!(catalog.get("scene", "sc002").unwrap().created_at.is_none());
    let mut rewrite_date = patch("scene", "sc001", 2, json!({}));
    rewrite_date.created_at = Some("2026-10-04T00:00:00+00:00".into());
    assert!(catalog.apply(&[rewrite_date], false).is_err());
}
