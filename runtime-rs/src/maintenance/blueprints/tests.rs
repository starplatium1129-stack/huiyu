use super::*;
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
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/legacy-blueprint-plans.json"
    ))
    .unwrap();
    for (index, case) in fixture["cases"].as_array().unwrap().iter().enumerate() {
        let input = &case["input"];
        let mut actual = match plan(input) {
            Ok(plan) => json!({"plan":plan}),
            Err(error) => json!({"problems":error.extra["problems"]}),
        };
        let mut expected = case["expected"].clone();
        // Serde and V8 provide different JSON parser diagnostics. Keep the
        // exact project message/file and require a diagnostic on both paths.
        for result in [&mut actual, &mut expected] {
            if let Some(problems) = result["problems"].as_array_mut() {
                for problem in problems {
                    if let Some((prefix, detail)) =
                        problem.as_str().unwrap().split_once("text 不是合法 JSON:")
                    {
                        assert!(!detail.trim().is_empty());
                        *problem = format!("{prefix}text 不是合法 JSON:<parser diagnostic>").into();
                    }
                }
            }
        }
        assert_eq!(actual, expected, "planner case {index}: {}", case["titles"]);
    }
    let delta = &fixture["delta"];
    assert_eq!(
        json!(changed(delta["current"].as_array().unwrap(), &delta["change"]).unwrap()),
        delta["expected"]
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
