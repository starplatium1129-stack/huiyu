use super::*;
pub fn build(input: &Input) -> Result<Value> {
    let (sampler, _) = constants::sampler(&input.sampler).ok_or_else(|| {
        ApiError::new(
            400,
            "COMFY_CAPABILITY_UNAVAILABLE",
            "当前请求不符合 ComfyUI 能力",
        )
    })?;
    let mut graph = json!({"1":{"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":constants::CHECKPOINT}}});
    let (mut model, mut clip) = ("1".to_string(), "1".to_string());
    for (index, lora) in input.loras.iter().enumerate() {
        let id = (2 + index).to_string();
        graph[&id] = json!({"class_type":"LoraLoader","inputs":{"model":[model,0],"clip":[clip,1],"lora_name":lora.file,"strength_model":lora.strength,"strength_clip":lora.strength}});
        model = id.clone();
        clip = id;
    }
    graph["4"] = json!({"class_type":"CLIPTextEncode","inputs":{"clip":[clip,1],"text":if input.clean_prompt.is_empty(){validation::strip_loras(&input.prompt)}else{input.clean_prompt.clone()}}});
    graph["5"] = json!({"class_type":"CLIPTextEncode","inputs":{"clip":[clip,1],"text":validation::strip_loras(&input.negative)}});
    graph["6"] = json!({"class_type":"EmptyLatentImage","inputs":{"width":input.width,"height":input.height,"batch_size":1}});
    let sample = |latent: Value, steps: u32, denoise: f64| json!({"class_type":"KSampler","inputs":{"model":[model,0],"positive":["4",0],"negative":["5",0],"latent_image":latent,"seed":input.seed,"steps":steps,"cfg":input.cfg,"sampler_name":sampler,"scheduler":input.scheduler,"denoise":denoise}});
    graph["7"] = sample(json!(["6", 0]), input.steps, 1.);
    let mut final_samples = json!(["7", 0]);
    if input.hires_fix && input.comfy_hires {
        if let Some(upscale) = &input.super_res_model {
            graph["11"] =
                json!({"class_type":"UpscaleModelLoader","inputs":{"model_name":upscale}});
            graph["12"] =
                json!({"class_type":"VAEDecode","inputs":{"samples":final_samples,"vae":["1",2]}});
            graph["13"] = json!({"class_type":"ImageUpscaleWithModel","inputs":{"upscale_model":["11",0],"image":["12",0]}});
            graph["14"] = json!({"class_type":"ImageScale","inputs":{"image":["13",0],"upscale_method":"lanczos","width":(f64::from(input.width)*input.hires_scale/8.).round() as u32*8,"height":(f64::from(input.height)*input.hires_scale/8.).round() as u32*8,"crop":"disabled"}});
            graph["15"] =
                json!({"class_type":"VAEEncode","inputs":{"pixels":["14",0],"vae":["1",2]}});
            graph["16"] = sample(
                json!(["15", 0]),
                input.hires_steps,
                input.denoising_strength,
            );
            final_samples = json!(["16", 0]);
        } else {
            graph["11"] = json!({"class_type":"LatentUpscaleBy","inputs":{"samples":final_samples,"upscale_method":"nearest-exact","scale_by":input.hires_scale}});
            graph["12"] = sample(
                json!(["11", 0]),
                input.hires_steps,
                input.denoising_strength,
            );
            final_samples = json!(["12", 0]);
        }
    }
    graph["8"] = json!({"class_type":"VAEDecode","inputs":{"samples":final_samples,"vae":["1",2]}});
    graph["10"] =
        json!({"class_type":"SaveImage","inputs":{"images":["8",0],"filename_prefix":"wai_app"}});
    Ok(graph)
}
