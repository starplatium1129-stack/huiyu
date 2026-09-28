use super::*;
use crate::maintenance::{backup, context::Context, journal};
use std::{
    io::Write,
    process::{Command, Stdio},
};
fn write(path: &Path, value: &Value) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, blueprints::json_text(value)).unwrap();
}
fn fixture(base: &Path) -> Options {
    let root = base.join("app");
    std::fs::create_dir_all(&root).unwrap();
    let scene = json!({"id":"sc001","char":"nene","title":"Neutral study","category":"Core","story":"A book rests on a desk.","rating":"All"});
    write(
        &root.join("data/scenes/manifest.json"),
        &json!({"files":[{"file":"nene-core.json","character":"nene"}]}),
    );
    write(&root.join("data/scenes/nene-core.json"), &json!([scene]));
    write(
        &root.join("data/scene-blueprints.json"),
        &json!({"version":2,"blueprints":[{"id":"quiet_blueprint","characterId":"alpha","title":"Reading","description":"A neutral bookshelf.","adult":false}]}),
    );
    write(
        &root.join("data/popular-characters.json"),
        &json!({"characters":[{"id":"alpha","displayName":"Alpha"}]}),
    );
    let showcase = base.join("showcase/v2");
    write(
        &showcase.join("manifest.json"),
        &json!({"version":23,"entries":[],"custom":{"kept":true}}),
    );
    write(
        &base.join("showcase/v1/manifest.json"),
        &json!({"entries":[]}),
    );
    write(
        &base.join("showcase/v1/home-hero.json"),
        &json!({"version":4,"entries":{"natsume":{"image":"home/natsume.jpg","updatedAt":"old"}},"unknown":"retained"}),
    );
    for folder in ["images", "thumbs"] {
        std::fs::create_dir_all(showcase.join(folder)).unwrap();
        std::fs::write(
            showcase.join(folder).join("sc001.png"),
            b"old-neutral-fixture",
        )
        .unwrap();
    }
    Options {
        assets_root: None,
        root,
        runtime: base.join("runtime"),
        showcase: Some(showcase),
    }
}
fn image() -> Vec<u8> {
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 82)
        .encode(&[128, 128, 128], 1, 1, image::ExtendedColorType::Rgb8)
        .unwrap();
    bytes
}
fn data(bytes: &[u8]) -> String {
    use base64::engine::general_purpose::STANDARD;
    format!("data:image/jpeg;base64,{}", STANDARD.encode(bytes))
}
fn oracle(options: &Options, operations: &[Value]) -> Value {
    let mut command = Command::new("node");
    command
        .arg(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("src/maintenance/content_products/legacy-oracle.cjs"),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().unwrap();
    child.stdin.take().unwrap().write_all(&serde_json::to_vec(&json!({"options":{"root":options.root,"runtime":options.runtime,"showcase":options.showcase},"operations":operations})).unwrap()).unwrap();
    let result = child.wait_with_output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    serde_json::from_slice(&result.stdout).unwrap()
}
#[test]
fn jpeg_products_match_node_manifests_and_preserve_transaction_digests() {
    let temp = tempfile::tempdir().unwrap();
    let rust = fixture(&temp.path().join("rust"));
    let node = fixture(&temp.path().join("node"));
    let bytes = image();
    let data = data(&bytes);
    let operations = vec![
        json!({"hero":false,"body":{"id":"sc001","image":data,"thumbnail":data}}),
        json!({"hero":false,"body":{"id":"quiet_blueprint","image":data,"thumbnail":data}}),
        json!({"hero":true,"body":{"character":"nene","image":data}}),
        json!({"hero":true,"body":{"character":"nene","action":"reset"}}),
    ];
    let expected = oracle(&node, &operations);
    let mut responses = Vec::new();
    for operation in &operations {
        let mut value = save(
            &rust,
            &operation["body"],
            operation["hero"] == true,
            &CancellationToken::new(),
        )
        .unwrap();
        let id = value["backup"].as_str().unwrap();
        let snapshot = backup::read(&Context::new(&rust).unwrap(), id, None).unwrap();
        assert_eq!(
            snapshot.entries.len(),
            if operation["hero"] == true { 2 } else { 7 }
        );
        if operation["body"]["id"] == "sc001" {
            let old = snapshot
                .entries
                .iter()
                .find(|e| e.file.ends_with("sc001.png"))
                .unwrap();
            assert_eq!(
                old.expected["sha256"],
                codec::digest(b"old-neutral-fixture")
            );
        }
        value.as_object_mut().unwrap().remove("backup");
        responses.push(value);
        assert_eq!(journal::inspect(&rust)["status"], "free");
    }
    let showcase = rust.showcase.as_ref().unwrap();
    let mut hero = fs::json(&showcase.join("home-hero.json")).unwrap();
    for entry in hero["entries"].as_object_mut().unwrap().values_mut() {
        if entry.get("updatedAt").is_some() {
            entry["updatedAt"] = json!("<timestamp>");
        }
    }
    let actual = json!({"results":responses,"manifest":fs::json(&showcase.join("manifest.json")).unwrap(),"hero":hero});
    assert_eq!(
        crate::storage::fingerprint(&actual),
        crate::storage::fingerprint(&expected),
        "Rust {actual}\nNode {expected}"
    );
    assert_eq!(
        std::fs::read(showcase.join("images/sc001.jpg")).unwrap(),
        bytes
    );
    assert!(!showcase.join("images/sc001.png").exists());
    assert!(!showcase.join("home/nene.jpg").exists());
}
#[test]
fn failed_product_write_rolls_back_every_byte_and_uses_the_shared_lease() {
    let temp = tempfile::tempdir().unwrap();
    let options = fixture(temp.path());
    let root = options.showcase.as_ref().unwrap();
    let mut held = Transaction::acquire(&options).unwrap();
    let err = save(
        &options,
        &json!({"id":"sc001","image":data(&image())}),
        false,
        &CancellationToken::new(),
    )
    .unwrap_err();
    assert_eq!(err.code, "MAINTENANCE_BUSY");
    held.rollback().unwrap();
    // A malformed old manifest is discovered after the image write; this is an
    // actual rollback path, not validation that merely prevents the transaction.
    std::fs::write(root.join("manifest.json"), b"{broken fixture").unwrap();
    let before = fs::state(&root.join("images/sc001.png")).unwrap();
    let error = save(
        &options,
        &json!({"id":"sc001","image":data(&image())}),
        false,
        &CancellationToken::new(),
    )
    .unwrap_err();
    assert_eq!(error.extra["rolledBack"], true);
    assert_eq!(error.extra["dataIntegrity"], "restored");
    assert_eq!(fs::state(&root.join("images/sc001.png")).unwrap(), before);
    assert!(!root.join("images/sc001.jpg").exists());
    assert_eq!(
        std::fs::read(root.join("manifest.json")).unwrap(),
        b"{broken fixture"
    );
    assert_eq!(journal::inspect(&options)["status"], "free");
}
