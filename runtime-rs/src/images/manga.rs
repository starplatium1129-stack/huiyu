//! Native MangaScreen; optional model steps never route through ComfyUI.
mod models;
use super::*;
use generation::native::{Plan, Settings};
use std::sync::{LazyLock, Mutex};

static MANIFEST: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../tools/inference/manga-screen.json"))
        .expect("bundled MangaScreen contract")
});
const KEYS: &[&str] = &[
    "operation",
    "initImage",
    "penLines",
    "levels",
    "finish",
    "panel",
    "rewrite",
    "autoLines",
    "penLinesPolarity",
    "penLinesFit",
];
const FILES: &[&str] = &[
    "manga_worker.py",
    "manga_contract.py",
    "manga_screen.py",
    "manga-screen.json",
    "MANGASCREEN_LICENSE.txt",
    "worker_lifecycle.py",
    "manga_models.py",
    "manga_line_model.py",
    "MANGALINE_LICENSE.txt",
];

async fn validate_runtime(settings: &Settings) -> Result<()> {
    settings.validate_files().await?;
    let worker = settings.worker.clone();
    let issue = tokio::task::spawn_blocking(move || generation::native::resources::worker_bundle_issue(&worker, FILES))
        .await.map_err(|_| ApiError::new(503, "MANGA_RUNTIME_MISSING", "漫画运行文件读取未完成"))?;
    if let Some(issue) = issue { return Err(ApiError::new(503, "MANGA_RUNTIME_MISSING", issue)); }
    Ok(())
}

