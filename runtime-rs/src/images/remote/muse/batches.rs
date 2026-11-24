use super::*;
use rusqlite::params;

pub(super) const MAX_BATCH: usize = 16;
const MAX_WAITING: i64 = 64;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Batch {
    pub(super) request_key: String,
    model_id: Option<String>,
    variants: Option<u8>,
    seed: Option<u64>,
    width: Option<u64>,
    height: Option<u64>,
    upscale: Option<submission::Upscale>,
    tea_cache: Option<bool>,
    tea_cache_thresh: Option<f64>,
    moss_sampler: Option<String>,
    moss_acceleration: Option<String>,
    moss_spectrum_flex_window: Option<f64>,
    #[serde(alias = "imageId")]
    init_image: Option<String>,
    reference_images: Option<Vec<String>>,
    denoising_strength: Option<f64>,
    mask_image: Option<String>,
    mask_prompt: Option<String>,
    mask_threshold: Option<f64>,
    grow_mask_by: Option<u64>,
    style_lora_id: Option<String>,
    sketch_control: Option<Value>,
    regions: Option<Vec<Value>>,
    layout: Option<Value>,
    #[serde(default, alias = "items")]
    scenes: Vec<SceneSelection>,
    #[serde(default)]
    ids: Vec<String>,
}

impl Batch {
    pub(super) fn selections(mut self) -> Result<(Option<String>, Vec<SceneSelection>)> {
        if !self.ids.is_empty() && !self.scenes.is_empty() {
            return Err(ApiError::invalid(
                "请用 ids 提交目录 ID，或用 items 为每项指定参数",
            ));
        }
        self.scenes
            .extend(self.ids.into_iter().map(|id| SceneSelection {
                id: Some(id),
                ..Default::default()
            }));
        let default_size = submission::dimensions(self.width, self.height)?;
        for scene in &mut self.scenes {
            scene.variants = scene.variants.or(self.variants);
            scene.seed = scene.seed.or(self.seed);
            scene.upscale = scene.upscale.or(self.upscale);
            scene.tea_cache = scene.tea_cache.or(self.tea_cache);
            scene.tea_cache_thresh = scene.tea_cache_thresh.or(self.tea_cache_thresh);
            if scene.moss_sampler.is_none() {
                scene.moss_sampler.clone_from(&self.moss_sampler);
            }
            if scene.moss_acceleration.is_none() {
                scene.moss_acceleration.clone_from(&self.moss_acceleration);
            }
            scene.moss_spectrum_flex_window = scene
                .moss_spectrum_flex_window
                .or(self.moss_spectrum_flex_window);
            if scene.init_image.is_none() {
                scene.init_image.clone_from(&self.init_image);
            }
            if scene.reference_images.is_none() {
                scene.reference_images.clone_from(&self.reference_images);
            }
            scene.denoising_strength = scene.denoising_strength.or(self.denoising_strength);
            if scene.mask_image.is_none() {
                scene.mask_image.clone_from(&self.mask_image);
            }
            if scene.mask_prompt.is_none() {
                scene.mask_prompt.clone_from(&self.mask_prompt);
            }
            scene.mask_threshold = scene.mask_threshold.or(self.mask_threshold);
            scene.grow_mask_by = scene.grow_mask_by.or(self.grow_mask_by);
            if scene.style_lora_id.is_none() {
                scene.style_lora_id.clone_from(&self.style_lora_id);
            }
            if scene.sketch_control.is_none() {
                scene.sketch_control.clone_from(&self.sketch_control);
            }
            if scene.regions.is_none() {
                scene.regions.clone_from(&self.regions);
            }
            if scene.layout.is_none() {
                scene.layout.clone_from(&self.layout);
            }
            if scene.width.is_none()
                && scene.height.is_none()
                && let Some((width, height)) = default_size
            {
                scene.width = Some(width);
                scene.height = Some(height);
            }
        }
        Ok((self.model_id, self.scenes))
    }
}

pub(super) async fn create(
    State(state): State<crate::AppState>,
    Extension(muse): Extension<Arc<Muse>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(input): Json<Batch>,
) -> Response {
    if let Some(response) = muse.job_limit.check(false) {
        return response;
    }
    let result = async {
        state.host.check_running()?;
        let owner = generation::request_owner(&headers, peer, &HashMap::new());
        let key = input.request_key.clone();
        let (model, scenes) = input.selections()?;
        enqueue(&state.config, &muse, &owner, key, model, scenes).await
    }
    .await;
    http::response(result, StatusCode::ACCEPTED)
}

