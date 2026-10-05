use super::*;

fn fixture() -> (tempfile::TempDir, Context) {
    let directory = tempfile::tempdir().unwrap();
    let context = schema::open(
        directory.path().join("workspace"),
        "organization-test".into(),
        "epoch".into(),
        true,
    )
    .unwrap();
    for id in [json!(1), json!("two")] {
        let body = json!({"id":id,"project":"old","prompt":"original","manual_tags":["generated"],"collectionTags":["draft"]});
        context
            .db
            .execute(
                "INSERT INTO artworks VALUES(?,?,?,1,NULL)",
                params![entity_key(&id).unwrap(), stringify(&id), stringify(&body)],
            )
            .unwrap();
    }
    for id in [json!("old"), json!(7)] {
        let body = json!({"id":id,"history_ids":[]});
        context
            .db
            .execute(
                "INSERT INTO projects VALUES(?,?,?,1)",
                params![entity_key(&id).unwrap(), stringify(&id), stringify(&body)],
            )
            .unwrap();
    }
    records::update_membership(&context, "old", &["1".into(), "two".into()], 1).unwrap();
    (directory, context)
}
fn command(operation: &str) -> Value {
    json!({"kind":"organizeArtworks","operationId":operation,"ids":[1,"two"],"projectId":7,
        "collectionTags":{"add":["chosen"],"remove":["draft"]},"expectedRevisions":[{"id":1,"revision":1},{"id":"two","revision":1}]})
}

