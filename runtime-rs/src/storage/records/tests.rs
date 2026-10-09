use super::*;

#[test]
fn list_artwork_revision_ignores_empty_maintenance_but_tracks_artwork_writes() {
    let directory = tempfile::tempdir().unwrap();
    let mut c = schema::open(
        directory.path().join("workspace"),
        "list-test".into(),
        "epoch".into(),
        true,
    )
    .unwrap();
    let revision = c.next_revision().unwrap();
    c.db.execute(
        "INSERT INTO artworks VALUES(?,?,?, ?,NULL)",
        params![
            "one",
            "\"one\"",
            "{\"id\":\"one\",\"title\":\"before\"}",
            revision
        ],
    )
    .unwrap();
    let command = json!({"kind":"listArtworks"});
    let before = c.execute(&command, "test").unwrap();
    c.execute(
        &json!({"kind":"purgeExpiredTrash","operationId":"empty-cleanup"}),
        "test",
    )
    .unwrap();
    let maintained = c.execute(&command, "test").unwrap();
    assert_eq!(maintained["items"], before["items"]);
    assert_eq!(maintained["artworkRevision"], before["artworkRevision"]);
    assert!(maintained["revision"].as_i64() > before["revision"].as_i64());
    c.execute(&json!({"kind":"patchArtwork","operationId":"patch-one","id":"one","expectedRevision":revision,"patch":{"title":"after"}}), "test").unwrap();
    let changed = c.execute(&command, "test").unwrap();
    assert!(changed["artworkRevision"].as_i64() > maintained["artworkRevision"].as_i64());
    assert_eq!(changed["items"][0]["id"], "one");
    assert_eq!(changed["items"][0]["body"]["title"], "after");
    c.shutdown().unwrap();
}

#[test]
fn batch_reads_honor_cancellation_before_deserializing_rows() {
    let (_directory, mut c) = fixture();
    c.db.execute(
        "INSERT INTO projects VALUES(?,?,?,?)",
        params!["project", "\"project\"", "{}", 1],
    )
    .unwrap();
    for command in [
        json!({"kind":"getArtworks","ids":["restored","missing","restored","other"]}),
        json!({"kind":"listArtworks","limit":1}),
        json!({"kind":"listProjects"}),
    ] {
        c.cancel.store(true, Ordering::Relaxed);
        assert_eq!(read(&c, &command).unwrap_err().code, "CANCELLED");
        c.cancel.store(false, Ordering::Relaxed);
        let result = read(&c, &command).unwrap();
        if command["kind"] == "getArtworks" {
            assert_eq!(result.as_array().unwrap().len(), 4);
            assert_eq!(result[0]["id"], "restored");
            assert!(result[1].is_null());
            assert_eq!(result[2], result[0]);
            assert_eq!(result[3]["id"], "other");
        }
    }
    c.shutdown().unwrap();
}

fn fixture() -> (tempfile::TempDir, Context) {
    let directory = tempfile::tempdir().unwrap();
    let c = schema::open(
        directory.path().join("workspace"),
        "trash-test".into(),
        "epoch".into(),
        true,
    )
    .unwrap();
    for (key, deleted_at) in [
        ("selected", Some(10)),
        ("newer", Some(20)),
        ("restored", None),
        ("other", Some(10)),
    ] {
        let body = json!({"id":key,"prompt":"neutral fixture"});
        c.db.execute(
            "INSERT INTO artworks VALUES(?,?,?,1,?)",
            params![key, stringify(&body["id"]), stringify(&body), deleted_at],
        )
        .unwrap();
        if let Some(time) = deleted_at {
            c.db.execute(
                "INSERT INTO trash VALUES(?,?,?,?)",
                params![key, time, stringify(&body), "[]"],
            )
            .unwrap();
        }
    }
    (directory, c)
}

#[test]
fn manual_purge_is_confirmed_scoped_and_replays_its_receipt() {
    let (_directory, mut c) = fixture();
    let command = json!({"kind":"purgeTrash","operationId":"manual-clear","entries":[
        {"id":"selected","deletedAt":10},{"id":"newer","deletedAt":10},
        {"id":"restored","deletedAt":10},{"id":"missing","deletedAt":10}
    ]});
    let result = c.execute(&command, "test").unwrap();
    assert_eq!(result["purged"], 1);
    assert!(artwork(&c, "selected").unwrap().is_none());
    for key in ["newer", "restored", "other"] {
        assert!(artwork(&c, key).unwrap().is_some());
    }
    assert_eq!(c.execute(&command, "test").unwrap(), result);
}

