use super::*;
use crate::generation::truthy;
fn node(class: &str, inputs: Value) -> Value {
    json!({"class_type":class,"inputs":inputs})
}
fn link(id: &str, index: u32) -> Value {
    json!([id, index])
}
fn number(input: &Value, key: &str, default: f64) -> f64 {
    input[key]
        .as_f64()
        .filter(|_| truthy(&input[key]))
        .unwrap_or(default)
}
fn sample(
    input: &Value,
    model: Value,
    positive: &str,
    negative: &str,
    latent: Value,
    hires: bool,
) -> Value {
    let contract = catalog::contract();
    let model_defaults = &catalog::CATALOG["MODELS"][input["modelId"].as_str().unwrap()];
    let sampler = model_defaults
        .get("hiresSampler")
        .unwrap_or(&contract["HIRES_SAMPLER"]);
    let scheduler = model_defaults
        .get("hiresScheduler")
        .unwrap_or(&contract["HIRES_SCHEDULER"]);
    node(
        "KSampler",
        json!({"model":model,"positive":link(positive,0),"negative":link(negative,0),"latent_image":latent,"seed":if hires{validation::num(input["seed"].as_f64().unwrap()+1.)}else{input["seed"].clone()},"steps":if hires{validation::num((input["steps"].as_f64().unwrap()*0.6).round().max(12.))}else{input["steps"].clone()},"cfg":input["cfg"],"sampler_name":if hires{sampler}else{&input["sampler"]},"scheduler":if hires{scheduler}else{&input["scheduler"]},"denoise":if hires{number(input,"hiresDenoise",0.35)}else{1.}}),
    )
}
pub fn build(input: &Value) -> Result<Value> {
    let model = catalog::model(
        input["modelId"]
            .as_str()
            .ok_or_else(|| error("UNKNOWN_MODEL", "未知生成模型"))?,
    )?;
    if model["family"] == "krea2" {
        return krea(input, model);
    }
    let plain = model["noLora"] == true && !truthy(&input["loraId"]);
    let (positive, negative, latent, first, decoded) = if plain {
        ("4", "5", "6", "7", "8")
    } else {
        ("5", "6", "7", "8", "9")
    };
    let mut graph = json!({"1":node("UNETLoader",json!({"unet_name":model["file"],"weight_dtype":"default"})),"2":node("CLIPLoader",json!({"clip_name":"qwen_3_06b_base.safetensors","type":"qwen_image"})),"3":node("VAELoader",json!({"vae_name":"qwen_image_vae.safetensors"}))});
    let (mut model_link, clip) = if plain {
        (link("1", 0), link("2", 0))
    } else {
        let lora = catalog::lora(input["loraId"].as_str().unwrap_or(""))
            .ok_or_else(|| error("UNKNOWN_LORA", "未知 Anima LoRA"))?;
        graph["4"] = node(
            "LoraLoader",
            json!({"model":["1",0],"clip":["2",0],"lora_name":lora["file"],"strength_model":input["loraStrength"],"strength_clip":input["loraStrength"]}),
        );
        (link("4", 0), link("4", 1))
    };
    graph[positive] = node(
        "CLIPTextEncode",
        json!({"clip":clip,"text":input["prompt"]}),
    );
    graph[negative] = node(
        "CLIPTextEncode",
        json!({"clip":clip,"text":input["negative"]}),
    );
    graph[latent] = node(
        "EmptyLatentImage",
        json!({"width":input["width"],"height":input["height"],"batch_size":1}),
    );
    graph[first] = sample(
        input,
        model_link.clone(),
        positive,
        negative,
        link(latent, 0),
        false,
    );
    graph[decoded] = node("VAEDecode", json!({"samples":link(first,0),"vae":["3",0]}));
    graph["10"] = node(
        "SaveImage",
        json!({"images":link(decoded,0),"filename_prefix":"anima_app"}),
    );
    if truthy(&input["teaCache"]) {
        graph["13"] = node(
            "AnimaTeaCache",
            json!({"model":model_link,"rel_l1_thresh":input["teaCacheThresh"],"start_percent":0,"end_percent":1,"cache_device":"cuda"}),
        );
        model_link = link("13", 0);
        graph[first]["inputs"]["model"] = model_link.clone();
    }
    let init = truthy(&input["initImage"]);
    let masked = truthy(&input["maskImage"]) || truthy(&input["maskPrompt"]);
    if init {
        inpaint(&mut graph, input, first, decoded);
    }
    let hires = input["hiresFix"] == true && input["hiresScale"].as_f64().unwrap_or(1.) > 1.;
    if hires {
        if init && masked {
            inpaint_hires(&mut graph, input, model_link.clone(), positive, negative);
        } else if truthy(&input["superResModel"]) {
            append_super_res(&mut graph, input, first);
        } else {
            graph["11"] = node(
                "LatentUpscaleBy",
                json!({"samples":link(first,0),"upscale_method":"bicubic","scale_by":input["hiresScale"]}),
            );
            graph["12"] = sample(input, model_link, positive, negative, link("11", 0), true);
            graph[decoded]["inputs"]["samples"] = link("12", 0);
        }
    }
    if (hires && !truthy(&input["superResModel"]) && !(init && masked)) || (!hires && !init) {
        graph["35"] = node(
            "ImageSharpenKJ",
            json!({"image":graph["10"]["inputs"]["images"],"method":"rcas","method.strength":0.75}),
        );
        graph["10"]["inputs"]["images"] = link("35", 0);
    }
    Ok(graph)
}
fn inpaint(graph: &mut Value, input: &Value, first: &str, decoded: &str) {
    graph["15"] = node("LoadImage", json!({"image":input["initImage"]}));
    let resize = |source: &str| {
        node(
            "ResizeAndPadImage",
            json!({"image":link(source,0),"target_width":input["width"],"target_height":input["height"],"padding_color":"black","interpolation":"lanczos"}),
        )
    };
    graph["19"] = resize("15");
    graph["18"] = node("VAEEncode", json!({"pixels":["19",0],"vae":["3",0]}));
    let mask = if truthy(&input["maskImage"]) {
        graph["15_mask"] = node("LoadImage", json!({"image":input["maskImage"]}));
        graph["19_mask"] = resize("15_mask");
        graph["16"] = node(
            "ImageToMask",
            json!({"image":["19_mask",0],"channel":"red"}),
        );
        graph["16_grow"] = node(
            "GrowMask",
            json!({"mask":["16",0],"expand":input.get("growMaskBy").cloned().unwrap_or(json!(6)),"tapered_corners":true}),
        );
        Some("16_grow")
    } else if truthy(&input["maskPrompt"]) {
        graph["16"] = node(
            "AP_CLIPSeg_TextMask",
            json!({"image":["19",0],"prompt":input["maskPrompt"],"threshold":input.get("maskThreshold").cloned().unwrap_or(json!(0.45)),"smooth_radius":2,"soft_mask":false,"invert":false,"model":"clipseg_rd64","mask_dilate":input.get("growMaskBy").cloned().unwrap_or(json!(8)),"mask_blur":12,"device":"auto","unload_after_run":false}),
        );
        Some("16")
    } else {
        None
    };
    if let Some(mask) = mask {
        graph["17"] = node(
            "SetLatentNoiseMask",
            json!({"samples":["18",0],"mask":link(mask,0)}),
        );
        graph["30"] = node(
            "ImageCompositeMasked",
            json!({"destination":["19",0],"source":link(decoded,0),"x":0,"y":0,"resize_source":false,"mask":link(mask,0)}),
        );
        graph["10"]["inputs"]["images"] = link("30", 0);
        graph[first]["inputs"]["latent_image"] = link("17", 0);
        graph[first]["inputs"]["denoise"] = input
            .get("denoisingStrength")
            .cloned()
            .unwrap_or(json!(0.8));
    }
}
fn scale(input: &Value, source: &str) -> Value {
    node(
        "ImageScale",
        json!({"image":link(source,0),"upscale_method":"lanczos","width":validation::num((input["width"].as_f64().unwrap()*input["hiresScale"].as_f64().unwrap()/8.).round()*8.),"height":validation::num((input["height"].as_f64().unwrap()*input["hiresScale"].as_f64().unwrap()/8.).round()*8.),"crop":"disabled"}),
    )
}
fn append_super_res(graph: &mut Value, input: &Value, first: &str) {
    // Preserve the existing Remacri path: pixel upscaling without a second VAE/
    // sampling pass. That pass caused the documented high-resolution artifacts.
    graph["20"] = node("VAEDecode", json!({"samples":link(first,0),"vae":["3",0]}));
    graph["21"] = node(
        "UpscaleModelLoader",
        json!({"model_name":input["superResModel"]}),
    );
    graph["22"] = node(
        "ImageUpscaleWithModel",
        json!({"upscale_model":["21",0],"image":["20",0]}),
    );
    graph["23"] = scale(input, "22");
    graph["10"]["inputs"]["images"] = link("23", 0);
}
fn inpaint_hires(graph: &mut Value, input: &Value, model: Value, positive: &str, negative: &str) {
    let super_res = truthy(&input["superResModel"]);
    // Reuse the effective first-pass mask, including grow/CLIPSeg feathering.
    // LatentUpscaleBy uses Python's ties-to-even rounding at latent resolution.
    let dimension = |key: &str| {
        let units = input[key].as_f64().unwrap() * input["hiresScale"].as_f64().unwrap() / 8.;
        validation::num(
            if super_res {
                units.round()
            } else {
                units.round_ties_even()
            } * 8.,
        )
    };
    graph["hires_mask_image"] = node("MaskToImage", json!({"mask":graph["17"]["inputs"]["mask"]}));
    for (id, source, method) in [
        ("hires_mask_scale", "hires_mask_image", "nearest-exact"),
        ("hires_reference", "19", "lanczos"),
    ] {
        graph[id] = node(
            "ImageScale",
            json!({"image":link(source,0),"upscale_method":method,"width":dimension("width"),"height":dimension("height"),"crop":"disabled"}),
        );
    }
    graph["hires_mask"] = node(
        "ImageToMask",
        json!({"image":["hires_mask_scale",0],"channel":"red"}),
    );
    let decoded = if super_res {
        graph["20"] = node(
            "UpscaleModelLoader",
            json!({"model_name":input["superResModel"]}),
        );
        graph["21"] = node(
            "ImageUpscaleWithModel",
            json!({"upscale_model":["20",0],"image":["30",0]}),
        );
        graph["22"] = scale(input, "21");
        graph["23"] = node("VAEEncode", json!({"pixels":["22",0],"vae":["3",0]}));
        graph["hires_noise_mask"] = node(
            "SetLatentNoiseMask",
            json!({"samples":["23",0],"mask":["hires_mask",0]}),
        );
        graph["24"] = sample(
            input,
            model,
            positive,
            negative,
            link("hires_noise_mask", 0),
            true,
        );
        graph["25"] = node("VAEDecode", json!({"samples":["24",0],"vae":["3",0]}));
        "25"
    } else {
        graph["31"] = node("VAEEncode", json!({"pixels":["30",0],"vae":["3",0]}));
        graph["32"] = node(
            "LatentUpscaleBy",
            json!({"samples":["31",0],"upscale_method":"bicubic","scale_by":input["hiresScale"]}),
        );
        graph["hires_noise_mask"] = node(
            "SetLatentNoiseMask",
            json!({"samples":["32",0],"mask":["hires_mask",0]}),
        );
        graph["33"] = sample(
            input,
            model,
            positive,
            negative,
            link("hires_noise_mask", 0),
            true,
        );
        graph["34"] = node("VAEDecode", json!({"samples":["33",0],"vae":["3",0]}));
        // Sharpen the generated source before compositing so unselected areas
        // remain the resized reference, rather than receiving whole-image RCAS.
        graph["35"] = node(
            "ImageSharpenKJ",
            json!({"image":["34",0],"method":"rcas","method.strength":0.75}),
        );
        "35"
    };
    graph["hires_composite"] = node(
        "ImageCompositeMasked",
        json!({"destination":["hires_reference",0],"source":link(decoded,0),"x":0,"y":0,"resize_source":false,"mask":["hires_mask",0]}),
    );
    graph["10"]["inputs"]["images"] = link("hires_composite", 0);
}
fn krea(input: &Value, model: &Value) -> Result<Value> {
    let mut graph = json!({"1":node("UNETLoader",json!({"unet_name":model["file"],"weight_dtype":"default"})),"2":node("CLIPLoader",json!({"clip_name":"qwen3-vl-4b-heretic_fp8_e4m3fn.safetensors","type":"krea2"})),"3":node("VAELoader",json!({"vae_name":"qwen_image_vae.safetensors"})),"4":node("CLIPTextEncode",json!({"clip":["2",0],"text":input["prompt"]})),"5":node("ConditioningZeroOut",json!({"conditioning":["4",0]})),"6":node("EmptyLatentImage",json!({"width":input["width"],"height":input["height"],"batch_size":1})),"8":node("VAEDecode",json!({"samples":["7",0],"vae":["3",0]})),"10":node("SaveImage",json!({"images":["8",0],"filename_prefix":"creative_app"}))});
    let mut positive = link("4", 0);
    if model.get("rebalance").is_some() {
        let rebalance = &model["rebalance"];
        graph["11"] = node(
            "ConditioningKrea2Rebalance",
            json!({"conditioning":["4",0],"preset":rebalance["preset"].as_str().unwrap_or("standard"),"multiplier":number(rebalance,"multiplier",1.),"per_layer_weights":"1.0,1.0,1.0,1.0,1.0,1.0,1.0,2.5,5.0,1.1,4.0,1.0","normalize_taps":truthy(&rebalance["normalizeTaps"])}),
        );
        positive = link("11", 0);
    }
    let mut model_link = link("1", 0);
    if let Some(style) = input["styleLoraId"].as_str() {
        let style = catalog::styles()
            .get(style)
            .ok_or_else(|| error("UNKNOWN_STYLE_LORA", "未知 Krea 2 官方 Style LoRA"))?;
        graph["12"] = node(
            "LoraLoaderModelOnly",
            json!({"model":model_link,"lora_name":style["file"],"strength_model":1}),
        );
        model_link = link("12", 0);
    }
    graph["14"] = node(
        "ComfyUI-Krea2T-Enhancer",
        json!({"model":model_link,"enabled":true,"strength":1.3,"debug":false}),
    );
    graph["7"] = node(
        "KSampler",
        json!({"model":["14",0],"positive":positive,"negative":["5",0],"latent_image":["6",0],"seed":input["seed"],"steps":12,"cfg":1,"sampler_name":"er_sde","scheduler":"simple","denoise":1}),
    );
    graph["15"] = node(
        "ImageSharpenKJ",
        json!({"image":["8",0],"method":"rcas","method.strength":0.75}),
    );
    graph["10"]["inputs"]["images"] = link("15", 0);
    Ok(graph)
}