#[test]
fn organization_is_atomic_idempotent_and_undo_preserves_other_fields() {
    let (_directory, mut c) = fixture();
    c.db.execute(
        "UPDATE projects SET body=json_set(body,'$.custom','retained') WHERE id_key='old'",
        [],
    )
    .unwrap();
    c.db.execute_batch("CREATE TEMP TABLE album_writes(id TEXT); CREATE TEMP TRIGGER count_album_writes AFTER UPDATE OF body ON projects BEGIN INSERT INTO album_writes VALUES(new.id_key); END;").unwrap();
    let receipt = c.execute(&command("move"), "owner").unwrap();
    assert_eq!(
        c.db.query_row("SELECT COUNT(*) FROM album_writes", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        2,
        "Each affected album is rebuilt once, not once per selected artwork"
    );
    assert_eq!(receipt["changes"].as_array().unwrap().len(), 2);
    assert_eq!(c.execute(&command("move"), "owner").unwrap(), receipt);
    assert_eq!(
        records::project(&c, "7").unwrap().unwrap()["body"]["history_ids"],
        json!([1, "two"])
    );
    assert_eq!(
        records::project(&c, "old").unwrap().unwrap()["body"]["history_ids"],
        json!([])
    );
    let art = records::artwork(&c, "1").unwrap().unwrap();
    assert_eq!(art["body"]["project"], "7");
    assert_eq!(records::project(&c, "7").unwrap().unwrap()["id"], json!(7));
    assert_eq!(art["body"]["manual_tags"], json!(["generated"]));
    let album = records::project(&c, "7").unwrap().unwrap();
    let mut unchanged = command("same-album");
    for row in unchanged["expectedRevisions"].as_array_mut().unwrap() {
        row["revision"] = receipt["revision"].clone();
    }
    let unchanged = c.execute(&unchanged, "owner").unwrap();
    assert_eq!(unchanged["changes"], json!([]));
    assert_eq!(records::project(&c, "7").unwrap().unwrap(), album);
    c.db.execute("UPDATE artworks SET body=json_set(body,'$.favorite',json('true')),revision=revision+1 WHERE id_key='1'", []).unwrap();
    let undo =
        json!({"kind":"undoArtworkOrganization","operationId":"undo","sourceOperationId":"move"});
    let result = c.execute(&undo, "owner").unwrap();
    assert_eq!(result["restored"], 2);
    assert_eq!(c.execute(&undo, "owner").unwrap(), result);
    assert_eq!(
        records::project(&c, "old").unwrap().unwrap()["body"]["history_ids"],
        json!([1, "two"])
    );
    let art = records::artwork(&c, "1").unwrap().unwrap();
    assert_eq!(art["body"]["favorite"], true);
    assert_eq!(art["body"]["collectionTags"], json!(["draft"]));
    assert_eq!(art["body"]["prompt"], "original");
    c.db.execute(
        "INSERT INTO artworks VALUES('third','\"third\"',?,1,NULL)",
        [stringify(&json!({"id":"third","project":"old"}))],
    )
    .unwrap();
    for ids in [vec!["1", "two", "third"], vec!["1", "third", "two"]] {
        let keys = ids.into_iter().map(str::to_owned).collect::<Vec<_>>();
        c.transaction(|c| records::update_membership(c, "old", &keys, 9))
            .unwrap();
    }
    assert_eq!(
        records::project(&c, "old").unwrap().unwrap()["body"]["history_ids"],
        json!([1, "third", "two"])
    );
    c.db.execute(
        "UPDATE project_artworks SET position=8 WHERE project_key='old' AND artwork_key='two'",
        [],
    )
    .unwrap();
    c.transaction(|c| {
        records::update_membership(c, "old", &["1".into(), "third".into(), "two".into()], 10)
    })
    .unwrap();
    let positions = c
        .db
        .prepare("SELECT position FROM project_artworks WHERE project_key='old' ORDER BY position")
        .unwrap()
        .query_map([], |row| row.get::<_, i64>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(positions, vec![0, 1, 2]);
    assert_eq!(
        records::project(&c, "old").unwrap().unwrap()["body"]["custom"],
        "retained"
    );
    c.shutdown().unwrap();
}

#[test]
fn stale_revision_rolls_back_the_whole_batch_and_wrong_principal_cannot_undo() {
    let (_directory, mut c) = fixture();
    let mut stale = command("stale");
    stale["expectedRevisions"][1]["revision"] = json!(99);
    assert_eq!(
        c.execute(&stale, "owner").unwrap_err().code,
        "REVISION_CONFLICT"
    );
    assert_eq!(
        records::artwork(&c, "1").unwrap().unwrap()["body"]["project"],
        "old"
    );
    assert_eq!(
        records::project(&c, "old").unwrap().unwrap()["body"]["history_ids"],
        json!([1, "two"])
    );
    c.execute(&command("move"), "owner").unwrap();
    assert_eq!(c.execute(&json!({"kind":"undoArtworkOrganization","operationId":"undo","sourceOperationId":"move"}), "other").unwrap_err().code, "UNDO_UNAVAILABLE");
    let before = records::project(&c, "7").unwrap().unwrap();
    assert_eq!(
        c.transaction(|c| records::update_membership(c, "7", &["1".into(), "missing".into()], 9))
            .unwrap_err()
            .code,
        "NOT_FOUND"
    );
    assert_eq!(records::membership(&c, "7").unwrap(), vec!["1", "two"]);
    assert_eq!(records::project(&c, "7").unwrap().unwrap(), before);
    c.db.execute("UPDATE artworks SET deleted_at=1 WHERE id_key='1'", [])
        .unwrap();
    assert_eq!(
        c.transaction(|c| records::update_membership(c, "7", &["1".into(), "two".into()], 9))
            .unwrap_err()
            .code,
        "NOT_FOUND"
    );
    assert_eq!(records::project(&c, "7").unwrap().unwrap(), before);
    c.shutdown().unwrap();
}

#[test]
fn later_organization_is_skipped_without_blocking_unchanged_rows() {
    let (_directory, mut c) = fixture();
    c.execute(&command("move"), "owner").unwrap();
    c.db.execute("UPDATE artworks SET body=json_set(body,'$.collectionTags',json('[\"newer\"]')) WHERE id_key='1'", []).unwrap();
    let undo = c.execute(&json!({"kind":"undoArtworkOrganization","operationId":"undo","sourceOperationId":"move"}), "owner").unwrap();
    assert_eq!(undo["restored"], 1);
    assert_eq!(undo["skipped"], 1);
    assert_eq!(
        records::artwork(&c, "1").unwrap().unwrap()["body"]["collectionTags"],
        json!(["newer"])
    );
    assert_eq!(
        records::project(&c, "7").unwrap().unwrap()["body"]["history_ids"],
        json!([1])
    );
    c.shutdown().unwrap();
}

#[test]
fn cancelled_organization_never_writes_or_allocates_a_receipt() {
    let (_directory, mut c) = fixture();
    c.cancel.store(true, Ordering::Relaxed);
    assert_eq!(
        c.execute(&command("move"), "owner").unwrap_err().code,
        "CANCELLED"
    );
    assert!(c.operation("owner", "move").unwrap().is_none());
    assert_eq!(
        records::artwork(&c, "1").unwrap().unwrap()["body"]["project"],
        "old"
    );
    c.cancel.store(false, Ordering::Relaxed);
    c.shutdown().unwrap();
}

#[test]
fn manual_organization_cannot_assign_into_any_smart_rule_marker() {
    let (_directory, mut c) = fixture();
    for rule in [Value::Null, json!({"tags":["和服"]})] {
        c.db.execute(
            "UPDATE projects SET body=json_set(body,'$.smartRule',json(?)) WHERE id_key='7'",
            [stringify(&rule)],
        )
        .unwrap();
        assert!(c.execute(&command("smart-assignment"), "owner").is_err());
        assert_eq!(
            records::artwork(&c, "1").unwrap().unwrap()["body"]["project"],
            "old"
        );
        assert_eq!(
            records::project(&c, "7").unwrap().unwrap()["body"]["history_ids"],
            json!([])
        );
        assert!(c.operation("owner", "smart-assignment").unwrap().is_none());
    }
    c.shutdown().unwrap();
}