pub(super) fn validate(raw: &Value) -> Result<Value> {
    let object = raw
        .as_object()
        .ok_or_else(|| error("INVALID_BODY", "请求体必须为对象"))?;
    if object.keys().any(|key| !KEYS.contains(&key.as_str())) {
        return Err(error(
            "UNKNOWN_PARAMETER",
            "漫画处理仅接受操作、输入图、线稿来源/极性/对齐、重绘与对应参数组",
        ));
    }
    let operation = raw
        .get("operation")
        .and_then(Value::as_str)
        .unwrap_or("lite");
    if raw.get("operation").is_some_and(|v| !v.is_string()) {
        return Err(error("INVALID_PARAMETER", "operation 必须为文本"));
    }
    let groups = MANIFEST["operations"][operation]
        .as_array()
        .ok_or_else(|| error("INVALID_PARAMETER", "未知漫画处理操作"))?;
    let image = raw["initImage"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| error("INVALID_PARAMETER", "漫画处理需要已上传的 initImage"))?;
    let pen = match raw.get("penLines") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if !s.is_empty() && groups.iter().any(|v| v == "finish") => {
            Some(s.as_str())
        }
        _ => {
            return Err(error(
                "INVALID_PARAMETER",
                "penLines 仅用于 finish/lite/comic，需为已上传的线稿；黑白极性由 penLinesPolarity 指定",
            ));
        }
    };
    let mut result = json!({"operation":operation,"initImage":image,"penLines":pen,"family":"manga-screen",
        "processorId":"manga-screen","processorRevision":MANIFEST["revision"],"processorVersion":MANIFEST["schemaVersion"],
        "inferenceEngine":"native","device":"cpu","validation":"待主力机验证"});
    for (key, choices) in [
        ("penLinesPolarity", ["white-on-black", "black-on-white"]),
        ("penLinesFit", ["stretch", "exact"]),
    ] {
        if pen.is_some() {
            let value = raw.get(key).unwrap_or(&Value::Null);
            let selected = if value.is_null() && raw.get(key).is_none() {
                choices[0]
            } else {
                value
                    .as_str()
                    .filter(|v| choices.contains(v))
                    .ok_or_else(|| error("INVALID_PARAMETER", format!("未知 {key}")))?
            };
            result[key] = json!(selected);
        } else if raw.get(key).is_some() {
            return Err(error(
                "INVALID_PARAMETER",
                format!("{key} 需要外部 penLines"),
            ));
        }
    }
    for (group, schema) in MANIFEST["parameters"].as_object().unwrap() {
        if !groups.iter().any(|g| g == group) {
            if raw.get(group).is_some() {
                return Err(error(
                    "INVALID_PARAMETER",
                    format!("{operation} 不使用 {group} 参数"),
                ));
            }
            continue;
        }
        let supplied = raw
            .get(group)
            .map(|v| {
                v.as_object()
                    .ok_or_else(|| error("INVALID_PARAMETER", "参数组必须为对象"))
            })
            .transpose()?;
        let schema = schema.as_object().unwrap();
        if supplied.is_some_and(|m| m.keys().any(|k| !schema.contains_key(k))) {
            return Err(error("UNKNOWN_PARAMETER", format!("未知 {group} 参数")));
        }
        let mut values = serde_json::Map::new();
        for (key, rule) in schema {
            let value = supplied
                .and_then(|s| s.get(key))
                .unwrap_or(&rule["default"]);
            let valid = if let Some(choices) = rule["choices"].as_array() {
                choices.contains(value)
            } else {
                value.as_f64().is_some_and(|v| {
                    v.is_finite()
                        && v >= rule["min"].as_f64().unwrap()
                        && v <= rule["max"].as_f64().unwrap()
                        && (rule["integer"] != true || value.as_u64().is_some())
                })
            };
            if !valid {
                return Err(error(
                    "INVALID_PARAMETER",
                    format!("{group}.{key} 超出支持范围"),
                ));
            }
            values.insert(key.clone(), value.clone());
        }
        result[group] = Value::Object(values);
    }
    if groups.iter().any(|v| v == "levels")
        && result["levels"]["white"].as_f64() <= result["levels"]["black"].as_f64()
    {
        return Err(error("INVALID_PARAMETER", "levels.white 必须大于 black"));
    }
    if groups.iter().any(|v| v == "finish")
        && (result["finish"]["white_point"].as_f64() <= result["finish"]["black_point"].as_f64()
            || result["finish"]["dark_tone"].as_f64() < result["finish"]["light_tone"].as_f64())
    {
        return Err(error(
            "INVALID_PARAMETER",
            "white_point 必须大于 black_point，dark_tone 不小于 light_tone",
        ));
    }
    models::parameters(raw, &mut result)?;
    Ok(result)
}
pub(super) fn normalize(input: &Value) -> Result<Value> {
    if input["inferenceEngine"] != "native"
        || input["processorVersion"] != MANIFEST["schemaVersion"]
        || input["processorRevision"] != MANIFEST["revision"]
    {
        return Err(ApiError::new(
            409,
            "TASK_RESUME_UNSAFE",
            "漫画处理配方版本已改变，请重新创建任务",
        ));
    }
    let raw = KEYS
        .iter()
        .filter_map(|key| input.get(*key).map(|v| ((*key).to_owned(), v.clone())))
        .collect();
    let result = validate(&Value::Object(raw))?;
    if ["rewriteModelRevision", "lineartRevision"]
        .iter()
        .any(|key| input[*key] != result[*key])
    {
        return Err(ApiError::new(
            409,
            "TASK_RESUME_UNSAFE",
            "漫画模型版本已改变，请重新创建任务",
        ));
    }
    Ok(result)
}
fn settings(runtime: &Settings) -> Result<Settings> {
    let mut settings = runtime.clone();
    settings.python = runtime.adapter_python.clone().ok_or_else(|| ApiError::new(503,
        "MANGA_RUNTIME_MISSING", "设置 HUIYU_NATIVE_ADAPTER_PYTHON，并在其独立环境准备 requirements-manga.txt；不修改 Anima 环境"))?;
    settings.worker = runtime.worker.with_file_name("manga_worker.py");
    Ok(settings)
}
pub(super) async fn plan(
    runtime: &Settings,
    input: Value,
    originals: &[inputs::Original],
) -> Result<Plan> {
    let input = normalize(&input)?;
    let settings = settings(runtime)?;
    validate_runtime(&settings).await?;
    let source = |key: &str| -> Result<Option<generation::native::InputFile>> {
        input[key]
            .as_str()
            .map(|name| {
                originals
                    .iter()
                    .find(|o| o.name == name)
                    .map(|o| o.input.clone())
                    .ok_or_else(|| error("TASK_INPUT_MISSING", "缺少受保护的漫画输入图像"))
            })
            .transpose()
    };
    let init_image = Mutex::new(source("initImage")?);
    let pen_lines = Mutex::new(source("penLines")?);
    let model_dir = models::model_dir(&settings, &input).await?;
    Ok(Plan {
        input: input.into(),
        settings,
        model_dir,
        mask_model_dir: None,
        upscale_model_path: None,
        init_image,
        reference_images: Mutex::new(vec![]),
        pen_lines,
        mask_image: Mutex::new(None),
        sketch_image: Mutex::new(None),
        sketch_model_path: None,
        loras: vec![],
    })
}
pub(super) async fn status(backend: &generation::Service) -> Result<Value> {
    let runtime = backend.native_settings()?;
    let inspected = runtime.clone();
    let capabilities = tokio::task::spawn_blocking(move || models::status(&inspected)).await
        .map_err(|_| ApiError::new(503, "MANGA_RUNTIME_MISSING", "漫画模型状态读取未完成"))?;
    let settings = settings(&runtime);
    let issue = match &settings {
        Err(error) => Some(error.message.clone()),
        Ok(settings) => validate_runtime(settings).await.err().map(|e| e.message),
    };
    Ok(
        json!({"provider":"native","engine":"native","processor":*MANIFEST,"online":issue.is_none(),
        "available":issue.is_none(),"unavailableReason":issue,"readiness":"files-only",
        "validation":"待主力机验证","generationVerified":false,"performanceVerified":false,
        "pending":backend.pending(),"maxPending":4,"defaults":{"operation":"lite"},"capabilities":capabilities}),
    )
}
