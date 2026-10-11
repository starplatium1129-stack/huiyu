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

#[test]
fn unmasked_img2img_samples_the_encoded_original_with_requested_denoise() {
    let original = "aics_anima_input_0123456789abcdef.png";
    let mut actual = Vec::new();
    let mut expected = Vec::new();
    for (model, first, decoded, empty) in [
        (json!({"modelId":"anima-miaomiao-v1.6"}), "7", "8", "6"),
        (
            json!({"modelId":"anima-base-v1.0","loraId":"L_NENE_V21_ANIMA","loraStrength":0.85,"character":"nene"}),
            "8",
            "9",
            "7",
        ),
    ] {
        let mut body = model;
        body.as_object_mut().unwrap().extend(
            json!({"prompt":"a clear illustrated scene","width":832,"height":1216,"seed":42,"initImage":original,"denoisingStrength":0.6})
                .as_object().unwrap().clone(),
        );
        for upscaler in [None, Some("Latent"), Some("Remacri")] {
            body["hiresFix"] = json!(upscaler.is_some());
            body["hiresUpscaler"] = json!(upscaler);
            let mut input = images::validate(&body, "anima", true).unwrap();
            assert_eq!(input["initImage"], original);
            assert!(input["maskImage"].is_null() && input["maskPrompt"].is_null());
            if upscaler == Some("Remacri") {
                input["superResModel"] = json!("4x_foolhardy_Remacri.safetensors");
            }
            let graph = images::build_workflow(&input).unwrap();
            assert_eq!(graph["15"]["inputs"]["image"], original);
            assert_eq!(graph["19"]["inputs"]["image"], json!(["15", 0]));
            assert_eq!(graph["18"]["class_type"], "VAEEncode");
            assert_eq!(graph["18"]["inputs"]["pixels"], json!(["19", 0]));
            assert_eq!(graph["18"]["inputs"]["vae"], json!(["3", 0]));
            assert!(graph.get("17").is_none() && graph.get("30").is_none());
            match upscaler {
                None => assert_eq!(graph["10"]["inputs"]["images"], json!([decoded, 0])),
                Some("Latent") => {
                    assert_eq!(graph["11"]["inputs"]["samples"], json!([first, 0]));
                    assert_eq!(graph["12"]["inputs"]["latent_image"], json!(["11", 0]));
                    assert_eq!(graph["12"]["inputs"]["denoise"], 0.35);
                    assert_eq!(graph[decoded]["inputs"]["samples"], json!(["12", 0]));
                    assert_eq!(graph["35"]["inputs"]["image"], json!([decoded, 0]));
                    assert_eq!(graph["10"]["inputs"]["images"], json!(["35", 0]));
                }
                Some("Remacri") => {
                    assert_eq!(graph["20"]["inputs"]["samples"], json!([first, 0]));
                    assert_eq!(graph["22"]["inputs"]["image"], json!(["20", 0]));
                    assert_eq!(graph["23"]["inputs"]["image"], json!(["22", 0]));
                    assert_eq!(graph["10"]["inputs"]["images"], json!(["23", 0]));
                    assert_eq!(
                        graph
                            .as_object()
                            .unwrap()
                            .values()
                            .filter(|node| node["class_type"] == "KSampler")
                            .count(),
                        1
                    );
                }
                _ => unreachable!(),
            }
            let case = json!({"model":body["modelId"],"upscaler":upscaler});
            actual.push(json!({"case":case,"latent":graph[first]["inputs"]["latent_image"],"denoise":graph[first]["inputs"]["denoise"]}));
            expected.push(json!({"case":case,"latent":["18",0],"denoise":0.6}));
        }
        body["hiresFix"] = json!(false);
        body.as_object_mut().unwrap().remove("denoisingStrength");
        let input = images::validate(&body, "anima", true).unwrap();
        let graph = images::build_workflow(&input).unwrap();
        actual.push(
            json!({"case":body["modelId"],"defaultDenoise":graph[first]["inputs"]["denoise"]}),
        );
        expected.push(json!({"case":body["modelId"],"defaultDenoise":0.8}));

        body["initImage"] = Value::Null;
        body["denoisingStrength"] = json!(0.6);
        let graph =
            images::build_workflow(&images::validate(&body, "anima", true).unwrap()).unwrap();
        assert_eq!(graph[first]["inputs"]["latent_image"], json!([empty, 0]));
        assert_eq!(graph[first]["inputs"]["denoise"], 1.);
    }
    assert_eq!(actual, expected);
}

