use super::super::*;
use super::{Batch, MAX_BATCH, MAX_WAITING, lifecycle};
use futures_util::{StreamExt, stream};
use rusqlite::params;
use std::time::Duration;

const FUSION_CONCURRENCY: usize = 4;
const FUSION_BUDGET: Duration = Duration::from_secs(25);

pub(in super::super) async fn create(
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
        enqueue(&state, &muse, &owner, key, model, scenes).await
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

pub(in super::super) async fn enqueue(
    state: &crate::AppState,
    muse: &Muse,
    owner: &str,
    key: String,
    model: Option<String>,
    scenes: Vec<SceneSelection>,
) -> Result<Value> {
    let config = &state.config;
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
        return lifecycle::read(muse, key, None, false).await;
    }

    let config = config.clone();
    let loras_root = settings.loras_root.clone();
    let mut prepared = tokio::task::spawn_blocking(move || {
        submission::prepare_batch(&config, loras_root, scenes, model.as_deref())
    })
    .await
    .map_err(|_| unavailable())??;

    // Best-effort Chat-API semantic fusion for multi-character MOSS cast layouts;
    // falls back silently to the deterministic Layer-1 layout when offline/unconfigured.
    if state.chat.is_some() {
        let empty_headers = HeaderMap::new();
        let cancel = muse.images.shutdown.child_token();
        let _guard = cancel.clone().drop_guard();
        let candidates = prepared.iter_mut().filter_map(|scene| {
            scene
                .cast_fusion
                .take()
                .map(|input| (&mut scene.payload, input))
        });
        let work =
            stream::iter(candidates).for_each_concurrent(FUSION_CONCURRENCY, |(payload, input)| {
                let cancel = &cancel;
                let headers = &empty_headers;
                async move {
                    let outcome =
                        crate::interrogate::fuse::fuse_moss_cast(state, headers, input, cancel)
                            .await;
                    if outcome.fused {
                        payload["prompt"] = json!(outcome.prompt);
                    }
                }
            });
        let _ = tokio::time::timeout(FUSION_BUDGET, work).await;
    }

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

pub(in super::super) async fn enqueue_prepared(
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
    lifecycle::read(muse, key, None, false).await
}
