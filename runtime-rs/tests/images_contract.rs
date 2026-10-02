use huiyu_runtime::{images, storage::fingerprint};
use serde_json::{Value, json};

// Fixed migration contracts were captured from the legacy compiler before its
// oracle was retired. Changes require reviewing input/graph semantics, not
// regenerating expectations from the Rust implementation under test.
#[test]
fn images_validation_and_graphs_preserve_compiled_contracts() {
    let fixtures: Value =
        serde_json::from_str(include_str!("fixtures/images-contract.json")).unwrap();
    assert_eq!(
        fingerprint(&images::catalog()),
        fingerprint(&fixtures["catalog"])
    );
    for (index, fixture) in fixtures["cases"].as_array().unwrap().iter().enumerate() {
        let case = &fixture["case"];
        let actual = match images::validate(&case["input"], case["family"].as_str().unwrap(), true)
        {
            Ok(mut input) => {
                if let Some(model) = case.get("superResModel") {
                    input["superResModel"] = model.clone();
                }
                json!({"workflow":images::build_workflow(&input).unwrap(),"input":input})
            }
            Err(error) => json!({"code":error.code,"status":error.status.as_u16()}),
        };
        assert_eq!(
            fingerprint(&actual),
            fingerprint(&fixture["expected"]),
            "case {index}\nRust: {}\nContract: {}",
            serde_json::to_string_pretty(&actual).unwrap(),
            serde_json::to_string_pretty(&fixture["expected"]).unwrap()
        );
    }
}

// Moved from test-prompt-compiler.ts when the retired Node graph builder was
// removed. These exercise the product compiler after the actual JSON boundary.
#[test]
fn artist_escape_transport_preserves_positive_text_in_both_anima_branches() {
    for artist in [
        r"@ask \(askzy\)",
        r"@hiten \(hitenkei\)",
        r"@lam \(ramdayo\)",
        r"@solar \(happymonk\)",
    ] {
        let prompt = format!("1girl, {artist}, (soft lighting:1.2)");
        for model in [
            json!({"modelId":"anima-miaomiao-v1.2"}),
            json!({"modelId":"anima-base-v1.0","loraId":"L_NENE_V21_ANIMA","loraStrength":0.85,"character":"nene"}),
        ] {
            let mut body = model;
            body.as_object_mut().unwrap().extend(
                json!({"prompt":prompt,"width":832,"height":1216,"seed":42})
                    .as_object()
                    .unwrap()
                    .clone(),
            );
            let transported: Value =
                serde_json::from_slice(&serde_json::to_vec(&body).unwrap()).unwrap();
            let input = images::validate(&transported, "anima", true).unwrap();
            let graph = images::build_workflow(&input).unwrap();
            let sampler = graph
                .as_object()
                .unwrap()
                .values()
                .find(|node| node["class_type"] == "KSampler")
                .unwrap();
            let positive = &graph[sampler["inputs"]["positive"][0].as_str().unwrap()];
            assert_eq!(positive["class_type"], "CLIPTextEncode");
            assert_eq!(positive["inputs"]["text"], prompt);
        }
    }
}

#[test]
fn krea_style_and_sampling_limits_preserve_the_retired_route_contract() {
    let body = json!({"prompt":"A rainy cafe scene.","modelId":"krea2-turbo-fp8","width":1024,"height":1024,"seed":7});
    for (width, height) in [(1024, 1024), (1024, 1536), (1536, 1024)] {
        let mut sized = body.clone();
        sized["width"] = json!(width);
        sized["height"] = json!(height);
        let input = images::validate(&sized, "krea2", true).unwrap();
        assert_eq!(input["width"], width);
        assert_eq!(input["height"], height);
        assert_eq!(input["steps"], 12);
        assert_eq!(input["cfg"], 1);
    }
    for (key, value) in [
        ("steps", json!(7)),
        ("cfg", json!(3)),
        ("loraId", json!("L_NENE_V21_ANIMA")),
        ("negative", json!("bad anatomy")),
        ("styleLoraId", json!("not-approved")),
    ] {
        let mut invalid = body.clone();
        invalid[key] = value;
        assert_eq!(
            images::validate(&invalid, "krea2", true)
                .unwrap_err()
                .status
                .as_u16(),
            400,
            "{key}"
        );
    }
    let mut styled = body;
    styled["styleLoraId"] = json!("rainywindow");
    let graph = images::build_workflow(&images::validate(&styled, "krea2", true).unwrap()).unwrap();
    assert_eq!(graph["12"]["class_type"], "LoraLoaderModelOnly");
    assert_eq!(
        graph["12"]["inputs"]["lora_name"],
        "krea2_rainywindow.safetensors"
    );
    assert_eq!(graph["12"]["inputs"]["strength_model"], 1);
    // The full unstyled rebalance/enhancer/sharpen graph is already checked by
    // the historical fixture above; here verify the additional style routing.
    assert_eq!(graph["14"]["inputs"]["model"], json!(["12", 0]));
    let anima = json!({"prompt":"x","modelId":"anima-base-v1.0","loraId":"L_NENE_V21_ANIMA","loraStrength":0.85,"width":832,"height":1216,"character":"nene","styleLoraId":"rainywindow"});
    assert_eq!(
        images::validate(&anima, "anima", true).unwrap_err().code,
        "WRONG_ROUTE_FAMILY"
    );
}