#[test]
fn inpaint_hires_keeps_mask_and_reference_aligned_through_final_composite() {
    let body = json!({"prompt":"a new jacket","modelId":"anima-miaomiao-v1.6","width":832,"height":1216,"seed":42,"hiresFix":true,"hiresScale":1.3125,"hiresDenoise":0.4,"initImage":"aics_anima_input_0123456789abcdef.png","maskImage":"aics_anima_input_abcdef0123456789.png","denoisingStrength":0.65});
    let mut input = images::validate(&body, "anima", true).unwrap();
    for super_res in [false, true] {
        input["superResModel"] = if super_res {
            json!("4x_foolhardy_Remacri.safetensors")
        } else {
            Value::Null
        };
        let graph = images::build_workflow(&input).unwrap();
        assert_eq!(graph["7"]["inputs"]["latent_image"], json!(["17", 0]));
        assert_eq!(graph["7"]["inputs"]["denoise"], 0.65);
        assert_eq!(
            graph["hires_mask_image"]["inputs"]["mask"],
            graph["17"]["inputs"]["mask"]
        );
        // The latent branch rounds at latent resolution using ties-to-even;
        // the pixel-upscale branch keeps its existing 8-pixel rounding.
        for id in ["hires_mask_scale", "hires_reference"] {
            assert_eq!(
                graph[id]["inputs"]["width"],
                if super_res { 1096 } else { 1088 }
            );
            assert_eq!(graph[id]["inputs"]["height"], 1600);
        }
        assert_eq!(
            graph["hires_mask_scale"]["inputs"]["upscale_method"],
            "nearest-exact"
        );
        assert_eq!(
            graph["hires_reference"]["inputs"]["image"],
            json!(["19", 0])
        );
        assert_eq!(
            graph["hires_noise_mask"]["class_type"],
            "SetLatentNoiseMask"
        );
        assert_eq!(
            graph["hires_noise_mask"]["inputs"]["samples"],
            json!([if super_res { "23" } else { "32" }, 0])
        );
        let sampler = if super_res { "24" } else { "33" };
        assert_eq!(
            graph[sampler]["inputs"]["latent_image"],
            json!(["hires_noise_mask", 0])
        );
        assert_eq!(graph[sampler]["inputs"]["denoise"], 0.4);
        assert_eq!(
            graph["hires_composite"]["inputs"]["mask"],
            graph["hires_noise_mask"]["inputs"]["mask"]
        );
        assert_eq!(
            graph["hires_composite"]["inputs"]["destination"],
            json!(["hires_reference", 0])
        );
        assert_eq!(
            graph["hires_composite"]["inputs"]["source"],
            json!([if super_res { "25" } else { "35" }, 0])
        );
        if !super_res {
            assert_eq!(graph["35"]["inputs"]["image"], json!(["34", 0]));
        }
        assert_eq!(
            graph["10"]["inputs"]["images"],
            json!(["hires_composite", 0])
        );
    }
    input["hiresFix"] = json!(false);
    let graph = images::build_workflow(&input).unwrap();
    assert_eq!(graph["7"]["inputs"]["latent_image"], json!(["17", 0]));
    assert_eq!(graph["7"]["inputs"]["denoise"], 0.65);
    assert_eq!(graph["10"]["inputs"]["images"], json!(["30", 0]));
    assert!(graph.get("hires_composite").is_none());
}

// Moved from test-prompt-compiler.ts when the retired Node graph builder was
// removed. These exercise the product compiler after the actual JSON boundary.
#[test]
fn endfield_collection_is_restricted_to_its_cast_and_native_anima_models() {
    let body = json!({"prompt":"rossi \\(arknights\\), 1girl, solo","modelId":"anima-miaomiao-v1.6","width":832,"height":1216,"seed":42,"character":"rossy_arknights","loraId":"L_ENDFIELD_ALL_V1_ANIMA","loraStrength":1});
    let input = images::validate(&body, "anima", true).unwrap();
    let graph = images::build_workflow(&input).unwrap();
    assert_eq!(
        graph["4"]["inputs"]["lora_name"],
        "endfield_all_v3-000012.safetensors"
    );
    assert_eq!(graph["5"]["inputs"]["text"], body["prompt"]);
    for character in ["nene", "frieren", "typhon_arknights"] {
        let mut invalid = body.clone();
        invalid["character"] = json!(character);
        assert_eq!(
            images::validate(&invalid, "anima", true).unwrap_err().code,
            "INCOMPATIBLE_CHARACTER"
        );
    }
    let mut expanded = body;
    expanded["modelId"] = json!("anima-miaomiao-2.9b-beta1.1");
    assert_eq!(
        images::validate(&expanded, "anima", true).unwrap_err().code,
        "INCOMPATIBLE_MODEL_LORA"
    );
}

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
