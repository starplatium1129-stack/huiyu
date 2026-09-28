use super::*;
use std::{
    io::Write,
    process::{Command, Stdio},
};

fn blueprint(id: &str, character: &str, outfit: &str) -> Value {
    json!({"id":id,"characterId":character,"outfitId":outfit,"title":"Neutral fixture","promptTokens":["cup"],"negativeTokens":[],"promptProse":"A cup beside a book.","modelId":"fixture-model","unknown":{"retained":true}})
}
fn input() -> Value {
    let a = blueprint("a", "alpha", "coat");
    let b = blueprint("b", "beta", "coat");
    let first = json!({"version":2,"franchise":"First's Set","blueprints":[a],"legacyExtension":"keep on no-op"});
    let second = json!({"version":2,"franchise":"Second Set","blueprints":[b]});
    json!({"manifest":{"version":1,"description":"Neutral manifest","files":[{"file":"a.json","franchise":"First's Set","count":99,"extension":{"10":"ten","2":"two","tiny":0.000001,"large":1e21}},{"file":"legacy.second.json","franchise":"Second Set","count":1}]},"shards":{"a.json":{"text":format!("\t{}\r\n",js(&first)),"data":first},"legacy.second.json":{"text":json_text(&second),"data":second}},"blueprints":[a,b],"franchiseByCharacter":{"alpha":"First's Set","beta":"Second Set","gamma":"New / Series"}})
}
#[test]
fn complete_plan_text_and_delta_match_the_original_node_planner() {
    let base = input();
    let mut moved = base.clone();
    let mut a = base["blueprints"][0].clone();
    a["characterId"] = json!("beta");
    a["outfitId"] = json!("coat");
    moved["blueprints"] = json!([base["blueprints"][1], a, blueprint("c", "gamma", "coat")]);
    let mut unknown = base.clone();
    unknown["blueprints"][0]["characterId"] = json!("missing");
    let mut reserved = base.clone();
    reserved["franchiseByCharacter"]["gamma"] = json!("CON");
    reserved["blueprints"]
        .as_array_mut()
        .unwrap()
        .push(blueprint("c", "gamma", "coat"));
    let change =
        json!({"upsert":[moved["blueprints"][1],blueprint("c","gamma","coat")],"remove":["b"]});
    let cases =
        json!({"plans":[base,moved,unknown,reserved],"current":base["blueprints"],"change":change});
    let oracle =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("src/maintenance/blueprints/legacy-oracle.cjs");
    let mut command = Command::new("node");
    command
        .arg(oracle)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut process = command.spawn().unwrap();
    process
        .stdin
        .take()
        .unwrap()
        .write_all(js(&cases).as_bytes())
        .unwrap();
    let output = process.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected: Value = serde_json::from_slice(&output.stdout).unwrap();
    for (index, case) in cases["plans"].as_array().unwrap().iter().enumerate() {
        let actual = match plan(case) {
            Ok(plan) => json!({"plan":plan}),
            Err(error) => json!({"problems":error.extra["problems"]}),
        };
        assert_eq!(actual, expected["plans"][index], "planner case {index}");
    }
    assert_eq!(
        json!(changed(cases["current"].as_array().unwrap(), &change).unwrap()),
        expected["delta"]
    );
}
fn write(root: &Path, file: &str, value: &Value) {
    let file = root.join(file);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, json_text(value)).unwrap();
}
#[test]
fn prepared_sources_refuse_stale_bytes_and_commit_exact_owned_shards() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("project");
    std::fs::create_dir(&root).unwrap();
    let fixture = input();
    write(&root, "data/blueprints/manifest.json", &fixture["manifest"]);
    for (name, shard) in fixture["shards"].as_object().unwrap() {
        std::fs::write(
            root.join("data/blueprints").join(name),
            shard["text"].as_str().unwrap(),
        )
        .unwrap();
    }
    write(
        &root,
        "data/scene-blueprints.json",
        &json!({"version":2,"blueprints":fixture["blueprints"]}),
    );
    write(
        &root,
        "data/popular/manifest.json",
        &json!({"version":1,"files":[{"file":"people.json","franchise":"Fixture","count":3}]}),
    );
    write(
        &root,
        "data/popular/people.json",
        &json!({"characters":[{"id":"alpha","franchise":"First's Set","outfits":[{"id":"coat"}]},{"id":"beta","franchise":"Second Set","outfits":[{"id":"coat"}]},{"id":"gamma","franchise":"New / Series","outfits":[{"id":"coat"}]}]}),
    );
    let options = Options {
        assets_root: None,
        root: root.clone(),
        runtime: temp.path().join("runtime"),
        showcase: None,
    };
    let previous = load(&root).unwrap();
    let mut incoming = previous.clone();
    incoming[0]["title"] = json!("Edited neutral fixture");
    let prepared = prepare(&options, &incoming, &previous).unwrap();
    let first = std::fs::read(root.join("data/blueprints/a.json")).unwrap();
    let mut changed_source =
        std::fs::read(root.join("data/blueprints/legacy.second.json")).unwrap();
    changed_source.push(b'\n');
    std::fs::write(
        root.join("data/blueprints/legacy.second.json"),
        changed_source,
    )
    .unwrap();
    let mut transaction = Transaction::acquire(&options).unwrap();
    transaction
        .prepare(&prepared.targets(), "blueprint-stale-fixture")
        .unwrap();
    assert!(prepared.apply(&transaction).is_err());
    assert_eq!(
        std::fs::read(root.join("data/blueprints/a.json")).unwrap(),
        first
    );
    transaction.rollback().unwrap();
    let previous = load(&root).unwrap();
    let mut invalid = incoming.clone();
    invalid[0]["outfitId"] = json!("unowned");
    assert!(prepare(&options, &invalid, &previous).is_err());
    incoming[1]["characterId"] = json!("gamma");
    let prepared = prepare(&options, &incoming, &previous).unwrap();
    let plan = prepared.plan().clone();
    let mut transaction = Transaction::acquire(&options).unwrap();
    transaction
        .prepare(&prepared.targets(), "blueprint-valid-fixture")
        .unwrap();
    prepared.apply(&transaction).unwrap();
    transaction.commit().unwrap();
    assert!(!root.join("data/blueprints/legacy.second.json").exists());
    assert!(root.join("data/blueprints/new-series.json").is_file());
    assert_eq!(load(&root).unwrap(), incoming);
    assert!(store::aggregate_is_current(&root).unwrap());
    assert_eq!(
        std::fs::read(root.join("data/scene-blueprints.json")).unwrap(),
        plan["aggregate"]["text"].as_str().unwrap().as_bytes()
    );
    assert_eq!(load(&root).unwrap()[1]["unknown"], json!({"retained":true}));
}