async fn verify_owned_inputs(muse: &Muse, owner: &str, prepared: &[PreparedScene]) -> Result<()> {
    let mut names: Vec<String> = prepared
        .iter()
        .flat_map(|scene| inputs::input_names(&scene.payload))
        .map(str::to_owned)
        .collect();
    names.sort_unstable();
    names.dedup();
    if names.is_empty() {
        return Ok(());
    }
    let root = inputs::root(&muse.images.config, muse.images.native);
    let cancel = muse.images.shutdown.child_token();
    let _guard = cancel.clone().drop_guard();
    const MAX_INPUT_BYTES: usize = 16 * 1024 * 1024;
    for name in names {
        if !inputs::valid_name(&name) {
            return Err(ApiError::invalid("输入图像文件名无效"));
        }
        let file = root.join(&name);
        let meta = tokio::fs::symlink_metadata(&file).await.map_err(|_| {
            ApiError::new(
                404,
                "TASK_INPUT_MISSING",
                format!("找不到已上传的参考图 {name}，请先上传至对应模型 images/raw"),
            )
        })?;
        if !meta.is_file() || meta.file_type().is_symlink() {
            return Err(ApiError::new(
                400,
                "TASK_INPUT_INVALID",
                "输入图像不是普通文件",
            ));
        }
        if meta.len() == 0 || meta.len() > MAX_INPUT_BYTES as u64 {
            return Err(ApiError::new(
                400,
                "TASK_INPUT_INVALID",
                "输入图像超过 16 MiB 限制",
            ));
        }
        let bytes = Arc::new(tokio::fs::read(&file).await?);
        if bytes.is_empty() || bytes.len() > MAX_INPUT_BYTES {
            return Err(ApiError::new(
                400,
                "TASK_INPUT_INVALID",
                "输入图像超过 16 MiB 限制",
            ));
        }
        if decode::sniff(&bytes).is_none() {
            return Err(ApiError::new(
                400,
                "TASK_INPUT_INVALID",
                "任务输入不是受支持的 PNG/JPEG/WebP 图像",
            ));
        }
        if !admission::owner_matches(&root, &name, bytes, owner, &cancel).await? {
            return Err(ApiError::new(
                403,
                "TASK_INPUT_FORBIDDEN",
                "图像素材不属于当前所有者",
            ));
        }
    }
    Ok(())
}

pub(super) async fn enqueue(
    config: &crate::config::Config,
    muse: &Muse,
    owner: &str,
    key: String,
    model: Option<String>,
    scenes: Vec<SceneSelection>,
) -> Result<Value> {
    let count: usize = scenes
        .iter()
        .map(|s| usize::from(s.variants.unwrap_or(1).max(1)))
        .sum();
    if !(1..=MAX_BATCH).contains(&count) {
        return Err(ApiError::invalid("每批可提交 1–16 张图片，包含场景变体"));
    }
    let store = muse.store()?;
    if owner != store.owner {
        return Err(ApiError::new(
            403,
            "TASK_INPUT_FORBIDDEN",
            "远程出图需要有效的当前所有者凭据",
        ));
    }
    muse.images
        .requests
        .intent(key.clone(), owner.into(), "anima")?;
    let fingerprint = crate::storage::json_fingerprint(&json!([model, scenes]));
    let settings = muse.images.backend.native_settings()?;
    let batch_check = key.clone();
    let fp_check = fingerprint.clone();
    let already_exists = store
        .work(move |db, store| {
            match db
                .query_row(
                    "SELECT fingerprint FROM muse_batches WHERE owner=?1 AND key=?2",
                    params![store.owner, batch_check],
                    |r| r.get::<_, String>(0),
                )
                .optional()?
            {
                None => Ok(false),
                Some(value) if value == fp_check => Ok(true),
                Some(_) => Err(ApiError::new(
                    409,
                    "MUSE_BATCH_CONFLICT",
                    "此编号已用于其他出图参数；修改参数后请换一个 requestKey",
                )),
            }
        })
        .await?;
    if already_exists {
        return read(muse, key, None, false).await;
    }

    let config = config.clone();
    let loras_root = settings.loras_root.clone();
    let mut prepared = tokio::task::spawn_blocking(move || {
        submission::prepare_batch(&config, loras_root, scenes, model.as_deref())
    })
    .await
    .map_err(|_| unavailable())??;

    if let Some(receipt) = legacy::find(muse, &key).await? {
        if !legacy::matches(&receipt, &mut prepared) {
            return Err(ApiError::new(
                409,
                "MUSE_BATCH_CONFLICT",
                "此编号已用于其他出图参数；新任务请换一个 requestKey",
            ));
        }
        if receipt.job_id.is_some()
            || receipt.cancel_requested
            || !receipt
                .error
                .as_ref()
                .is_some_and(|error| error.status == 429)
        {
            return legacy::view(muse, receipt).await;
        }
    }

    verify_owned_inputs(muse, owner, &prepared).await?;

    let needs_ultrasharp = prepared.iter().any(|scene| {
        scene.payload["hiresFix"] == true && scene.payload["hiresUpscaler"] == "4x-UltraSharp"
    });
    let needs_remacri = prepared.iter().any(|scene| {
        (scene.payload["hiresFix"] == true && scene.payload["hiresUpscaler"] == "Remacri")
            || scene.payload["mossUpscaleScale"].is_number()
    });
    enqueue_prepared(
        muse,
        owner,
        key,
        fingerprint,
        prepared,
        needs_remacri,
        needs_ultrasharp,
    )
    .await
}

