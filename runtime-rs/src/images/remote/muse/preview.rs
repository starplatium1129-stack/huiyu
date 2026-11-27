use super::*;

pub(super) async fn draw_preview(
    State(state): State<crate::AppState>,
    Extension(muse): Extension<Arc<Muse>>,
    Json(mut input): Json<Value>,
) -> Response {
    if let Some(response) = muse.search_limit.check(false) {
        return response;
    }
    let result = async {
        state.host.check_running()?;
        input
            .as_object_mut()
            .ok_or_else(|| ApiError::invalid("预览请求体必须是 JSON 对象"))?
            .remove("requestKey");
        let scene: SceneSelection = serde_json::from_value(input)
            .map_err(|error| ApiError::invalid(format!("出图参数无效：{error}")))?;
        let config = state.config.clone();
        let loras = muse.images.backend.native_settings()?.loras_root;
        tokio::task::spawn_blocking(move || compile(&config, loras, scene))
            .await
            .map_err(|_| unavailable())?
    }
    .await;
    http::response(result, StatusCode::OK)
}

fn compile(config: &crate::config::Config, loras: PathBuf, scene: SceneSelection) -> Result<Value> {
    // Compile and normalize the same recipe as submission without creating a request receipt.
    let prepared = submission::prepare_batch(config, loras, vec![scene], None)?
        .pop()
        .ok_or_else(unavailable)?;
    let payload = submission::validate_payload(&prepared.payload, prepared.family)?;
    let mut result = json!({
        "preview": true,
        "modelId": prepared.model_id,
        "family": prepared.family,
        "kind": prepared.kind,
        "id": prepared.id,
        "variants": prepared.variants,
        "width": payload["width"],
        "height": payload["height"],
        "prompt": payload["prompt"].as_str().unwrap_or_default(),
        "negative": payload["negative"].as_str().unwrap_or_default(),
    });
    for field in [
        "steps",
        "cfg",
        "sampler",
        "scheduler",
        "profileId",
        "loraId",
        "loraStrength",
        "styleLoraId",
        "styleLoraStrength",
        "styleLoras",
        "teaCache",
        "teaCacheThresh",
        "hiresFix",
        "hiresScale",
        "hiresUpscaler",
        "mossSampler",
        "mossAcceleration",
        "mossSpectrumFlexWindow",
        "mossUpscaleScale",
    ] {
        if let Some(value) = payload.get(field).filter(|value| !value.is_null()) {
            result[field] = value.clone();
        }
    }
    if prepared.family == "krea2" {
        let styles = krea_styles::selection(&payload, true)?;
        result["prompt"] = json!(krea_styles::prompt(payload["prompt"].as_str().unwrap_or_default(), &styles)?);
    }
    if let Some(seed) = prepared.seed {
        result["seed"] = json!(seed);
    }
    Ok(result)
}
