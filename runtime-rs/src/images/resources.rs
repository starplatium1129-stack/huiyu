use super::*;
const SUPER_RES: &[&str] = &[
    "4x_foolhardy_Remacri.safetensors",
    "R-ESRGAN 4x+ Anime6B.pth",
    "RealESRGAN_x4plus.pth",
];
async fn file(config: &Config, kind: &str, name: &str) -> Option<PathBuf> {
    let path = config
        .ai_workspace_root
        .join("ComfyUI/models")
        .join(kind)
        .join(name);
    tokio::fs::metadata(&path)
        .await
        .ok()
        .filter(|m| m.is_file())
        .map(|_| path)
}
async fn super_res(config: &Config) -> Option<String> {
    for name in SUPER_RES {
        if file(config, "upscale_models", name).await.is_some() {
            return Some((*name).into());
        }
    }
    None
}
async fn required(config: &Config, input: &Value) -> Result<Vec<PathBuf>> {
    let model = catalog::model(input["modelId"].as_str().unwrap_or(""))?;
    let family = model["family"].as_str().unwrap();
    let mut paths = Vec::new();
    for (kind, name, code, message) in [
        (
            "diffusion_models",
            model["file"].as_str().unwrap(),
            "ANIMA_MODEL_UNAVAILABLE",
            "所选生成底模资源不可用",
        ),
        (
            "text_encoders",
            if family == "krea2" {
                "qwen3-vl-4b-heretic_fp8_e4m3fn.safetensors"
            } else {
                "qwen_3_06b_base.safetensors"
            },
            "ANIMA_ENCODER_UNAVAILABLE",
            "所选底模的文本编码器资源不可用",
        ),
        (
            "vae",
            "qwen_image_vae.safetensors",
            "ANIMA_VAE_UNAVAILABLE",
            "所选底模的 VAE 资源不可用",
        ),
    ] {
        paths.push(
            file(config, kind, name)
                .await
                .ok_or_else(|| ApiError::new(503, code, message))?,
        );
    }
    if let Some(lora) = input["loraId"].as_str().filter(|id| !id.is_empty()) {
        let lora = catalog::lora(lora).ok_or_else(|| error("UNKNOWN_LORA", "未知 Anima LoRA"))?;
        paths.push(
            file(config, "loras", lora["file"].as_str().unwrap())
                .await
                .ok_or_else(|| {
                    ApiError::new(503, "ANIMA_LORA_UNAVAILABLE", "所选 Anima LoRA 文件不可用")
                })?,
        );
    }
    if let Some(style) = input["styleLoraId"].as_str() {
        paths.push(
            file(
                config,
                "loras",
                catalog::styles()[style]["file"].as_str().unwrap(),
            )
            .await
            .ok_or_else(|| {
                ApiError::new(
                    503,
                    "KREA_STYLE_LORA_UNAVAILABLE",
                    "所选 Krea 2 Style LoRA 文件不可用",
                )
            })?,
        );
    }
    for key in ["initImage", "maskImage"] {
        if let Some(name) = input[key].as_str() {
            let path = inputs::path(config, name)?;
            if !tokio::fs::metadata(&path).await.is_ok_and(|m| m.is_file()) {
                return Err(ApiError::new(
                    503,
                    if key == "initImage" {
                        "ANIMA_IMAGE_UNAVAILABLE"
                    } else {
                        "ANIMA_MASK_UNAVAILABLE"
                    },
                    "局部重绘图像不存在或已过期",
                ));
            }
            paths.push(path);
        }
    }
    Ok(paths)
}
pub(super) async fn plan(config: &Config, input: Value) -> Result<ComfyPlan> {
    plan_inner(config, input, false).await
}
pub(super) async fn frozen_plan(config: &Config, input: Value) -> Result<ComfyPlan> {
    plan_inner(config, input, true).await
}
async fn plan_inner(config: &Config, mut input: Value, frozen: bool) -> Result<ComfyPlan> {
    let mut resources = required(config, &input).await?;
    let family = if input["family"] == "krea2" {
        "krea2"
    } else {
        "anima"
    };
    if input["hiresFix"] == true && family != "krea2" && input["hiresUpscaler"] != "Latent" {
        let selected = if frozen {
            input["superResModel"].as_str().map(str::to_owned)
        } else {
            super_res(config).await
        };
        if let Some(model) = selected {
            resources.push(
                config
                    .ai_workspace_root
                    .join("ComfyUI/models/upscale_models")
                    .join(&model),
            );
            input["superResModel"] = json!(model);
        }
    }
    let loras = if generation::truthy(&input["loraId"]) {
        json!([{"id":input["loraId"],"strength":input["loraStrength"]}])
    } else {
        json!([])
    };
    let mut metadata = json!({"engine":family,"provider":"comfy","prompt":input["prompt"],"negative":input["negative"],"profileId":input["profileId"].as_str().unwrap_or(""),"modelId":input["modelId"],"loras":loras,"loraStrength":input["loraStrength"],"styleLoraId":input["styleLoraId"],"width":input["width"],"height":input["height"],"hiresFix":input["hiresFix"]==true,"hiresScale":input["hiresScale"],"denoisingStrength":input["denoisingStrength"],"faceDetailer":generation::truthy(&input["faceDetailer"]),"steps":input["steps"],"cfg":input["cfg"],"sampler":input["sampler"].as_str().unwrap_or("res_multistep"),"scheduler":input["scheduler"].as_str().unwrap_or("simple"),"teaCache":generation::truthy(&input["teaCache"]),"teaCacheThresh":input["teaCacheThresh"],"seed":input["seed"],"character":if generation::truthy(&input["character"]){input["character"].clone()}else{Value::Null},"preview":false,"resultUrl":null});
    for key in ["loraId", "hiresSteps"] {
        if let Some(value) = input.get(key) {
            metadata[key] = value.clone();
        }
    }
    metadata["hiresUpscaler"] = if input["superResModel"].is_string() {
        json!("Remacri")
    } else {
        input["hiresUpscaler"].clone()
    };
    metadata["hiresSampler"] =
        if family != "krea2" && input["hiresFix"] == true && !input["superResModel"].is_string() {
            catalog::contract()["HIRES_SAMPLER"].clone()
        } else {
            Value::Null
        };
    metadata["hiresScheduler"] = if !metadata["hiresSampler"].is_null() {
        catalog::contract()["HIRES_SCHEDULER"].clone()
    } else {
        Value::Null
    };
    metadata["preview"] = json!(false);
    Ok(ComfyPlan {
        workflow: workflow::build(&input)?,
        input,
        metadata,
        resources,
        family,
        namespace: "anima",
        route_base: if family == "krea2" {
            "/api/creative"
        } else {
            "/api/anima"
        },
        output_prefix: if family == "krea2" {
            "creative_app"
        } else {
            "anima_app"
        },
        media_kind: generation::MediaKind::Image,
        output_node: "10",
        timeout: std::time::Duration::from_secs(10 * 60),
        retention: std::time::Duration::from_secs(30 * 60),
    })
}
pub(super) async fn status(
    config: &Config,
    backend: &generation::Service,
    family: &str,
) -> Result<Value> {
    let mut models = Vec::new();
    for (id, model) in catalog::CATALOG["MODELS"].as_object().unwrap() {
        if family == "anima" && model["family"] != "anima" {
            continue;
        }
        let input = json!({"modelId":id});
        let available = required(config, &input).await.is_ok();
        let krea = model["family"] == "krea2";
        models.push(json!({"id":id,"label":model["label"],"family":model["family"],"profileId":model["profileId"],"available":available,"defaults":{"steps":model["steps"],"cfg":model["cfg"],"sampler":model["sampler"],"scheduler":model["scheduler"]},"sizes":model["sizes"],"capabilities":{"negative":!krea,"lora":!krea,"noLora":krea||model["noLora"]==true,"characterIdentity":!krea,"experimental":krea||model["noLora"]==true}}));
    }
    let mut loras = Vec::new();
    for (id, lora) in catalog::CATALOG["LORAS"].as_object().unwrap() {
        loras.push(json!({"id":id,"name":lora["name"],"character":lora["character"],"preview":lora["preview"]==true,"validation":lora["validation"].as_str().unwrap_or("production"),"available":file(config,"loras",lora["file"].as_str().unwrap()).await.is_some()}));
    }
    let mut styles = Vec::new();
    for (id, style) in catalog::styles().as_object().unwrap() {
        styles.push(json!({"id":id,"trigger":style["trigger"],"recommendedStrength":1,"available":file(config,"loras",style["file"].as_str().unwrap()).await.is_some()}));
    }
    Ok(
        json!({"online":backend.comfy_online().await&&models.iter().any(|m|m["available"]==true),"models":models,"loras":loras,"styleLoras":styles,"characters":catalog::CATALOG["CHARACTERS"].as_object().unwrap().values().cloned().collect::<Vec<_>>(),"hires":{"superResModel":super_res(config).await},"pending":backend.pending(),"maxPending":4}),
    )
}