pub(super) async fn enqueue_prepared(
    muse: &Muse,
    owner: &str,
    key: String,
    fingerprint: String,
    prepared: Vec<PreparedScene>,
    needs_remacri: bool,
    needs_ultrasharp: bool,
) -> Result<Value> {
    let count: usize = prepared
        .iter()
        .map(|scene| usize::from(scene.variants.max(1)))
        .sum();
    if !(1..=MAX_BATCH).contains(&count) {
        return Err(ApiError::invalid("每批可提交 1–16 张图片，包含场景变体"));
    }
    let store = muse.store()?;
    if owner != store.owner {
        return Err(ApiError::new(
            403,
            "TASK_INPUT_FORBIDDEN",
            "远程出图需要有效的当前所有者凭据",
        ));
    }
    let settings = muse.images.backend.native_settings()?;
    let batch = key.clone();
    store
        .work(move |db, store| {
            let existing = |db: &Connection| -> Result<bool> {
                match db
                    .query_row(
                        "SELECT fingerprint FROM muse_batches WHERE owner=?1 AND key=?2",
                        params![store.owner, batch],
                        |r| r.get::<_, String>(0),
                    )
                    .optional()?
                {
                    None => Ok(false),
                    Some(value) if value == fingerprint => Ok(true),
                    Some(_) => Err(ApiError::new(
                        409,
                        "MUSE_BATCH_CONFLICT",
                        "此编号已用于其他出图参数；修改参数后请换一个 requestKey",
                    )),
                }
            };
            if existing(db)? {
                return Ok(());
            }
            let upscalers = &settings.models_root;
            for (needed, name, installed) in [
                (
                    needs_ultrasharp,
                    "4x-UltraSharp",
                    generation::native::resources::ultrasharp(upscalers),
                ),
                (
                    needs_remacri,
                    "Remacri",
                    generation::native::resources::remacri(upscalers),
                ),
            ] {
                if needed && installed.is_none() {
                    return Err(ApiError::new(
                        409,
                        "NATIVE_UPSCALER_UNAVAILABLE",
                        format!("出图机尚未安装 {name}，请先在控制室准备权重"),
                    ));
                }
            }
            let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            if existing(&tx)? {
                return Ok(());
            }
            let waiting: i64 = tx.query_row(
                "SELECT count(*) FROM muse_items WHERE owner=?1 AND status='waiting'",
                [&store.owner],
                |r| r.get(0),
            )?;
            if waiting + count as i64 > MAX_WAITING {
                return Err(ApiError::new(
                    429,
                    "MUSE_QUEUE_FULL",
                    "远程批量队列已满，请等前面的任务完成或取消等待项",
                ));
            }
            tx.execute(
                "INSERT INTO muse_batches(owner,key,fingerprint,created) VALUES (?1,?2,?3,?4)",
                params![store.owner, batch, fingerprint, generation::now()],
            )?;
            let mut insert = tx.prepare(
                "INSERT INTO muse_items(owner,batch,request,family,kind,scene,model,seed,variant,payload)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            )?;
            for (index, mut scene) in prepared.into_iter().enumerate() {
                let source = crate::storage::json_fingerprint(&json!([store.owner, batch, index]));
                let base = scene.seed.unwrap_or_else(|| {
                    u64::from_str_radix(&source[..15], 16).unwrap() % (scene.max_seed + 1)
                });
                let model = scene.model_id.clone();
                for variant in 0..scene.variants {
                    let request = format!("muse_{source}_{variant}");
                    let seed = (base + u64::from(variant)) % (scene.max_seed + 1);
                    if scene.family != "manga-screen" {
                        scene.payload["seed"] = json!(seed);
                    }
                    insert.execute(params![
                        store.owner,
                        batch,
                        request,
                        scene.family,
                        scene.kind,
                        scene.id,
                        model,
                        seed as i64,
                        i64::from(variant) + 1,
                        scene.payload.to_string()
                    ])?;
                }
            }
            drop(insert);
            tx.commit()?;
            Ok(())
        })
        .await?;
    muse.batch_ready.notify_one();
    read(muse, key, None, false).await
}

pub(super) async fn dispatch(muse: Arc<Muse>, host: Arc<crate::host::HostAuthority>) {
    let Ok(store) = muse.store() else {
        return;
    };
    loop {
        if muse.images.shutdown.is_cancelled() {
            return;
        }
        let next = async {
            let _write = host.admit_owned()?;
            let _gate = muse.batch_gate.lock().await;
            let item = store.work(|db, store| {
                Ok(db.query_row("SELECT request,family,payload FROM muse_items WHERE owner=?1 AND status='waiting' ORDER BY pos LIMIT 1", [&store.owner],
                    |r| Ok((r.get::<_,String>(0)?, r.get::<_,String>(1)?, r.get::<_,String>(2)?))).optional()?)
            }).await?;
            let Some((request, family, payload)) = item else { return Ok::<Option<Duration>, ApiError>(None); };
            let family = match family.as_str() {
                "anima" => "anima",
                "krea2" => "krea2",
                "qwen-image" => "qwen-image",
                "keyframe" => "keyframe",
                "manga-screen" => "manga-screen",
                _ => "moss-image",
            };
            let (receipt, accepting) = match muse.images.requests.status(&request, &store.owner, family).await? {
                Some(receipt) if receipt.job_id.is_none() && !receipt.cancel_requested && receipt.error.is_none() => {
                    let (receipt, accepting) = muse.images.requests.refresh(receipt).await?;
                    (Some(receipt), accepting)
                }
                receipt => (receipt, false),
            };
            let result = match receipt {
                Some(receipt) if receipt.job_id.is_some() => Ok(json!({"job":{"id":receipt.job_id}})),
                Some(receipt) if receipt.cancel_requested => Ok(json!({"cancelled":true})),
                Some(receipt) if receipt.error.as_ref().is_some_and(|e| e.status != 429) => Ok(json!({"rejected":receipt.error})),
                Some(_) if accepting => return Ok(Some(Duration::from_millis(200))),
                Some(receipt) if receipt.error.is_none() => Err(ApiError::new(409, "IMAGE_REQUEST_INTERRUPTED", "出图接收曾中断，请确认后重新提交这张图")),
                _ => {
                    // Check capacity before compiling the inference plan or
                    // rewriting the acceptance receipt of the first waiting item.
                    if !muse.images.backend.remote_capacity()? { return Ok(Some(Duration::from_secs(1))); }
                    muse.images.accept_request(serde_json::from_str(&payload)?, request.clone(), store.owner.clone(), family, false).await
                }
            };
            let (status, job, error, code) = match result {
                Ok(value) if value["job"]["id"].is_string() => ("assigned", value["job"]["id"].as_str().map(str::to_owned), None, None),
                Ok(value) if value["cancelled"] == true => ("cancelled", None, None, None),
                Ok(value) if value["rejected"]["status"] == 429 => return Ok(Some(Duration::from_secs(1))),
                Ok(value) if value["rejected"].is_object() => ("failed", None, value["rejected"]["message"].as_str().map(str::to_owned), value["rejected"]["code"].as_str().map(str::to_owned)),
                Ok(_) => return Ok(Some(Duration::from_millis(200))),
                Err(error) if error.status.as_u16() == 429 => return Ok(Some(Duration::from_secs(1))),
                Err(error) if muse.images.shutdown.is_cancelled() => return Err(error),
                Err(error) => ("failed", None, Some(error.message), Some(error.code)),
            };
            store.work(move |db, store| {
                db.execute("UPDATE muse_items SET status=?1,job=?2,error=?3,code=?4,payload='' WHERE owner=?5 AND request=?6 AND status='waiting'",
                    params![status,job,error,code,store.owner,request])?;
                Ok(())
            }).await?;
            Ok(Some(Duration::ZERO))
        }.await;
        match next {
            Ok(Some(delay)) if delay.is_zero() => {
                tokio::task::yield_now().await;
            }
            Ok(Some(delay)) => {
                tokio::select! { _ = muse.images.shutdown.cancelled()=>return, _=tokio::time::sleep(delay)=>{} }
            }
            Ok(None) => {
                tokio::select! { _ = muse.images.shutdown.cancelled()=>return, _=muse.batch_ready.notified()=>{} }
            }
            Err(error) => {
                if muse.images.shutdown.is_cancelled() {
                    return;
                }
                eprintln!("muse dispatch: {}", error.code);
                tokio::select! { _ = muse.images.shutdown.cancelled()=>return, _=tokio::time::sleep(Duration::from_secs(3))=>{} }
            }
        }
    }
}

pub(super) async fn status(
    State(state): State<crate::AppState>,
    Extension(muse): Extension<Arc<Muse>>,
    Path(key): Path<String>,
) -> Response {
    if let Some(response) = muse.poll_limit.check(false) {
        return response;
    }
    http::response(
        async {
            state.host.check_running()?;
            match read(&muse, key.clone(), None, true).await {
                Err(error) if error.code == "MUSE_BATCH_NOT_FOUND" => {
                    match legacy::find(&muse, &key).await? {
                        Some(receipt) => legacy::view(&muse, receipt).await,
                        None => Err(error),
                    }
                }
                result => result,
            }
        }
        .await,
        StatusCode::OK,
    )
}

pub(super) async fn item_status(
    State(state): State<crate::AppState>,
    Extension(muse): Extension<Arc<Muse>>,
    Path((key, request)): Path<(String, String)>,
) -> Response {
    if let Some(response) = muse.poll_limit.check(false) {
        return response;
    }
    http::response(async {
        state.host.check_running()?;
        let mut batch = read(&muse, key, Some(request), true).await?;
        let item = batch["items"].as_array_mut().and_then(Vec::pop).ok_or_else(batch_missing)?;
        Ok(json!({"item":item,"batchKey":batch["batchKey"],"batchStatusPath":batch["statusPath"]}))
    }.await, StatusCode::OK)
}

pub(super) async fn cancel_item(
    State(state): State<crate::AppState>,
    Extension(muse): Extension<Arc<Muse>>,
    Path((key, request)): Path<(String, String)>,
) -> Response {
    http::response(
        async {
            state.host.check_running()?;
            cancel(muse, key, Some(request)).await
        }
        .await,
        StatusCode::ACCEPTED,
    )
}

pub(super) async fn cancel_batch(
    State(state): State<crate::AppState>,
    Extension(muse): Extension<Arc<Muse>>,
    Path(key): Path<String>,
) -> Response {
    http::response(
        async {
            state.host.check_running()?;
            cancel(muse, key, None).await
        }
        .await,
        StatusCode::ACCEPTED,
    )
}

async fn cancel(muse: Arc<Muse>, key: String, request: Option<String>) -> Result<Value> {
    let worker = muse.clone();
    muse.images
        .uploads
        .spawn(async move { cancel_known(&worker, key, request).await })
        .await
        .map_err(|_| ApiError::new(503, "MUSE_CANCEL_UNKNOWN", "取消结果未知，请查询原批次"))?
}

async fn cancel_known(muse: &Muse, key: String, request: Option<String>) -> Result<Value> {
    let _gate = muse.batch_gate.lock().await;
    let (batch, target) = (key.clone(), request.clone());
    let store = muse.store()?;
    let items = store.work(move |db, store| {
        let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut statement = tx.prepare("SELECT request,family,status FROM muse_items WHERE owner=?1 AND batch=?2 AND (?3 IS NULL OR request=?3) ORDER BY pos")?;
        let items = statement.query_map(params![store.owner,batch,target], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if items.is_empty() { return Err(batch_missing()); }
        drop(statement);
        tx.execute("UPDATE muse_items SET status='cancelled',payload='' WHERE owner=?1 AND batch=?2 AND (?3 IS NULL OR request=?3) AND status='waiting'", params![store.owner,batch,target])?;
        tx.commit()?;
        Ok(items)
    }).await?;
    let mut errors = Vec::new();
    for (request, family, status) in items {
        if matches!(status.as_str(), "waiting" | "assigned" | "cancelled") {
            if status != "assigned"
                && muse
                    .images
                    .requests
                    .status(&request, &store.owner, &family)
                    .await?
                    .is_none()
            {
                continue;
            }
            match muse
                .images
                .cancel_request(&request, &store.owner, &family)
                .await
            {
                Ok(value) if status != "assigned" && value["job"]["id"].is_string() => {
                    let id = value["job"]["id"].as_str().unwrap().to_owned();
                    store.work(move |db, store| {
                        db.execute("UPDATE muse_items SET status='assigned',job=?1 WHERE owner=?2 AND request=?3 AND status='cancelled'",
                            params![id,store.owner,request])?;
                        Ok(())
                    }).await?;
                }
                Ok(_) => {}
                Err(error) => errors
                    .push(json!({"requestKey":request,"code":error.code,"message":error.message})),
            }
        }
    }
    muse.batch_ready.notify_one();
    let mut result = read(muse, key, None, true).await?;
    if !errors.is_empty() {
        result["cancelErrors"] = json!(errors);
    }
    Ok(result)
}

async fn read(muse: &Muse, key: String, request: Option<String>, hydrate: bool) -> Result<Value> {
    let batch = key.clone();
    let store = muse.store()?;
    let (created, mut items) = store.work(move |db, store| {
        let created = db.query_row("SELECT created FROM muse_batches WHERE owner=?1 AND key=?2", params![store.owner,batch], |r| r.get::<_,i64>(0)).optional()?.ok_or_else(batch_missing)?;
        let mut statement = db.prepare("SELECT request,family,kind,scene,model,seed,variant,status,job,error,code FROM muse_items WHERE owner=?1 AND batch=?2 AND (?3 IS NULL OR request=?3) ORDER BY pos")?;
        let rows = statement.query_map(params![store.owner,batch,request], |r| view(r, &batch))?;
        Ok((created, rows.collect::<rusqlite::Result<Vec<_>>>()?))
    }).await?;
    let single = items.len() == 1;
    let mut single_job = Value::Null;
    if hydrate {
        for item in &mut items {
            let (Some(id), Some(family)) = (item["jobId"].as_str(), item["family"].as_str()) else {
                continue;
            };
            let found = match muse.images.get_job(id, &store.owner, family).await {
                Ok(job) => Some(job),
                Err(error) if matches!(error.status.as_u16(), 404 | 410) => {
                    item["status"] = json!("failed");
                    item["code"] = json!(error.code);
                    item["error"] = json!(error.message);
                    None
                }
                Err(error) => return Err(error),
            };
            if let Some(job) = found {
                for field in [
                    "status",
                    "resultAvailable",
                    "resultUrl",
                    "resultBytes",
                    "resultSha256",
                    "generationMs",
                    "finishedAt",
                    "progress",
                    "progressText",
                    "error",
                    "code",
                ] {
                    item[field] = job[field].clone();
                }
                if single {
                    single_job = job;
                }
            }
        }
    }
    let path = format!("/api/muse/batches/{key}");
    let mut batch = json!({"requestKey":key,"batchKey":key,"createdAt":created,"items":items,"statusPath":path,"cancelPath":path});
    if single {
        batch["job"] = single_job;
    }
    Ok(batch)
}

pub(super) fn view(r: &rusqlite::Row<'_>, batch: &str) -> rusqlite::Result<Value> {
    let request: String = r.get(0)?;
    let family: String = r.get(1)?;
    let id: Option<String> = r.get(8)?;
    let path = format!("/api/muse/batches/{batch}/{request}");
    Ok(
        json!({"requestKey":request,"family":family,"kind":r.get::<_,String>(2)?,"id":r.get::<_,String>(3)?,
        "modelId":r.get::<_,String>(4)?,"seed":r.get::<_,i64>(5)?,"variant":r.get::<_,i64>(6)?,"status":r.get::<_,String>(7)?,
        "jobId":id,"error":r.get::<_,Option<String>>(9)?,"code":r.get::<_,Option<String>>(10)?,
        "batchKey":batch,"statusPath":path,"cancelPath":path}),
    )
}

fn batch_missing() -> ApiError {
    ApiError::new(
        404,
        "MUSE_BATCH_NOT_FOUND",
        "找不到这批远程出图或指定的变体",
    )
}
