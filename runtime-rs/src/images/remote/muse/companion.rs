use super::*;
use crate::{AppState, host::Session, storage::Storage};
use axum::http::{Method, Uri};

pub(in crate::images::remote) const OPTIONS_PATH: &str = "/api/muse/options";

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DrawingOptionsQuery {
    model_id: Option<String>,
    character: Option<String>,
}

pub(super) async fn remote_drawing_options(
    State(state): State<AppState>,
    Extension(muse): Extension<Arc<Muse>>,
    Query(query): Query<DrawingOptionsQuery>,
) -> Response {
    if let Some(response) = muse.search_limit.check(false) {
        return response;
    }
    let cancel = state.shutdown.child_token();
    let _guard = cancel.clone().drop_guard();
    http::response(
        drawing_options(
            &state,
            query.model_id.as_deref(),
            query.character.as_deref(),
            cancel,
        )
        .await,
        StatusCode::OK,
    )
}

pub(crate) async fn catalog(state: &AppState, uri: &Uri) -> Result<Value> {
    check_permission(state, "search_drawing_catalog").await?;
    catalog_inner(state, uri).await
}

pub(crate) async fn catalog_channel(state: &AppState, uri: &Uri) -> Result<Value> {
    catalog_inner(state, uri).await
}

pub(crate) async fn catalog_detail(state: &AppState, kind: &str, id: &str) -> Result<Value> {
    details::describe(state, kind.into(), id.into()).await
}

pub(crate) async fn drawing_options(
    state: &AppState,
    model_id: Option<&str>,
    character: Option<&str>,
    cancel: tokio_util::sync::CancellationToken,
) -> Result<Value> {
    if [model_id, character].into_iter().flatten().any(|value| {
        value.trim().is_empty() || value.chars().count() > 160 || value.chars().any(char::is_control)
    }) {
        return Err(ApiError::invalid(
            "modelId 和 character 须为 1–160 字且不含控制字符",
        ));
    }
    let model_id = model_id.map(str::trim);
    state.host.check_running()?;
    let images = state.images.as_ref().ok_or_else(closed)?;
    let settings = images.backend.native_settings()?;
    if settings.engine != "native" {
        return Ok(json!({"available":false,"models":[]}));
    }
    let status = crate::images::native::status(&images.backend, "", cancel).await?;
    let mut models: Vec<_> = status["models"].as_array().into_iter().flatten()
        .filter(|model| matches!(model["family"].as_str(), Some("anima" | "krea2" | "moss-image" | "qwen-image" | "keyframe"))
            && (model["available"] == true || model_id.is_some_and(|id| model["id"] == id)))
        .filter(|model| model_id.is_none_or(|id| model["id"] == id))
        .map(|model| {
            let id = model["id"].as_str().unwrap_or("");
            let family = model["family"].as_str().unwrap_or("");
            let size_limits = generation::native::adapters::model(id)
                .map(|spec| {
                    let min = spec["minSize"].as_u64().unwrap_or(512);
                    json!({"min":min,"max":spec["maxSize"],"step":spec["alignment"]})
                })
                .unwrap_or_else(|| model["capabilities"]["customSize"].clone());
            let default_size = if matches!(family, "qwen-image" | "keyframe") {
                json!("1024x1024")
            } else {
                model["sizes"][0].clone()
            };
            let img2img = if family == "anima" {
                json!(true)
            } else {
                model["capabilities"]["img2img"].clone()
            };
            let mask = if family == "anima" {
                json!(true)
            } else {
                model["capabilities"]["mask"].clone()
            };
            json!({"id":id,"label":model["label"],"family":family,"available":model["available"],
                "catalogRecipes":RECIPE_MODELS.contains(&id),"sizes":model["sizes"],"sizeLimits":size_limits,
                "defaultSize":default_size,"defaults":model["defaults"],"negative":model["capabilities"]["negative"],
                "img2img":img2img,"mask":mask,"maxReferenceImages":model["capabilities"]["maxReferenceImages"],
                "requiresInitImage":family == "keyframe","modes":model["modes"],
                "teaCache":model["capabilities"]["teaCache"],"hiresUpscalers":model["capabilities"]["hiresUpscalers"],
                "mossLayout":family == "moss-image",
                "mossErSde":model["mossErSde"],"mossAcceleration":model["mossAcceleration"],
                "mossAdaptiveSpectrum":model["mossAdaptiveSpectrum"],"mossSpectrumFlexWindow":model["mossSpectrumFlexWindow"]})
        })
        .collect();
    if model_id.is_none() || model_id == Some("manga-screen") {
        if let Ok(manga_status) = crate::images::manga::status(&images.backend).await {
            let available = manga_status["available"] == true;
            if available || model_id == Some("manga-screen") {
                models.push(json!({
                    "id": "manga-screen",
                    "label": "MangaScreen · 漫画化处理",
                    "family": "manga-screen",
                    "available": available,
                    "unavailableReason": manga_status["unavailableReason"],
                    "catalogRecipes": false,
                    "requiresInitImage": true,
                    "defaults": manga_status["defaults"],
                    "capabilities": manga_status["capabilities"],
                }));
            }
        }
    }
    let character = character.map(|value| match value.trim() {
        "宁宁" => "nene",
        "夏目" => "natsume",
        name => name,
    });
    let binding = character.and_then(|character| {
        status["characters"].as_array()?.iter().find(|item| {
            item["id"] == character || item["label"] == character
        })
    });
    let character_id = binding.and_then(|value| value["id"].as_str()).or(character);
    let contains = |values: &Value, expected: &str| {
        values.as_array().is_some_and(|values| {
            values.iter().any(|value| value.as_str() == Some(expected))
        })
    };
    let compatible_lora = |lora: &Value| {
        lora["available"] == true
            && model_id.is_none_or(|id| contains(&lora["compatibleModels"], id))
    };
    let default_lora = binding.and_then(|binding| {
        let lora = status["loras"].as_array()?.iter()
            .find(|lora| lora["id"] == binding["loraId"] && compatible_lora(lora))?;
        Some(json!({"character":binding["id"],"loraId":lora["id"],"compatibleModels":lora["compatibleModels"]}))
    });
    let loras: Vec<_> = status["loras"].as_array().into_iter().flatten()
        .filter(|lora| compatible_lora(lora) && character_id.is_none_or(|id|
            lora["character"] == id || contains(&lora["characters"], id)))
        .collect();
    let includes_styles = model_id.is_none_or(|id|
        generation::native::adapters::model(id).is_some_and(|spec| spec["family"] == "krea2"));
    let style_loras: Vec<_> = status["styleLoras"].as_array().into_iter().flatten()
        .filter(|lora| includes_styles && lora["available"] == true)
        .collect();
    let models_root = settings.models_root;
    let installed_upscalers = tokio::task::spawn_blocking(move || {
        use generation::native::resources;
        json!({"ultrasharp":resources::ultrasharp(&models_root).is_some(),
            "remacri":resources::remacri(&models_root).is_some()})
    }).await.map_err(|_| unavailable())?;
    let guide = super::super::guide::Guide::document();
    Ok(json!({"available":status["online"],"defaultModelId":ANIMA,"models":models,
        "characterDefaultLora":default_lora,"loras":loras,"styleLoras":style_loras,
        "upscale":guide["upscale"],"installedUpscalers":installed_upscalers,
        "standaloneUpscale":{
            "path":upscale::UPSCALE_PATH,
            "upscalers":["remacri","ultrasharp"],
            "remacriScales":[1.5,2.0],
            "ultrasharpScaleRange":{"min":1.1,"max":3.0,"default":1.5},
            "maxBase64Bytes":upscale::MAX_BASE64_IMAGE_BYTES
        },
        "teaCache":guide["teaCache"],"moss":guide["moss"]}))
}

