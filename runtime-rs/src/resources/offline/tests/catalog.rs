use super::*;

fn with_catalog(mut options: Options, name: &str) -> Options {
    write(
        &options.app,
        "data/catalog/manifest.json",
        br#"{"version":1,"files":[],"retired":[]}"#,
    );
    let snapshot = json!({"version":1,"records":[
        {"kind":"character","id":"alpha","revision":1,"sortOrder":0,"createdAt":null,"updatedAt":null,
         "data":{"id":"alpha","profile":{"id":"alpha","name":name}}},
        {"kind":"outfit","id":"alpha/standard","revision":1,"sortOrder":0,"createdAt":null,"updatedAt":null,
         "data":{"characterId":"alpha","outfit":{"id":"standard","name":"Standard","prose":"A coat.","tokens":["coat"]}}}
    ],"retired":[]});
    let bytes = serde_json::to_vec(&snapshot).unwrap();
    write(&options.package, "catalog.json", &bytes);
    let mut release: Value =
        serde_json::from_slice(&std::fs::read(options.package.join("release.json")).unwrap())
            .unwrap();
    let inventory = json!(entry("catalog.json", &bytes));
    release["files"]
        .as_array_mut()
        .unwrap()
        .push(inventory.clone());
    release["catalog"] = inventory;
    let bytes = serde_json::to_vec(&release).unwrap();
    write(&options.package, "release.json", &bytes);
    options.expected = digest(bytes);
    options
}

fn open(options: &Options) -> crate::catalog::Catalog {
    crate::catalog::Catalog::open(crate::catalog::Options {
        source: options.app.clone(),
        database: options.runtime.join("content/catalog.sqlite"),
    })
    .unwrap()
}

#[test]
fn approved_pack_installs_characters_and_outfits_on_a_model_free_new_machine() {
    let temp = directory();
    let options = with_catalog(fixture(temp.path(), "with_content", &["sc1000"]), "Alpha");
    assert_eq!(
        execute(&options, &CancellationToken::new()).unwrap()["catalogIncluded"],
        true
    );
    assert!(
        !options.runtime.exists(),
        "ZIP preview must not create the personal database"
    );
    let result = apply(&options);
    assert!(
        options
            .runtime
            .join("content/data/catalog/manifest.json")
            .is_file()
    );
    assert_eq!(result["catalog"]["changed"], 2);
    assert_eq!(
        open(&options).get("character", "alpha").unwrap().data["profile"]["name"],
        "Alpha"
    );
    assert!(open(&options).get("outfit", "alpha/standard").is_ok());
    assert!(
        options
            .runtime
            .join("content-update-backups")
            .join(&options.expected)
            .join("before.json")
            .is_file()
    );
    assert_eq!(apply(&options)["catalog"]["changed"], 0);
    write(&options.package, "catalog.json", b"tampered");
    assert_eq!(
        execute(&options, &CancellationToken::new())
            .unwrap_err()
            .code,
        "CONTENT_INVALID"
    );
}

#[test]
fn content_conflict_preserves_personal_edits_and_does_not_activate_new_resources() {
    let temp = directory();
    let first = with_catalog(fixture(temp.path(), "first", &["sc1000"]), "Alpha");
    apply(&first);
    let mut catalog = open(&first);
    let change: crate::catalog::Change = serde_json::from_value(json!({"kind":"character","id":"alpha","expectedRevision":1,"patch":{"profile":{"name":"Personal"}}})).unwrap();
    catalog.apply(&[change], false).unwrap();
    drop(catalog);
    let second = with_catalog(fixture(temp.path(), "second", &["sc1000"]), "Updated");
    let paths = paths::Paths::new(&second).unwrap();
    let before = paths.pointer().unwrap();
    let result = execute(
        &Options {
            apply: true,
            ..second.clone()
        },
        &CancellationToken::new(),
    );
    assert_eq!(result.unwrap_err().code, "CATALOG_IMPORT_CONFLICT");
    assert_eq!(paths.pointer().unwrap(), before);
    assert!(!paths.pending.exists());
    assert_eq!(
        open(&second).get("character", "alpha").unwrap().data["profile"]["name"],
        "Personal"
    );
}

#[test]
fn retry_finishes_content_receipt_after_database_commit() {
    let temp = directory();
    let options = with_catalog(fixture(temp.path(), "retry_content", &["sc1000"]), "Alpha");
    let receipt = options
        .runtime
        .join("content-update-backups")
        .join(&options.expected)
        .join("receipt.json");
    std::fs::create_dir_all(&receipt).unwrap();
    assert!(
        execute(
            &Options {
                apply: true,
                ..options.clone()
            },
            &CancellationToken::new()
        )
        .is_err()
    );
    let paths = paths::Paths::new(&options).unwrap();
    assert!(paths.pending.exists());
    assert!(open(&options).get("character", "alpha").is_ok());
    std::fs::remove_dir(&receipt).unwrap();
    let result = apply(&options);
    assert_eq!(result["action"], "recovered");
    assert_eq!(result["catalog"]["changed"], 0);
    assert!(!paths.pending.exists());
    assert!(receipt.is_file());
}
