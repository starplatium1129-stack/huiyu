use super::*;
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    process::{Command, Stdio},
};
fn write(root: &Path, name: &str, value: &Value) {
    let file = root.join(name);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, blueprints::json_text(value)).unwrap();
}
fn config(root: &Path) -> Config {
    Config {
        app_root: root.into(),
        runtime_root: root.parent().unwrap().join("runtime"),
        ai_workspace_root: root.parent().unwrap().join("AI"),
        sd_host: "http://127.0.0.1:1".into(),
        sd_auth: None,
        comfy_host: "http://127.0.0.1:1".into(),
        bind: "127.0.0.1:3210".parse().unwrap(),
        token: String::new(),
        desktop_secret: None,
        source_profile_id: None,
        workspace_pointer: None,
        workspace_candidate: None,
        config_root: None,
        gateway_origin: "http://127.0.0.1:3210".into(),
        workspace_root: None,
        workspace_id: None,
        create_workspace: false,
    }
}
fn tag_fixture() -> (Value, Value) {
    (
        json!([
            {"id":"tag_a","cat":"Objects","en":"open book","cn":"书","weight":0,"aliases":["reading tome"]},
            {"id":"tag_b","cat":"Objects","en":"open-book","cn":"书页","related":["tag_a"]},
            {"id":"tag_c","cat":"Objects","en":"volume","cn":"卷册","aliases":["open_book"]},
            {"id":"tag_d","cat":"Objects","en":"123","cn":"编号"}
        ]),
        json!({"duplicates":{"open_book":{"canonical":"tag_a","members":["tag_b","tag_a"],"meaning":"书本"}},"aliasOverrides":{"open_book":{"target":"tag_c","shadowed":["tag_a","tag_b"]}}}),
    )
}
fn fixture(root: &Path) {
    write(
        root,
        "data/scenes/manifest.json",
        &json!({"files":[{"file":"nene-core.json","character":"nene"},{"file":"natsume-core.json","character":"natsume"}]}),
    );
    write(
        root,
        "data/scenes/nene-core.json",
        &json!([{"id":"sc002","char":"nene","category":"Core","title":"Neutral library. ".repeat(110)}]),
    );
    write(
        root,
        "data/scenes/natsume-core.json",
        &json!([{"id":"sc001","char":"natsume","category":"Core","title":"Neutral room"}]),
    );
    write(
        root,
        "data/curation.json",
        &json!({"personaCoreSceneIds":["sc002","sc001"]}),
    );
    write(
        root,
        "data/popular/manifest.json",
        &json!({"version":1,"files":[{"file":"fixture.json","franchise":"Fixture","count":1}]}),
    );
    write(
        root,
        "data/popular/fixture.json",
        &json!({"version":1,"characters":[{"id":"fixture","franchise":"Fixture","title":"Neutral"}]}),
    );
    write(
        root,
        "data/blueprints/manifest.json",
        &json!({"version":1,"files":[{"file":"fixture.json","franchise":"Fixture","count":1}]}),
    );
    write(
        root,
        "data/blueprints/fixture.json",
        &json!({"version":2,"blueprints":[{"id":"bp_fixture","characterId":"fixture","title":"Neutral"}]}),
    );
    let (tags, policy) = tag_fixture();
    write(
        root,
        "data/tags/manifest.json",
        &json!({"version":1,"files":[{"file":"objects.json","category":"Objects","count":tags.as_array().unwrap().len()}],"dictionary":policy}),
    );
    write(
        root,
        "data/tags/objects.json",
        &json!({"version":1,"category":"Objects","tags":tags}),
    );
    write(
        root,
        "data/references/manifest.json",
        &json!({"version":1,"standards":{"version":1,"perspectives":["front"]},"characterIds":["nene","natsume"],"viewOrder":["natsume","nene"]}),
    );
    for id in ["nene", "natsume"] {
        write(
            root,
            &format!("data/references/{id}.json"),
            &json!({"standard":{"id":id,"outfits":[]},"view":{"characterId":id,"outfits":[{"outfitId":"neutral","references":[{"pending":true}]}]}}),
        );
    }
    for name in [
        "character-reference-view.json.gz",
        "tags-dictionary.json.br",
    ] {
        std::fs::write(root.join("data").join(name), b"old stale fixture").unwrap();
    }
}
fn bytes_tree(root: &Path) -> BTreeMap<String, Vec<u8>> {
    fn visit(root: &Path, directory: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        for entry in std::fs::read_dir(directory).unwrap() {
            let file = entry.unwrap().path();
            if file.is_dir() {
                visit(root, &file, out);
            } else {
                out.insert(
                    file.strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/"),
                    std::fs::read(file).unwrap(),
                );
            }
        }
    }
    let mut map = BTreeMap::new();
    visit(root, root, &mut map);
    map
}
fn node(code: &str, input: &Value, data_root: Option<&Path>) -> Value {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut command = Command::new("node");
    command
        .arg("-e")
        .arg(code)
        .arg(repo)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(root) = data_root {
        command.env("AICS_DATA_ROOT", root);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
#[test]
fn five_domain_startup_matches_node_products_and_second_start_is_readonly() {
    let directory = tempfile::tempdir().unwrap();
    let rust = directory.path().join("rust");
    let old = directory.path().join("node");
    fixture(&rust);
    fixture(&old);
    let source = bytes_tree(&rust);
    let config = config(&rust);
    let actual = run(&config, &CancellationToken::new(), false).unwrap();
    let expected = node(
        "const path=require('path');process.stdout.write(JSON.stringify(require(path.join(process.argv[1],'scripts/lib/ensure-data-build.js')).ensureAll()));",
        &Value::Null,
        Some(&old),
    );
    assert_eq!(actual, expected);
    for name in PRODUCTS {
        assert_eq!(
            std::fs::read(rust.join("data").join(name)).unwrap(),
            std::fs::read(old.join("data").join(name)).unwrap(),
            "{name}"
        );
        let raw = std::fs::read(rust.join("data").join(name)).unwrap();
        for suffix in ["gz", "br"] {
            let path = rust.join("data").join(format!("{name}.{suffix}"));
            if let Ok(bytes) = std::fs::read(path) {
                let mut decoded = Vec::new();
                let mut input: Box<dyn Read> = if suffix == "gz" {
                    Box::new(flate2::read::GzDecoder::new(bytes.as_slice()))
                } else {
                    Box::new(brotli::Decompressor::new(bytes.as_slice(), 8192))
                };
                input.read_to_end(&mut decoded).unwrap();
                assert_eq!(decoded, raw);
            }
        }
    }
    for (name, bytes) in source {
        if name.ends_with(".json") {
            assert_eq!(
                bytes,
                std::fs::read(rust.join(&name)).unwrap(),
                "source {name}"
            );
        }
    }
    let before = bytes_tree(&rust);
    let unchanged = run(&config, &CancellationToken::new(), false).unwrap();
    assert!(
        ["scenes", "popular", "blueprints", "tags", "references"]
            .iter()
            .all(|name| unchanged[*name]["rebuilt"] == false)
    );
    assert_eq!(before, bytes_tree(&rust));
    config.prepare_content_for(true).unwrap();
    let packaged = run(&config, &CancellationToken::new(), true).unwrap();
    assert_eq!(packaged["packaged"], true);
    assert_eq!(before, bytes_tree(&rust));
    // A shrinking source may not leave a formerly large compressed response.
    write(
        &rust,
        "data/scenes/nene-core.json",
        &json!([{"id":"sc002","char":"nene","category":"Core","title":"Small"}]),
    );
    run(&config, &CancellationToken::new(), false).unwrap();
    assert!(!rust.join("data/scenes-nene.json.gz").exists());
    assert!(!rust.join("data/scenes-nene.json.br").exists());
}
#[test]
fn tag_dictionary_decisions_and_failures_match_original_node() {
    let (tags, policy) = tag_fixture();
    let mut cases = vec![
        json!({"tags":tags,"policy":policy}),
        json!({"tags":tags,"policy":{}}),
    ];
    let mut related = tags.clone();
    related[0]["related"] = json!(["missing"]);
    cases.push(json!({"tags":related,"policy":policy}));
    let mut reserved = tags.clone();
    reserved[0]["en"] = "__proto__".into();
    cases.push(json!({"tags":reserved,"policy":policy}));
    let mut stale = policy.clone();
    stale["aliasOverrides"]["unused"] = json!({"target":"tag_a","shadowed":[]});
    cases.push(json!({"tags":tags,"policy":stale}));
    let expected = node(
        "const fs=require('fs'),path=require('path');const input=JSON.parse(fs.readFileSync(0,'utf8'));const build=require(path.join(process.argv[1],'scripts/lib/tag-validation.js')).buildValidatedTagDictionary;process.stdout.write(JSON.stringify(input.map(item=>{try{return{value:build(item.tags,item.policy)}}catch(error){return{error:error.message}}})));",
        &json!(cases),
        None,
    );
    for (index, item) in cases.iter().enumerate() {
        let actual = match tags::dictionary(item["tags"].as_array().unwrap(), &item["policy"]) {
            Ok(value) => json!({"value":value}),
            Err(error) => json!({"error":error.message}),
        };
        assert_eq!(actual, expected[index]);
    }
}
