use super::*;
fn node(class: &str, inputs: Value) -> Value {
    json!({"class_type":class,"inputs":inputs})
}
pub fn build(input: &Value, t8: bool) -> Value {
    if input["modelId"] == "minimax-h3" {
        h3(input, t8)
    } else {
        wan(input)
    }
}
fn h3(input: &Value, t8: bool) -> Value {
    let mut graph = json!({"1":node("UNETLoader",json!({"unet_name":"minimax_h3_fl2va_pruned_int8_convrot.safetensors","weight_dtype":"default"})),"2":node("CLIPLoader",json!({"clip_name":"qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors","type":"minimax","device":"default"})),"3":node("VAELoader",json!({"vae_name":"minimax_h3_video_vae_fp16.safetensors"})),"4":node("VAELoader",json!({"vae_name":"minimax_h3_audio_vae_fp32.safetensors"}))});
    let image = generation::truthy(&input["image"]);
    let last = generation::truthy(&input["lastFrame"]);
    let references = input["references"].as_array().filter(|a| !a.is_empty());
    if t8 {
        let task = if references.is_some() {
            if image || last { "Hybrid" } else { "Ref2VA" }
        } else if image && last {
            "FL2VA"
        } else if image {
            "I2VA"
        } else if last {
            "L2VA"
        } else {
            "T2VA"
        };
        graph["5"] = node(
            "MiniMaxH3AudioConditioningT8",
            json!({"clip":["2",0],"video_vae":["3",0],"audio_vae":["4",0],"prompt":input["prompt"],"width":input["width"],"height":input["height"],"length":input["frames"],"task_type":task,"audio_mode":"native","audio_denoise_strength":1,"add_source_as_reference":false,"prompt_primary_audio_ordinal":0,"strict_prompt_tags":true,"ref_image_size":"match","reference_video_policy":"official_2_to_15s"}),
        );
        graph["15"] = node(
            "LoraLoaderBypassModelOnly",
            json!({"model":["1",0],"lora_name":"minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors","strength_model":1}),
        );
        graph["16"] = node(
            "MiniMaxH3DualClockSamplerT8",
            json!({"model":["15",0],"av_latent":["5",1],"steps":input["steps"],"shift_video":12,"shift_audio":3}),
        );
    } else {
        graph["5"] = node(
            "MiniMaxH3ImageToVideo",
            json!({"clip":["2",0],"vae":["3",0],"prompt":input["prompt"],"width":input["width"],"height":input["height"],"length":input["frames"]}),
        );
        graph["15"] = node(
            "LoraLoaderModelOnly",
            json!({"model":["1",0],"lora_name":"minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors","strength_model":1}),
        );
        graph["16"] = node(
            "MiniMaxH3SigmaShift",
            json!({"model":["15",0],"shift_video":12,"shift_audio":3}),
        );
        graph["7"] = node("KSamplerSelect", json!({"sampler_name":"euler"}));
        graph["8"] = node(
            "BasicScheduler",
            json!({"model":["16",0],"scheduler":"simple","steps":input["steps"],"denoise":1}),
        );
    }
    graph["6"] = node("RandomNoise", json!({"noise_seed":input["seed"]}));
    graph["9"] = node(
        "BasicGuider",
        json!({"model":["16",0],"conditioning":["5",0]}),
    );
    graph["10"] = node(
        "SamplerCustomAdvanced",
        json!({"noise":["6",0],"guider":["9",0],"sampler":if t8{json!(["16",1])}else{json!(["7",0])},"sigmas":if t8{json!(["16",2])}else{json!(["8",0])},"latent_image":["5",1]}),
    );
    if t8 {
        graph["12"] = node(
            "MiniMaxH3AVDecodeT8",
            json!({"av_latent":["10",0],"video_vae":["3",0],"audio_vae":["4",0]}),
        );
    } else {
        graph["12"] = node("VAEDecode", json!({"samples":["10",0],"vae":["3",0]}));
        graph["13"] = node("VAEDecodeAudio", json!({"samples":["10",0],"vae":["4",0]}));
    }
    graph["14"] = node(
        "CreateVideo",
        json!({"images":["12",0],"audio":if t8{json!(["12",1])}else{json!(["13",0])},"fps":input["fps"],"bit_depth":8}),
    );
    graph["11"] = node(
        "SaveVideo",
        json!({"video":["14",0],"filename_prefix":"aics_video","format":"auto","codec":"auto"}),
    );
    if image {
        graph["17"] = node("LoadImage", json!({"image":input["image"]}));
        graph["5"]["inputs"]["first_frame"] = json!(["17", 0]);
    }
    if last {
        graph["18"] = node("LoadImage", json!({"image":input["lastFrame"]}));
        graph["5"]["inputs"]["last_frame"] = json!(["18", 0]);
    }
    if t8 && let Some(references) = references {
        for (index, name) in references.iter().enumerate() {
            let id = (21 + index).to_string();
            graph[&id] = node("LoadImage", json!({"image":name}));
            graph["5"]["inputs"][format!("ref_images.ref_image_{index}")] = json!([id, 0]);
        }
    }
    graph
}
fn wan(input: &Value) -> Value {
    json!({
        "1":node("UNETLoader",json!({"unet_name":"wan2.2_ti2v_5B_fp16.safetensors","weight_dtype":"default"})),
        "2":node("CLIPLoader",json!({"clip_name":"umt5_xxl_fp8_e4m3fn_scaled.safetensors","type":"wan","device":"default"})),
        "3":node("VAELoader",json!({"vae_name":"wan2.2_vae.safetensors"})),
        "4":node("CLIPTextEncode",json!({"clip":["2",0],"text":input["prompt"]})),"5":node("CLIPTextEncode",json!({"clip":["2",0],"text":input["negative"]})),
        "6":node("ModelSamplingSD3",json!({"model":["1",0],"shift":8})),"7":node("Wan22ImageToVideoLatent",json!({"vae":["3",0],"width":input["width"],"height":input["height"],"length":input["frames"],"batch_size":1})),
        "8":node("KSampler",json!({"model":["6",0],"positive":["4",0],"negative":["5",0],"latent_image":["7",0],"seed":input["seed"],"steps":input["steps"],"cfg":input["cfg"],"sampler_name":"uni_pc","scheduler":"simple","denoise":1})),
        "9":node("VAEDecode",json!({"samples":["8",0],"vae":["3",0]})),"10":node("CreateVideo",json!({"images":["9",0],"fps":input["fps"],"bit_depth":8})),"11":node("SaveVideo",json!({"video":["10",0],"filename_prefix":"aics_video","format":"auto","codec":"auto"}))
    })
}
