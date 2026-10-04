use super::*;

#[test]
fn video_ai_contracts_and_storyboard_preserve_fixed_expectations() {
    let legacy: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/video-ai-contract.json"
    ))
    .unwrap();
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
    let blueprint = &legacy["storyboards"][0]["blueprint"];
    for fixture in list(&legacy["storyboards"]) {
        assert_eq!(
            super::super::storyboard::resolve_blueprint(blueprint, &fixture["intent"]).unwrap(),
            fixture["result"]
        );
    }
    let mut adult = blueprint.clone();
    adult["adult"] = json!(true);
    adult["category"] = json!("neutral");
    assert_eq!(
        super::super::storyboard::resolve_blueprint(&adult, &Value::Null)
            .unwrap_err()
            .code,
        "ADULT_BLUEPRINT_UNSUPPORTED"
    );
}
