use super::*;
use std::process::Command;
fn write(path: &Path, value: &Value) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, blueprints::json_text(value)).unwrap();
}
fn fixture(root: &Path) {
    for name in super::super::context::VERSIONED_FILES {
        write(&root.join("data").join(name), &json!([]));
    }
    write(
        &root.join("data/scenes/manifest.json"),
        &json!({"batchSize":2,"files":[{"file":"nene-core.json","character":"nene"},{"file":"nene-after-story.json","character":"nene"},{"file":"natsume-core.json","character":"natsume"}]}),
    );
    write(
        &root.join("data/scenes/nene-core.json"),
        &json!([{"id":"sc001","char":"nene","category":"Core"},{"id":"sc002","char":"nene","category":"Core"}]),
    );
    write(&root.join("data/scenes/nene-after-story.json"), &json!([]));
    write(
        &root.join("data/scenes/natsume-core.1.json"),
        &json!([{"id":"sc003","char":"natsume","category":"Core"}]),
    );
    write(
        &root.join("data/scenes/natsume-core.2.json"),
        &json!([{"id":"sc004","char":"natsume","category":"Core"}]),
    );
    write(
        &root.join("data/curation.json"),
        &json!({"personaCoreSceneIds":["sc004","sc001","sc006"]}),
    );
    write(
        &root.join("data/prompt-pinned-scenes.json"),
        &json!({"scenes":{}}),
    );
    write(
        &root.join("data/retired-scenes.json"),
        &json!({"records":[]}),
    );
}
#[test]
fn stable_batches_and_browser_products_match_node_and_rollback_exactly() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("rust");
    let old = directory.path().join("node");
    fixture(&root);
    fixture(&old);
    let incoming = json!([{"id":"sc001","char":"nene","category":"After_Story"},{"id":"sc002","char":"nene","category":"Core"},{"id":"sc004","char":"natsume","category":"Core"},{"id":"sc005","char":"nene","category":"Core"},{"id":"sc006","char":"natsume","category":"Core"}]);
    let payload = directory.path().join("incoming.json");
    write(&payload, &incoming);
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let script = "const fs=require('fs');const path=require('path');const store=require(path.join(process.argv[1],'scripts/lib/scene-store.js'));const write=require(path.join(process.argv[1],'scripts/lib/scene-write.js'));const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));const result=write.applySceneChanges(input,store.loadSceneShards(),{retiredIds:new Set()});store.writeAggregate(input);process.stdout.write(JSON.stringify(result));";
    let mut command = Command::new("node");
    command
        .args(["-e", script])
        .arg(repo)
        .arg(&payload)
        .env("AICS_DATA_ROOT", &old);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let result = command.output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let expected: Value = serde_json::from_slice(&result.stdout).unwrap();
    let options = Options {
        assets_root: None,
        root: root.clone(),
        runtime: directory.path().join("runtime"),
        showcase: None,
    };
    let current = state::read(&options).unwrap();
    let plan = plan(&current, incoming.as_array().unwrap()).unwrap();
    assert_eq!(plan.changes, expected);
    let targets = snapshot_targets(&options, &plan, &["sc003".into()]).unwrap();
    let mut tx = Transaction::acquire(&options).unwrap();
    tx.prepare(&targets, "neutral-plan").unwrap();
    plan.apply(&root, &tx).unwrap();
    aggregate(&root, incoming.as_array().unwrap(), &tx).unwrap();
    for folder in ["data", "data/scenes"] {
        let mut files = std::fs::read_dir(old.join(folder))
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .filter(|name| name.to_string_lossy().ends_with(".json"))
            .collect::<Vec<_>>();
        files.sort();
        for name in files {
            let relative = Path::new(folder).join(name);
            assert_eq!(
                std::fs::read(root.join(&relative)).unwrap(),
                std::fs::read(old.join(&relative)).unwrap(),
                "{}",
                relative.display()
            );
        }
    }
    assert!(!root.join("data/scenes/nene-core.json").exists());
    assert_eq!(
        fs::json(&root.join("data/scenes/natsume-core.1.json")).unwrap(),
        json!([])
    );
    tx.rollback().unwrap();
    assert!(root.join("data/scenes/nene-core.json").exists());
    assert!(!root.join("data/scenes/nene-core.1.json").exists());
    assert!(!root.join("data/scenes/nene-core.2.json").exists());
}
