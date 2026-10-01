use super::*;

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
