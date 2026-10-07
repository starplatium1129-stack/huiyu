use super::*;
use std::io::Write;

fn write(root: &Path, file: &str, value: &Value) {
    let path = root.join(file);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, serde_json::to_string_pretty(value).unwrap() + "\n").unwrap();
}
pub(in crate::maintenance) fn fixture(root: &Path) {
    std::fs::create_dir_all(root.join("assets")).unwrap();
    std::fs::write(root.join("assets/neutral.png"), b"neutral fixture").unwrap();
    write(
        root,
        "data/characters.json",
        &json!([{"id":"nene","name":"Neutral","source":"Fixture","speech":"Fixture","portrait":{"image":"../assets/neutral.png"},"visual_dna":{"signature":"neutral"},"traits":["a","b","c"],"lora":{"name":"neutral","weight":1}}]),
    );
    write(
        root,
        "data/loras.json",
        &json!([{"id":"neutral","name":"neutral","strength":{"min":0,"default":1,"max":2},"compatible_models":["fixture"],"test_scene":["scene"]}]),
    );
    let scenes =
        json!([{"id":"scene","char":"nene","prompt":"neutral room","rating":"All","mature":false}]);
    for file in ["scenes.json", "scenes-core.json", "scenes-nene.json"] {
        write(root, &format!("data/{file}"), &scenes);
    }
    for file in [
        "scenes-natsume.json",
        "scenes-shared.json",
        "curation.json",
        "tags.json",
        "presets.json",
    ] {
        write(root, &format!("data/{file}"), &json!([]));
    }
    write(
        root,
        "data/scenes-index.json",
        &json!({"total":1,"tiers":{"core":["scene"]},"orderedIds":["scene"]}),
    );
    write(
        root,
        "data/popular-characters.json",
        &json!({"characters":[{"id":"fixture","displayName":"Fixture","originalName":"Fixture","franchise":"Fixture","aliases":[],"identityProse":"A neutral character.","identityTokens":["silver_hair"],"exactTokens":[],"exactPrefixes":[],"recommendedEngine":"anima","adultEligibility":"adult","outfits":[{"id":"default","name":"Default","prose":"A plain shirt.","tokens":["shirt"],"default":true}]}]}),
    );
    let blueprints:Vec<_>=(0..20).map(|i|json!({"id":format!("fixture-{i}"),"title":"Fixture","category":"neutral","description":"Neutral test record","characterId":"fixture","location":"room","action":"standing","timeOfDay":"day","lighting":"soft","camera":"wide","mood":"calm","sceneTags":["room"],"promptProse":"A neutral room.","promptTokens":["room"],"negativeTokens":"blur, artifact","recommendedSize":"1024x1024","adult":i==19,"outfitId":"default"})).collect();
    write(
        root,
        "data/scene-blueprints.json",
        &json!({"blueprints":blueprints}),
    );
    write(
        root,
        "data/character-reference-view.json",
        &json!({"fixture":{"outfits":[{"outfitId":"default","references":[{"pending":true}]}]}}),
    );
    std::fs::create_dir_all(root.join("src/stores")).unwrap();
    std::fs::write(
        root.join("src/stores/sceneStore.ts"),
        "import { DATA_VERSION } from 'virtual:data-version'\n",
    )
    .unwrap();
    let mut compressed = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    compressed
        .write_all(&std::fs::read(root.join("data/scenes.json")).unwrap())
        .unwrap();
    std::fs::write(
        root.join("data/scenes.json.gz"),
        compressed.finish().unwrap(),
    )
    .unwrap();
}
fn old_issues(root: &Path) -> Vec<String> {
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/maintenance/contracts/oracle.cjs");
    let result = std::process::Command::new("node")
        .arg(script)
        .arg(root)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    serde_json::from_slice(&result.stdout).unwrap_or_else(|e| {
        panic!(
            "{e}: {} / {}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        )
    })
}
#[test]
fn content_gate_matches_node_and_rejects_stale_products_and_pollution() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    fixture(root);
    let options = Options {
        assets_root: None,
        root: root.into(),
        runtime: root.join("runtime"),
        showcase: None,
    };
    let initial_issues = old_issues(root);
    assert!(initial_issues.is_empty(), "{initial_issues:?}");
    let audit = validate_with(&options, std::collections::HashMap::new()).unwrap();
    assert_eq!(audit["referenceAudit"]["pending"], 1);
    let source = DataRoot {
        path: root,
        overrides: std::collections::HashMap::new(),
    };
    let mut popular = read(&source, "data/popular-characters.json").unwrap();
    popular["characters"][0]["identityTokens"] = json!(["ayachi_nene", "beach"]);
    popular["characters"][0]["outfits"][0]["default"] = json!(false);
    write(root, "data/popular-characters.json", &popular);
    let mut blueprints = read(&source, "data/scene-blueprints.json").unwrap();
    blueprints["blueprints"][0]["kreaStyleHint"] = json!("r18_sensual_cg");
    blueprints["blueprints"][1]["identityTokensOverride"] = json!(["ayachi_nene"]);
    blueprints["blueprints"][2]["identityProseOverride"] = json!("official_cg");
    blueprints["blueprints"][3]["identityTokensOverride"] = json!([]);
    write(root, "data/scene-blueprints.json", &blueprints);
    let mut scenes = read(&source, "data/scenes.json").unwrap();
    scenes[0]["mature"] = json!(true);
    write(root, "data/scenes.json", &scenes);
    let mut old = old_issues(root);
    old.sort();
    for issue in [
        "blueprint fixture-1 must not reference nene/natsume tokens",
        "blueprint fixture-2 must not leak retrieval metadata",
        "scene-blueprints.json must contain at least 20 blueprints",
    ] {
        assert!(old.iter().any(|found| found == issue), "{issue}: {old:?}");
    }
    let error = validate_with(&options, std::collections::HashMap::new()).unwrap_err();
    let mut current: Vec<_> = list(&error.extra["issues"])
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    current.sort();
    assert_eq!(current, old);
    let provenance: Value = serde_json::from_str(include_str!("sources.json")).unwrap();
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    for source in list(&provenance["sources"]) {
        assert_eq!(
            super::super::codec::digest(
                std::fs::read(repo.join(source["path"].as_str().unwrap())).unwrap()
            ),
            source["sha256"].as_str().unwrap()
        );
    }
}