#[test]
fn duplicate_or_oversized_purge_cannot_partially_remove_tombstones() {
    let (_directory, mut c) = fixture();
    let entry = json!({"id":"selected","deletedAt":10});
    for (operation, entries) in [
        ("duplicate", vec![entry.clone(), entry.clone()]),
        ("oversized", vec![entry; 201]),
    ] {
        let command = json!({"kind":"purgeTrash","operationId":operation,"entries":entries});
        assert!(c.execute(&command, "test").is_err());
        assert!(artwork(&c, "selected").unwrap().is_some());
        assert_eq!(
            c.db.query_row("SELECT COUNT(*) FROM trash", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            3
        );
    }
}

fn smart_rule() -> Value {
    json!({"characterId":"custom-role","tags":["和服"],"tagMatch":"all","favoriteOnly":true,"search":"","projectId":""})
}

#[test]
fn smart_albums_round_trip_replay_edit_and_delete_without_changing_artwork_or_media() {
    let (_directory, mut c) = fixture();
    let manual = json!({"id":7,"title":"手动","history_ids":[],"custom":"retained"});
    c.db.execute(
        "INSERT INTO projects VALUES('7','7',?,1)",
        [stringify(&manual)],
    )
    .unwrap();
    c.db.execute(
        "INSERT INTO media_objects VALUES('fixture-hash',10,'image/png')",
        [],
    )
    .unwrap();
    c.db.execute(
        "INSERT INTO media_aliases VALUES('fixture-image','fixture-hash')",
        [],
    )
    .unwrap();
    c.db.execute(
        "INSERT INTO media_refs VALUES('artwork','restored','fixture-hash')",
        [],
    )
    .unwrap();
    let history =
        read(&c, &json!({"kind":"listArtworks","includeDeleted":true})).unwrap()["items"].clone();
    let create = json!({"kind":"saveProject","operationId":"smart-create","project":{
        "id":"smart-one","title":" 和服收藏 ","smartRule":smart_rule(),"custom":{"retained":true}},
        "artworkIds":[],"expectedRevision":null});
    let created = c.execute(&create, "test").unwrap();
    assert_eq!(created["project"]["body"]["title"], "和服收藏");
    assert_eq!(created["project"]["body"]["smartRule"], smart_rule());
    assert_eq!(created["project"]["body"]["history_ids"], json!([]));
    assert_eq!(c.execute(&create, "test").unwrap(), created);
    let mut updated_rule = smart_rule();
    updated_rule["tagMatch"] = "any".into();
    updated_rule["tags"] = json!(["海边"]);
    updated_rule["projectId"] = "7".into();
    let update = json!({"kind":"saveProject","operationId":"smart-update","project":{
        "id":"smart-one","title":"海边精选","smartRule":updated_rule},"artworkIds":[],
        "expectedRevision":created["project"]["revision"]});
    let updated = c.execute(&update, "test").unwrap();
    assert_eq!(
        updated["project"]["body"]["custom"],
        json!({"retained":true})
    );
    assert_eq!(updated["project"]["body"]["smartRule"], updated_rule);
    let mut stale = update.clone();
    stale["operationId"] = "stale-update".into();
    assert_eq!(
        c.execute(&stale, "test").unwrap_err().code,
        "REVISION_CONFLICT"
    );
    let delete = json!({"kind":"deleteSmartAlbum","operationId":"smart-delete","id":"smart-one",
        "expectedRevision":updated["project"]["revision"]});
    let deleted = c.execute(&delete, "test").unwrap();
    assert_eq!(deleted["deleted"], true);
    assert_eq!(c.execute(&delete, "test").unwrap(), deleted);
    assert!(project(&c, "smart-one").unwrap().is_none());
    assert_eq!(project(&c, "7").unwrap().unwrap()["body"], manual);
    assert_eq!(
        read(&c, &json!({"kind":"listArtworks","includeDeleted":true})).unwrap()["items"],
        history
    );
    for table in ["media_objects", "media_aliases", "media_refs"] {
        assert_eq!(
            c.db.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    c.shutdown().unwrap();
}

#[test]
fn smart_album_validation_rejects_manual_membership_replacement_and_recursive_rules() {
    let (_directory, mut c) = fixture();
    let save = json!({"kind":"saveProject","operationId":"smart-valid","project":{
        "id":"smart-one","title":"智能","smartRule":smart_rule()},"artworkIds":[],"expectedRevision":null});
    let receipt = c.execute(&save, "test").unwrap();
    let mut membership = save.clone();
    membership["project"]["id"] = "with-members".into();
    membership["operationId"] = "smart-members".into();
    membership["artworkIds"] = json!(["restored"]);
    assert!(c.execute(&membership, "test").is_err());
    let mut recursive = save.clone();
    recursive["operationId"] = "recursive".into();
    recursive["project"]["id"] = "smart-two".into();
    recursive["project"]["smartRule"]["projectId"] = "smart-one".into();
    assert!(c.execute(&recursive, "test").is_err());
    recursive["project"]["smartRule"]["projectId"] = "smart-two".into();
    assert!(c.execute(&recursive, "test").is_err());
    let mut malformed = save.clone();
    malformed["operationId"] = "malformed".into();
    malformed["project"]["id"] = "malformed".into();
    malformed["project"]["smartRule"]["favoriteOnly"] = "yes".into();
    assert!(c.execute(&malformed, "test").is_err());
    let mut replace = json!({"kind":"saveProject","operationId":"replace-smart","project":{
        "id":"smart-one","title":"手动"},"artworkIds":[],"expectedRevision":receipt["project"]["revision"]});
    assert_eq!(
        c.execute(&replace, "test").unwrap_err().code,
        "PROJECT_KIND_CONFLICT"
    );
    replace["project"]["id"] = "manual".into();
    replace["operationId"] = "create-manual".into();
    replace["expectedRevision"] = Value::Null;
    let manual = c.execute(&replace, "test").unwrap();
    assert!(
        c.execute(
            &json!({"kind":"deleteSmartAlbum","operationId":"delete-manual","id":"manual",
        "expectedRevision":manual["project"]["revision"]}),
            "test"
        )
        .is_err()
    );
    replace["project"]["smartRule"] = smart_rule();
    replace["operationId"] = "replace-manual".into();
    replace["expectedRevision"] = manual["project"]["revision"].clone();
    assert_eq!(
        c.execute(&replace, "test").unwrap_err().code,
        "PROJECT_KIND_CONFLICT"
    );
    assert!(project(&c, "with-members").unwrap().is_none());
    assert!(project(&c, "smart-two").unwrap().is_none());
    assert!(project(&c, "malformed").unwrap().is_none());
    assert_eq!(
        project(&c, "smart-one").unwrap().unwrap(),
        receipt["project"]
    );
    c.shutdown().unwrap();
}

#[test]
fn restore_verifies_only_artwork_owned_media_and_keeps_integrity_checks() {
    let (_directory, mut c) = fixture();
    let bytes = b"\x89PNG\r\n\x1a\nowned media";
    let hash = canonical::digest(bytes);
    let unrelated = canonical::digest(b"unrelated missing media");
    for hash in [&hash, &unrelated] {
        c.db.execute(
            "INSERT INTO media_objects VALUES(?,?,'image/png')",
            params![hash, bytes.len() as i64],
        )
        .unwrap();
    }
    c.db.execute(
        "INSERT INTO media_refs VALUES('trash','selected',?)",
        [&hash],
    )
    .unwrap();
    c.db.execute("INSERT INTO media_refs VALUES('trash','other',?)", [&hash])
        .unwrap();
    c.db.execute(
        "INSERT INTO media_refs VALUES('temporary','selected',?)",
        [&unrelated],
    )
    .unwrap();
    let file = media::object_path(&c.root, &hash).unwrap();
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, bytes).unwrap();
    let restored = c.execute(&json!({"kind":"restoreArtwork","operationId":"restore-owned","id":"selected","expectedRevision":1}), "test").unwrap();
    assert!(restored["artwork"]["deletedAt"].is_null());
    assert_eq!(
        c.db.query_row(
            "SELECT COUNT(*) FROM media_refs WHERE owner_kind='temporary' AND owner_id='selected'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    std::fs::write(file, b"corrupt").unwrap();
    for (id, revision) in [
        ("selected", restored["revision"].as_i64().unwrap()),
        ("other", 1),
    ] {
        assert_eq!(c.execute(&json!({"kind":"restoreArtwork","operationId":format!("verify-{id}"),"id":id,"expectedRevision":revision}), "test").unwrap_err().code, "MEDIA_INVALID");
    }
    assert!(!artwork(&c, "other").unwrap().unwrap()["deletedAt"].is_null());
    c.shutdown().unwrap();
}
