use huiyu_runtime::{storage::fingerprint, video};
use serde_json::{Value, json};
use std::{
    io::Write,
    path::Path,
    process::{Command, Stdio},
};
fn raw(model: &str) -> Value {
    json!({"modelId":model,"prompt":"A quiet riverside at dusk, soft rain on the water.","aspectRatio":"landscape","camera":"still","motion":"subtle","duration":3,"seed":314159})
}
#[test]
fn node_video_validation_prose_and_graphs_match_every_executable_mode() {
    let mut cases = Vec::new();
    for model in ["wan2.2-ti2v-5b", "minimax-h3"] {
        for t8 in [false, true] {
            for duration in if model == "minimax-h3" {
                vec![3, 5, 10, 15]
            } else {
                vec![3, 5]
            } {
                let mut input = raw(model);
                input["duration"] = json!(duration);
                cases.push(json!({"input":input,"t8":t8}));
            }
        }
    }
    for mode in ["first", "last", "both", "reference", "hybrid"] {
        let mut input = raw("minimax-h3");
        if ["first", "both", "hybrid"].contains(&mode) {
            input["image"] = json!("aics_video_input_0123456789abcdef.png");
        }
        if ["last", "both"].contains(&mode) {
            input["lastFrame"] = json!("aics_video_input_fedcba9876543210.png");
        }
        if ["reference", "hybrid"].contains(&mode) {
            input["references"] = json!(["aics_video_ref_0123456789abcdef.png"]);
        }
        input["dialogue"] = json!("  今日はいい天気ですね。  ");
        input["dialogueLang"] = json!("auto");
        cases.push(json!({"input":input,"t8":true,"allowImages":true}));
    }
    for quality in ["fast", "standard", "fine"] {
        let mut input = raw("minimax-h3");
        input["quality"] = json!(quality);
        input["aspectRatio"] = json!("original");
        input["image"] = json!("aics_video_input_0123456789abcdef.png");
        cases.push(json!({"input":input,"imageSizes":{"aics_video_input_0123456789abcdef.png":{"width":600,"height":1000}}}));
    }
    cases.push(json!({"input":{"modelId":"minimax-h3","aspectRatio":"square","shots":[{"prompt":"A quiet room","seed":1},{"prompt":"A calm forest","seed":2}]},"batch":true}));
    let mut adult = raw("minimax-h3");
    adult["prompt"] = json!("nsfw nude");
    cases.push(json!({"input":adult,"local":false}));
    cases.push(json!({"input":raw("wan2.2-14b")}));
    let mut command = Command::new("node");
    command
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/video-legacy-oracle.cjs"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut node = command.spawn().unwrap();
    node.stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(&cases).unwrap())
        .unwrap();
    let output = node.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        fingerprint(&video::catalog()),
        fingerprint(&expected["catalog"])
    );
    for (index, case) in cases.iter().enumerate() {
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
            fingerprint(&expected["cases"][index]),
            "case {index}\nRust: {}\nNode: {}",
            serde_json::to_string_pretty(&actual).unwrap(),
            serde_json::to_string_pretty(&expected["cases"][index]).unwrap()
        );
    }
}
