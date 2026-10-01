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
    let receipt = c.execute(&command("move"), "owner").unwrap();
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
