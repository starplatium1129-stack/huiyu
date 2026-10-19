use super::*;
use generation::{ComfyPlan, MediaKind};
pub(super) fn requirements(config: &Config, input: &Value, t8: bool) -> Result<Vec<PathBuf>> {
    if generation::truthy(&input["references"]) && !t8 {
        return Err(error(
            503,
            "VIDEO_REFERENCE_UNAVAILABLE",
            "H3 参考图需要 T8 双时钟节点，当前节点不可用",
        ));
    }
    let model = catalog::model(input["modelId"].as_str().unwrap_or(""))
        .ok_or_else(|| error(400, "UNKNOWN_MODEL", "未知视频模型"))?;
    let mut resources = model["requirements"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            config
                .ai_workspace_root
                .join("ComfyUI/models")
                .join(r[0].as_str().unwrap())
                .join(r[1].as_str().unwrap())
        })
        .collect::<Vec<_>>();
    for name in inputs::names(input) {
        resources.push(inputs::path(config, name)?);
    }
    Ok(resources)
}
pub(super) fn local_models(root: PathBuf) -> Vec<Value> {
    catalog::constants()["MODEL_CATALOG"]
        .as_array()
        .unwrap()
        .iter()
        .map(|model| available(&root, model))
        .collect()
}
fn available(root: &std::path::Path, model: &Value) -> Value {
    let mut missing = Vec::new();
    let mut requirements = Vec::new();
    for r in model["requirements"].as_array().unwrap() {
        let label = format!("{}/{}", r[0].as_str().unwrap(), r[1].as_str().unwrap());
        if !std::fs::metadata(root.join(&label)).is_ok_and(|m| m.is_file())
        {
            missing.push(label.clone());
        }
        requirements.push(label);
    }
    let complete = missing.is_empty();
    let mut value = model.clone();
    value["available"] = json!(model["executable"] == true && complete);
    value["missing"] = missing.into();
    value["reason"] = json!(if model["executable"] != true {
        "适配器待验证"
    } else if !complete {
        "缺少本机模型文件"
    } else {
        ""
    });
    value["requirements"] = requirements.into();
    value
}
pub(super) fn estimate(input: &Value, t8: bool) -> u64 {
    (input["frames"].as_f64().unwrap_or(121.)
        * input["steps"].as_f64().unwrap_or(8.)
        * if t8 { 0.125 } else { 0.25 })
    .round() as u64
        + 90
}
pub(super) fn plan(config: &Config, input: Value, t8: bool, batch: bool) -> Result<ComfyPlan> {
    let resources = requirements(config, &input, t8)?;
    let estimated = estimate(&input, t8);
    let model = catalog::model(input["modelId"].as_str().unwrap()).unwrap();
    let family = if model["family"] == "minimax-h3" {
        "minimax-h3"
    } else {
        "wan2.2"
    };
    let mut metadata = input.clone();
    metadata["engine"] = json!("video");
    metadata["provider"] = json!("comfy");
    metadata["estimatedSeconds"] = json!(estimated);
    metadata["t8"] = json!(t8);
    Ok(ComfyPlan {
        workflow: workflow::build(&input, t8),
        input: input.into(),
        metadata,
        resources,
        family,
        namespace: "video",
        route_base: "/api/video",
        output_prefix: "aics_video",
        media_kind: MediaKind::Video,
        output_node: "11",
        timeout: Duration::from_secs(600.max(estimated * 3)),
        retention: Duration::from_secs(if batch { 86400 } else { 7200 }),
    })
}
