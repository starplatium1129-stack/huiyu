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
