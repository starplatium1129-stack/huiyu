use huiyu_runtime::{storage::fingerprint, video};
use serde_json::{Value, json};

// Fixed migration contracts were captured from the legacy compiler before its
// oracle was retired. Changes require reviewing input/graph semantics, not
// regenerating expectations from the Rust implementation under test.
#[test]
fn video_validation_and_graphs_preserve_compiled_contracts() {
    let fixtures: Value =
        serde_json::from_str(include_str!("fixtures/video-contract.json")).unwrap();
    assert_eq!(
        fingerprint(&video::catalog()),
        fingerprint(&fixtures["catalog"])
    );
    for (index, fixture) in fixtures["cases"].as_array().unwrap().iter().enumerate() {
        let case = &fixture["case"];
        let result = if case["batch"] == true {
            video::validate_batch(&case["input"], case["local"] != false)
        } else {
            video::validate(
                &case["input"],
                case["local"] != false,
                case.get("imageSizes").map(|_| (600, 1000)),
            )
        };
        let actual = match result {
            Ok(input) => {
                let sources = if case["batch"] == true {
                    input["shots"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|s| s["input"].clone())
                        .collect()
                } else {
                    vec![input.clone()]
                };
                json!({"workflows":sources.iter().map(|s|video::build_workflow(s,case["t8"]==true)).collect::<Vec<_>>(),"input":input})
            }
            Err(e) => json!({"code":e.code,"status":e.status.as_u16()}),
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
