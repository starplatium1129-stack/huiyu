use super::*;

#[test]
fn scene_shards_preserve_membership_order_and_metadata() {
    let (_temp, _options, catalog) = fixture();
    let template = catalog.get("scene", "sc001").unwrap();
    for (id, character, order, deleted) in [
        ("shared-b", "triad", 0, false),
        ("shared-a", "triad", 0, false),
        ("summer", "natsume", -1, false),
        ("retired", "triad", -2, true),
        ("1", "nene", 3, false),
    ] {
        let mut scene = template.clone();
        scene.id = id.into();
        scene.data["id"] = id.into();
        scene.data["char"] = character.into();
        scene.data["sortOrder"] = json!(999);
        scene.data["createdAt"] = json!("stale payload date");
        scene.sort_order = order;
        scene.updated_at = Some("2026-10-05T00:00:00Z".into());
        write::put(&catalog.connection, &scene, deleted).unwrap();
    }
    let mut curation = catalog.get("document", "curation").unwrap();
    curation.data["personaCoreSceneIds"] = json!(["shared-b", "sc002", "shared-a", "sc002", "missing", "retired", 1, null, {"id":"sc001"}]);
    write::put(&catalog.connection, &curation, false).unwrap();
    let all = catalog.projection("scenes.json").unwrap().unwrap();
    for (name, ids) in [
        (
            "scenes.json",
            json!(["summer", "shared-a", "shared-b", "sc001", "sc002", "1"]),
        ),
        ("scenes-shared.json", json!(["shared-a", "shared-b"])),
        ("scenes-nene.json", json!(["sc001", "sc002", "1"])),
        ("scenes-natsume.json", json!(["summer"])),
        ("scenes-core.json", json!(["shared-a", "shared-b", "sc002"])),
    ] {
        let shard = catalog.projection(name).unwrap().unwrap();
        assert_eq!(
            shard
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v["id"].clone())
                .collect::<Vec<_>>(),
            ids.as_array().unwrap().clone(),
            "{name}"
        );
        for scene in shard.as_array().unwrap() {
            assert_eq!(
                Some(scene),
                all.as_array()
                    .unwrap()
                    .iter()
                    .find(|v| v["id"] == scene["id"])
            );
        }
    }
    assert_eq!(all[1]["sortOrder"], 0);
    assert_eq!(all[1]["createdAt"], Value::Null);
    assert_eq!(all[1]["updatedAt"], "2026-10-05T00:00:00Z");
    assert_eq!(all[1]["extension"], template.data["extension"]);
    for empty_core in [json!([]), Value::Null] {
        curation.data["personaCoreSceneIds"] = empty_core;
        write::put(&catalog.connection, &curation, false).unwrap();
        assert_eq!(
            catalog.projection("scenes-core.json").unwrap().unwrap(),
            json!([])
        );
    }
}
