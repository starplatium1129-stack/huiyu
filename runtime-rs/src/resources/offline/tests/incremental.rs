use super::*;

fn delta_fixture(root: &Path, first: &Options) -> Options {
    let mut options = fixture(root, "release_delta", &["sc1000", "sc1001", "sc1002"]);
    let base: Value = fs::json(&first.package.join("release.json"), false, false)
        .unwrap()
        .unwrap();
    let mut next: Value = fs::json(&options.package.join("release.json"), false, false)
        .unwrap()
        .unwrap();
    for name in ["images/sc1001.jpg", "thumbs/sc1001.jpg"] {
        let bytes = std::fs::read(first.package.join("showcase").join(name)).unwrap();
        write(&options.package, &format!("showcase/{name}"), &bytes);
        for entry in next["showcase"]["entries"].as_array_mut().unwrap() {
            if entry["path"] == name {
                *entry = json!(super::entry(name, &bytes));
            }
        }
    }
    let baseline_assets: Value = fs::json(&first.package.join("pack/manifest.json"), false, false)
        .unwrap()
        .unwrap();
    let assets = Manifest::parse(&baseline_assets).unwrap();
    let empty = Manifest { entries: vec![] };
    let record = json!({"path":"manifest.json","contentIdentity":assets.identity(),"entryCount":assets.entries.len(),"totalBytes":assets.bytes()});
    let delta = json!({"schemaVersion":1,"kind":"resource-pack-delta","baseManifest":record,"newManifest":record,
        "totals":{"added":0,"changed":0,"removed":0,"unchanged":assets.entries.len()},"removed":[],"candidate":{"files":0,"bytes":0,"zeroAssets":true}});
    let pack_raw = serde_json::to_vec(&empty.value()).unwrap();
    let delta_raw = serde_json::to_vec(&delta).unwrap();
    write(&options.package, "pack/manifest.json", &pack_raw);
    write(&options.package, "pack/delta.json", &delta_raw);
    std::fs::remove_file(
        options
            .package
            .join("pack/assets/characters/popular-alpha.png"),
    )
    .unwrap();
    std::fs::remove_dir(options.package.join("pack/assets/characters")).unwrap();
    std::fs::remove_dir(options.package.join("pack/assets")).unwrap();
    let target = Manifest {
        entries: serde_json::from_value(next["showcase"]["entries"].clone()).unwrap(),
    };
    let payload = target
        .entries
        .iter()
        .filter(|entry| !entry.path.contains("sc1001"))
        .cloned()
        .collect::<Vec<_>>();
    for name in ["images/sc1001.jpg", "thumbs/sc1001.jpg"] {
        std::fs::remove_file(options.package.join("showcase").join(name)).unwrap();
    }
    next["mode"] = "delta".into();
    next["baseRelease"] = json!({"releaseId":base["releaseId"],"releaseSha256":first.expected,"resourceIdentity":assets.identity(),"showcaseIdentity":base["showcase"]["contentIdentity"]});
    next["resourcePack"]["packageIdentity"] =
        policy::package_identity(&pack_raw, Some(&delta_raw)).into();
    next["resourcePack"]["targetIdentity"] = assets.identity().into();
    next["showcase"]["contentIdentity"] = target.identity().into();
    next["showcase"]["payloadEntries"] = json!(payload);
    let mut files = vec![
        entry("pack/manifest.json", &pack_raw),
        entry("pack/delta.json", &delta_raw),
    ];
    files.extend(payload.iter().map(|entry| Entry {
        path: format!("showcase/{}", entry.path),
        ..entry.clone()
    }));
    next["files"] = json!(files);
    let raw = serde_json::to_vec(&next).unwrap();
    write(&options.package, "release.json", &raw);
    options.expected = digest(raw);
    options
}

#[test]
fn incremental_import_reuses_baseline_preserves_user_art_and_rejects_wrong_or_missing_baselines() {
    let temp = directory();
    let first = fixture(temp.path(), "release_a", &["sc1000", "sc1001", "sc1003"]);
    apply(&first);
    let old = show(&first);
    write(&old, "images/sc1001.jpg", b"user-retouched");
    let second = delta_fixture(temp.path(), &first);
    let fresh = Options {
        runtime: temp.path().join("new-user/gateway"),
        ..second.clone()
    };
    assert_eq!(
        execute(&fresh, &CancellationToken::new()).unwrap_err().code,
        "BASELINE_REQUIRED"
    );
    assert!(!fresh.runtime.parent().unwrap().exists());
    let paths = paths::Paths::new(&second).unwrap();
    let pointer = paths.pointer().unwrap();
    let policy_before = std::fs::read(&paths.policy).unwrap();
    let raw = std::fs::read(second.package.join("release.json")).unwrap();
    let mut wrong: Value = serde_json::from_slice(&raw).unwrap();
    wrong["baseRelease"]["releaseSha256"] = "0".repeat(64).into();
    let wrong_raw = serde_json::to_vec(&wrong).unwrap();
    write(&second.package, "release.json", &wrong_raw);
    assert_eq!(
        execute(
            &Options {
                expected: digest(wrong_raw),
                apply: true,
                ..second.clone()
            },
            &CancellationToken::new()
        )
        .unwrap_err()
        .code,
        "BASELINE_MISMATCH"
    );
    assert_eq!(paths.pointer().unwrap(), pointer);
    assert_eq!(std::fs::read(&paths.policy).unwrap(), policy_before);
    assert!(!paths.pending.exists());
    write(&second.package, "release.json", &raw);
    let preview = execute(&second, &CancellationToken::new()).unwrap();
    assert_eq!(preview["showcaseFiles"], 5);
    assert_eq!(preview["resourceFiles"], 0);
    apply(&second);
    let current = show(&second);
    assert_eq!(
        std::fs::read(current.join("images/sc1001.jpg")).unwrap(),
        b"user-retouched"
    );
    assert_eq!(
        std::fs::read(current.join("thumbs/sc1001.jpg")).unwrap(),
        b"neutral-sample-release_a-sc1001"
    );
    assert_eq!(
        std::fs::read(current.join("images/sc1000.jpg")).unwrap(),
        b"neutral-sample-release_delta-sc1000"
    );
    assert!(current.join("images/sc1002.jpg").is_file());
    assert!(
        !manifest(&current)["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["id"] == "sc1003")
    );
    assert!(old.join("images/sc1003.jpg").is_file());
    assert_eq!(apply(&second)["action"], "already-installed");
}
