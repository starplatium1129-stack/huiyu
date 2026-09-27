use super::*;
use sha2::{Digest, Sha256};

#[test]
fn video_ai_contracts_and_storyboard_match_the_node_sources() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut command = std::process::Command::new("node");
    command.arg(root.join("tests/video-ai-oracle.cjs"));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let legacy = command.output().unwrap();
    assert!(
        legacy.status.success(),
        "{}",
        String::from_utf8_lossy(&legacy.stderr)
    );
    let legacy: Value = serde_json::from_slice(&legacy.stdout).unwrap();
    for case in list(&legacy["cases"]) {
        let action = case["action"].as_str().unwrap();
        let value = validation::validate(action, &case["input"]);
        if let Some(message) = case["validation"]["error"].as_str() {
            assert_eq!(value.unwrap_err().message, message);
            continue;
        }
        let value = value.unwrap();
        assert_eq!(value, case["validation"]["value"], "{action}");
        assert_eq!(
            json!(prompts::messages(action, &value)),
            case["messages"],
            "{action}"
        );
        let wrapped = format!("```json\n{}\n```", case["parsed"]);
        assert_eq!(
            output::clean(action, &output::extract(&wrapped), &value),
            case["cleaned"],
            "{action}"
        );
    }
    let directory = tempfile::tempdir().unwrap();
    std::fs::create_dir(directory.path().join("data")).unwrap();
    let blueprint = &legacy["storyboards"][0]["blueprint"];
    std::fs::write(
        directory.path().join("data/scene-blueprints.json"),
        json!({"blueprints":[blueprint]}).to_string(),
    )
    .unwrap();
    for fixture in list(&legacy["storyboards"]) {
        assert_eq!(
            super::super::storyboard::resolve(
                directory.path(),
                &json!("fixture"),
                &fixture["intent"]
            )
            .unwrap(),
            fixture["result"]
        );
    }
    let mut adult = blueprint.clone();
    adult["adult"] = json!(true);
    adult["category"] = json!("neutral");
    std::fs::write(
        directory.path().join("data/scene-blueprints.json"),
        json!({"blueprints":[adult]}).to_string(),
    )
    .unwrap();
    assert_eq!(
        super::super::storyboard::resolve(directory.path(), &json!("fixture"), &Value::Null)
            .unwrap_err()
            .code,
        "ADULT_BLUEPRINT_UNSUPPORTED"
    );
    let sources: Value = serde_json::from_str(include_str!("sources.json")).unwrap();
    for source in list(&sources["sources"]) {
        assert_eq!(
            hex::encode(Sha256::digest(
                std::fs::read(
                    root.parent()
                        .unwrap()
                        .join(source["path"].as_str().unwrap())
                )
                .unwrap()
            )),
            source["sha256"].as_str().unwrap()
        );
    }
}