async fn catalog_inner(state: &AppState, uri: &Uri) -> Result<Value> {
    let Query(mut input) =
        Query::<Search>::try_from_uri(uri).map_err(|_| ApiError::invalid("素材查询参数无效"))?;
    input.page_size = input.page_size.min(20);
    lookup(state, input).await
}

pub(crate) async fn batch(
    state: &AppState,
    storage: &Storage,
    session: &Session,
    method: &Method,
    id: &str,
    body: &[u8],
) -> Result<Value> {
    batch_inner(state, storage, &session.principal_id, method, id, body, true).await
}

pub(crate) async fn batch_for_channel(
    state: &AppState,
    storage: &Storage,
    principal: &str,
    method: &Method,
    id: &str,
    body: &[u8],
) -> Result<Value> {
    batch_inner(state, storage, principal, method, id, body, false).await
}

async fn batch_inner(
    state: &AppState,
    storage: &Storage,
    principal: &str,
    method: &Method,
    id: &str,
    body: &[u8],
    enforce_room_permission: bool,
) -> Result<Value> {
    if uuid::Uuid::parse_str(id).is_err() {
        return Err(ApiError::invalid("出图批次编号无效"));
    }
    let runtime = state
        .tasks
        .as_ref()
        .ok_or_else(|| ApiError::invalid("本机任务队列暂不可用"))?;
    let get = json!({"kind":"imageBatch.get","id":id});
    let existing = storage.request(get.clone(), principal).await?;
    if !existing.is_null() && existing["origin"] != "companion-chat" {
        return Err(ApiError::new(404, "BATCH_NOT_FOUND", "找不到对话绘图批次"));
    }
    let command = match *method {
        Method::GET if existing.is_null() => return Ok(Value::Null),
        Method::GET => get,
        Method::DELETE => json!({"kind":"imageBatch.control","id":id,"action":"cancel"}),
        Method::PATCH if matches!(existing["state"].as_str(), Some("draft" | "paused")) => {
            if enforce_room_permission {
                check_permission(state, "generate_drawing_batch").await?;
            }
            if existing["cancelRequested"] == true {
                json!({"kind":"imageBatch.control","id":id,"action":"cancel"})
            } else {
                json!({"kind":"imageBatch.control","id":id,"action":"resume"})
            }
        }
        Method::PATCH => return Ok(existing),
        Method::POST => {
            if enforce_room_permission {
                check_permission(state, "generate_drawing_batch")
                    .await
                    .map_err(ApiError::not_accepted)?;
            }
            let input: Value = serde_json::from_slice(body)
                .map_err(|_| ApiError::invalid("对话批次参数无效").not_accepted())?;
            let fingerprint = crate::storage::json_fingerprint(&input);
            if existing.is_null() {
                let plan = prepare(state, storage, principal, id, input, fingerprint)
                    .await
                    .map_err(ApiError::not_accepted)?;
                json!({"kind":"imageBatch.create","id":id,"plan":plan})
            } else if existing["companionIntent"] == fingerprint
                || existing["cancelRequested"] == true && existing["companionIntent"].is_null()
            {
                get
            } else {
                return Err(ApiError::new(
                    409,
                    "BATCH_KEY_CONFLICT",
                    "原批次编号已用于其他参数",
                ));
            }
        }
        _ => return Err(ApiError::invalid("无效的对话绘图操作")),
    };
    runtime
        .image_batch(storage.clone(), principal.to_owned(), command)
        .await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ItemChange {
    expected_revision: u64,
    operation: String,
    prompt: Option<String>,
}

pub(crate) async fn item(
    state: &AppState,
    storage: &Storage,
    session: &Session,
    method: &Method,
    id: &str,
    index: &str,
    body: &[u8],
) -> Result<Value> {
    let index: usize = index
        .parse()
        .map_err(|_| ApiError::invalid("图片序号无效"))?;
    let principal = &session.principal_id;
    let plan = storage
        .request(json!({"kind":"imageBatch.get","id":id}), principal)
        .await?;
    let job = &plan["jobs"][index];
    if plan["origin"] != "companion-chat" || !job.is_object() {
        return Err(
            ApiError::new(404, "BATCH_ITEM_NOT_FOUND", "找不到这张图的方案").not_accepted(),
        );
    }
    check_permission(state, "generate_drawing_batch")
        .await
        .map_err(ApiError::not_accepted)?;
    let mut frozen = storage
        .request(
            json!({"kind":"imageBatch.input","id":id,"index":index}),
            principal,
        )
        .await?;
    let prompt = &frozen["taskInput"]["prompt"];
    if *method == Method::GET {
        return Ok(json!({"prompt":prompt,"revision":plan["revision"]}));
    }
    if *method != Method::PATCH {
        return Err(ApiError::invalid("图片操作无效").not_accepted());
    }
    let change: ItemChange = serde_json::from_slice(body)
        .map_err(|_| ApiError::invalid("图片参数无效").not_accepted())?;
    let family = frozen["snapshot"]["engine"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let payload = &mut frozen["taskInput"];
    if let Some(prompt) = change.prompt {
        if prompt.trim().is_empty() || prompt.len() > 64 * 1024 {
            return Err(ApiError::invalid("请输入有效的提示词").not_accepted());
        }
        payload["prompt"] = json!(prompt);
    }
    if change.operation == "rerun" && job["status"] == "succeeded" {
        let max_seed = if matches!(family.as_str(), "anima" | "krea2") {
            MAX_SEED
        } else {
            2_147_483_647
        };
        let seed = payload["seed"].as_u64().unwrap_or_default().min(max_seed);
        payload["seed"] = json!((seed + 1) % (max_seed + 1));
    }
    submission::validate_payload(payload, &family).map_err(ApiError::not_accepted)?;
    state
        .tasks
        .as_ref()
        .ok_or_else(closed)?
        .image_batch(
            storage.clone(),
            principal.clone(),
            json!({
                "kind":"imageBatch.changeItem","id":id,"index":index,
                "expectedRevision":change.expected_revision,"operation":change.operation,
                "input":frozen,
            }),
        )
        .await
        .map_err(ApiError::not_accepted)
}

async fn check_permission(state: &AppState, name: &str) -> Result<()> {
    state
        .desktop_tools
        .as_ref()
        .ok_or_else(|| ApiError::new(403, "TOOL_PERMISSION_DENIED", "本机工具未启用"))?
        .check_drawing_permission(name)
        .await
}

async fn prepare(
    state: &AppState,
    storage: &Storage,
    principal: &str,
    id: &str,
    mut input: Value,
    fingerprint: String,
) -> Result<Value> {
    let params = input
        .as_object_mut()
        .ok_or_else(|| ApiError::invalid("请输入批次参数"))?;
    let preview = match params.remove("preview") {
        None | Some(Value::Bool(false)) => false,
        Some(Value::Bool(true)) => true,
        _ => return Err(ApiError::invalid("预览参数无效")),
    };
    params.insert("requestKey".into(), json!(id));
    let (model, scenes) = serde_json::from_value::<batches::Batch>(input)
        .map_err(|error| ApiError::invalid(format!("对话批次参数无效：{error}")))?
        .selections()?;
    let count: usize = scenes
        .iter()
        .map(|scene| usize::from(scene.variants.unwrap_or(1)))
        .sum();
    if scenes.len() > batches::MAX_BATCH || !(1..=batches::MAX_BATCH).contains(&count) {
        return Err(ApiError::invalid("每批可生成 1–16 张图片，包含变体"));
    }
    let images = state.images.as_ref().ok_or_else(closed)?;
    let settings = images.backend.native_settings()?;
    if settings.engine != "native" {
        return Err(ApiError::new(
            409,
            "LOCAL_NATIVE_REQUIRED",
            "请在控制室启用本机原生引擎，再使用配方和批量出图",
        ));
    }
    let config = state.config.clone();
    let prepared = tokio::task::spawn_blocking(move || {
        let prepared =
            submission::prepare_batch(&config, settings.loras_root, scenes, model.as_deref())?;
        let catalog =
            crate::catalog::Catalog::open_readonly(crate::catalog::Options::from_config(&config))
                .ok();
        let titles = prepared
            .iter()
            .map(|scene| {
                let record = catalog.as_ref()?.get(&scene.kind, &scene.id).ok()?;
                record.data["title"]
                    .as_str()
                    .or_else(|| record.data["outfit"]["name"].as_str())
                    .map(str::to_owned)
            })
            .collect::<Vec<_>>();
        Ok::<_, ApiError>(prepared.into_iter().zip(titles).collect::<Vec<_>>())
    })
    .await
    .map_err(|_| unavailable())??;

    let mut targets = Vec::with_capacity(prepared.len());
    let mut jobs = Vec::with_capacity(count);
    for (index, (scene, title)) in prepared.into_iter().enumerate() {
        let source = crate::storage::json_fingerprint(&json!([principal, id, index]));
        let base = scene.seed.unwrap_or_else(|| {
            u64::from_str_radix(&source[..15], 16).unwrap() % (scene.max_seed + 1)
        });
        let target = index.to_string();
        let title = title.unwrap_or_else(|| {
            if scene.kind == "prompt" {
                format!("自定义绘图 {}", index + 1)
            } else {
                scene.id.clone()
            }
        });
        targets.push(json!({"id":target,"title":title,"kind":"scene"}));
        for variant in 0..scene.variants {
            let seed = (base + u64::from(variant)) % (scene.max_seed + 1);
            let mut payload = scene.payload.clone();
            if scene.family != "manga-screen" {
                payload["seed"] = json!(seed);
            }
            let model_id = payload
                .get("modelId")
                .cloned()
                .unwrap_or_else(|| json!(scene.model_id));
            jobs.push(json!({
                "id":uuid::Uuid::new_v4().to_string(), "requestKey":format!("companion_{source}_{variant}"),
                "sceneId":target, "sceneTitle":title, "seed":seed, "variant":variant,
                "modelId":model_id,"width":payload["width"],"height":payload["height"],
                "status":"pending", "submitted":false, "taskInput":payload,
                "snapshot":{"engine":scene.family,"context":{
                    "source":"companion-chat","catalogKind":scene.kind,"catalogId":scene.id,"batchId":id,
                    "history":{"sceneTitle":title}
                }}
            }));
        }
    }
    Ok(json!({
        "version":1,"runtimeOwned":true,"engine":"anima","createdAt":generation::now(),
        "origin":"companion-chat","companionIntent":fingerprint,"preview":preview,
        "owner":{"kind":"workspace","workspaceId":storage.workspace_id(),"principalId":principal},
        "targets":targets,"jobs":jobs
    }))
}
