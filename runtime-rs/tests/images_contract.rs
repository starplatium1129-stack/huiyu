use huiyu_runtime::{images, storage::fingerprint};
use serde_json::{Value, json};
use std::{
    io::Write,
    path::Path,
    process::{Command, Stdio},
};

fn raw(model: &str, lora: bool) -> Value {
    let mut input = json!({"prompt":"literal_trigger, a clear illustrated scene","negative":"source_negative_anchor","modelId":model,"width":832,"height":1216,"seed":271828});
    if lora {
        input["loraId"] = json!("L_NENE_V21_ANIMA");
        input["loraStrength"] = json!(0.85);
        input["character"] = json!("nene");
    }
    input
}
fn legacy(cases: &[Value]) -> Value {
    let oracle = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/images-legacy-oracle.cjs");
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
    let mut node = command
        .spawn()
        .expect("Node remains the frontend build and migration oracle dependency");
    node.stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(cases).unwrap())
        .unwrap();
    let output = node.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
#[test]
fn node_validation_and_every_image_graph_branch_keep_exact_compiled_input() {
    let mut cases = Vec::new();
    for model in [
        "anima-base-v1.0",
        "anima-aesthetic-v1.1",
        "anima-yume-v1.0",
        "anima-2.9b-preview-v1",
        "anima-miaomiao-v1.2",
        "anima-miaomiao-v1.6",
    ] {
        cases.push(json!({"family":"anima","input":raw(model,model=="anima-base-v1.0")}));
    }
    for lora in [false, true] {
        for mask in ["none", "image", "prompt"] {
            for pixels in [false, true] {
                let mut input = raw("anima-miaomiao-v1.6", lora);
                input["hiresFix"] = json!(true);
                input["hiresScale"] = json!(2);
                input["hiresDenoise"] = json!(0.35);
                input["teaCacheThresh"] = json!(0);
                if mask != "none" {
                    input["initImage"] = json!("aics_anima_input_0123456789abcdef.png");
                    if mask == "image" {
                        input["maskImage"] = json!("aics_anima_input_abcdef0123456789.png");
                        input["growMaskBy"] = json!(0);
                    } else {
                        input["maskPrompt"] = json!("the jacket");
                        input["maskThreshold"] = json!(0.6);
                    }
                }
                let mut case = json!({"family":"anima","input":input});
                if pixels {
                    case["superResModel"] = json!("4x_foolhardy_Remacri.safetensors");
                }
                cases.push(case);
            }
        }
    }
    for style in [None, Some("retroanime"), Some("darkbrush")] {
        let mut input = json!({"prompt":"A quiet illustrated scene with one adult character.","modelId":"krea2-turbo-fp8","width":1024,"height":1536,"seed":314159});
        if let Some(style) = style {
            input["styleLoraId"] = json!(style);
        }
        cases.push(json!({"family":"krea2","input":input}));
    }
    let mut wrong = raw("anima-base-v1.0", true);
    wrong["character"] = json!("natsume");
    cases.push(json!({"family":"anima","input":wrong}));
    cases.push(json!({"family":"krea2","input":raw("anima-miaomiao-v1.6",false)}));
    let expected = legacy(&cases);
    assert_eq!(
        fingerprint(&images::catalog()),
        fingerprint(&expected["catalog"]),
        "Model, LoRA, profile and parameter catalogs must match the Node source"
    );
    for (index, case) in cases.iter().enumerate() {
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
            fingerprint(&expected["cases"][index]),
            "case {index}\nRust: {}\nNode: {}",
            serde_json::to_string_pretty(&actual).unwrap(),
            serde_json::to_string_pretty(&expected["cases"][index]).unwrap()
        );
    }
}
