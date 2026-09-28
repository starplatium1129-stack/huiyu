use super::*;
use std::{
    io::Write,
    process::{Command, Stdio},
};

fn scene(id: &str) -> Value {
    json!({"id":id,"char":"nene","character":["nene"],"title":"Neutral fixture","category":"Core","story":"A quiet room with a book.","storyJa":"【寧々】本を読みます。","lora":"fixture","emotion":"calm","season":"spring","time":"day","timeOfDay":"morning","tags":["1girl","white_hair","indoor","medium_shot"],"rating":"All","mature":false,"location":"room","weather":"clear","camera":"中景","lighting":"window","usage":["全年龄","fixture"],"prompt":"1girl, ayachi_nene, white_hair, indoor, (soft_ambiance:1.2), masterpiece, score_9, nene_costume, standing, book, wide_shot","negative":"custom_mark, bad hands","recommendedSize":"768×1024"})
}
#[test]
fn semantic_pipeline_matches_original_node_with_neutral_fixtures() {
    let mut scenes = [
        "sc207", "sc208", "sc209", "sc210", "sc301", "sc302", "sc303", "sc304",
    ]
    .iter()
    .map(|id| scene(id))
    .collect::<Vec<_>>();
    let mut wide = scene("sc900");
    wide["camera"] = "wide".into();
    wide["prompt"]="1girl, nene_blue, natsume_orange, score_9, (book:1.1), \u{feff}standing, upper_body, {placeholder}, open_book BREAK window, chair".into();
    scenes.push(wide);
    let mut dual = scene("sc901");
    dual["char"] = "triad".into();
    dual["character"] = json!(["nene", "natsume"]);
    dual["tags"] = json!(["2girls", "closed_eyes", "looking_at_viewer"]);
    dual["prompt"] =
        "2girls, room, (ayachi_nene, sitting, book) BREAK (shiki_natsume, standing, table)".into();
    scenes.push(dual);
    let mut pinned = scene("sc902");
    pinned["prompt"] = "(fixture_block:1.1), nene_token, score_9".into();
    scenes.push(pinned);
    let mut audited = scene("sc903");
    audited["auditRevision"] = "fixture".into();
    scenes.push(audited);
    let mut rated = scene("sc904");
    rated["rating"] = "R18".into();
    rated["mature"] = true.into();
    rated["tags"] = json!(["adult", "book"]);
    scenes.push(rated);
    let pins = json!({"sc902":true});
    let files = json!({"prompt-pinned-scenes.json":{"scenes":pins},"characters.json":[],"presets.json":{},"curation.json":{},"retired-scenes.json":{"records":[]}});
    let input = json!({"scenes":scenes,"files":files});
    let mut command = Command::new("node");
    command
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/maintenance/semantics/legacy-oracle.cjs"
        ))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
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
        .write_all(serde_json::to_string(&input).unwrap().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let oracle: Value = serde_json::from_slice(&output.stdout).unwrap();
    for (index, scene) in scenes.iter().enumerate() {
        assert_eq!(
            prompt::effective(scene),
            oracle["effective"][index],
            "rendered {}",
            scene["id"]
        );
        assert_eq!(
            prompt::rating(scene),
            oracle["rating"][index],
            "rating {}",
            scene["id"]
        );
    }
    let classified = prompt::classify(&scenes, &pins).unwrap();
    assert_eq!(json!(classified), oracle["classified"]);
    let optimized = classified
        .iter()
        .map(|scene| prompt::optimize(scene, &pins))
        .collect::<Vec<_>>();
    assert_eq!(json!(optimized), oracle["optimized"]);
    assert_eq!(
        json!(optimizer_issues(&optimized, &pins)),
        oracle["optimizerErrors"]
    );
    let directory = tempfile::tempdir().unwrap();
    std::fs::create_dir(directory.path().join("data")).unwrap();
    for (name, value) in files.as_object().unwrap() {
        std::fs::write(
            directory.path().join("data").join(name),
            serde_json::to_vec(value).unwrap(),
        )
        .unwrap();
    }
    let mut actual = validate(directory.path(), &scenes);
    actual.sort();
    let mut expected = prompt::strings(&oracle["validation"]);
    expected.sort();
    assert_eq!(actual, expected);
}
