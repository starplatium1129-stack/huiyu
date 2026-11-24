//! Standalone remote image upscaling (Remacri pixel-only via `native_upscale` or Anima `hiresOnly` UltraSharp/Remacri).
use super::*;
use axum::body::Bytes;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use image::{ImageDecoder, ImageReader, metadata::Orientation};
use sha2::{Digest, Sha256};
use std::io::Cursor;

pub(crate) const UPSCALE_PATH: &str = "/api/muse/upscale";
pub(crate) const MAX_BASE64_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_BASE64_LEN: usize = MAX_BASE64_IMAGE_BYTES.div_ceil(3) * 4;
pub(super) const MAX_BODY_BYTES: usize = MAX_BASE64_LEN + 64 * 1024;
const MIN_IMAGE_BYTES: usize = 1024;
const MAX_STORED_IMAGE_BYTES: usize = 16 * 1024 * 1024;
const DEFAULT_MOSS_UPSCALE_MODEL: &str = "moss-miaomiao-base-v1.1";

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct UpscaleRequest {
    request_key: String,
    #[serde(alias = "imageId")]
    init_image: Option<String>,
    image_base64: Option<String>,
    mime_type: Option<String>,
    upscaler: Option<String>,
    scale: Option<f64>,
    model_id: Option<String>,
    source_task_id: Option<String>,
    prompt: Option<String>,
    negative: Option<String>,
    hires_denoise: Option<f64>,
    hires_steps: Option<u64>,
    hires_cfg: Option<f64>,
    seed: Option<u64>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum UpscalerKind {
    Remacri,
    UltraSharp,
}

impl UpscalerKind {
    fn parse(raw: Option<&str>) -> Result<Self> {
        match raw
            .unwrap_or("remacri")
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "remacri" => Ok(Self::Remacri),
            "ultrasharp" | "4x-ultrasharp" => Ok(Self::UltraSharp),
            _ => Err(ApiError::invalid("upscaler 仅支持 remacri 或 ultrasharp")),
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::Remacri => "remacri",
            Self::UltraSharp => "ultrasharp",
        }
    }

    fn anima_name(self) -> &'static str {
        match self {
            Self::Remacri => "Remacri",
            Self::UltraSharp => "4x-UltraSharp",
        }
    }
}

fn deterministic_source_uuid(request_key: &str) -> String {
    let digest = Sha256::digest(format!("huiyu-muse-upscale:{request_key}").as_bytes());
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    uuid::Uuid::from_bytes(bytes).to_string()
}

fn probe_dimensions(bytes: &[u8]) -> Result<(u64, u64)> {
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| ApiError::new(400, "INVALID_IMAGE", "无法识别放大输入图像格式"))?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader
        .into_decoder()
        .map_err(|_| ApiError::new(400, "INVALID_IMAGE", "放大输入图像损坏或不受支持"))?;
    let (w, h) = decoder.dimensions();
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let (width, height) = match orientation {
        Orientation::Rotate90
        | Orientation::Rotate270
        | Orientation::Rotate90FlipH
        | Orientation::Rotate270FlipH => (u64::from(h), u64::from(w)),
        _ => (u64::from(w), u64::from(h)),
    };
    if width == 0 || height == 0 {
        return Err(ApiError::new(400, "INVALID_IMAGE", "放大输入图像尺寸无效"));
    }
    Ok((width, height))
}

async fn resolve_input_image(
    muse: &Muse,
    owner: &str,
    reuse: Option<Arc<remote::UploadIndex>>,
    init_image: Option<String>,
    image_base64: Option<String>,
    mime_type: Option<String>,
    cancel: &CancellationToken,
) -> Result<(String, u64, u64)> {
    match (init_image, image_base64) {
        (Some(_), Some(_)) | (None, None) => {
            return Err(ApiError::invalid(
                "请二选一提供已上传的 initImage（或 imageId）或 imageBase64",
            ));
        }
        (Some(name), None) => {
            if mime_type.is_some() {
                return Err(ApiError::invalid("mimeType 仅用于 imageBase64 输入"));
            }
            if !inputs::valid_name(&name) {
                return Err(ApiError::invalid("initImage 必须是已上传的有效图像名称"));
            }
            let root = inputs::root(&muse.images.config, muse.images.native);
            let file_path = root.join(&name);
            let meta = tokio::fs::symlink_metadata(&file_path)
                .await
                .map_err(|_| {
                    ApiError::new(
                        404,
                        "TASK_INPUT_MISSING",
                        format!("找不到已上传的原图 {name}，请先上传至 /api/{{family}}/images/raw"),
                    )
                })?;
            if !meta.is_file() || meta.file_type().is_symlink() {
                return Err(ApiError::new(
                    400,
                    "TASK_INPUT_INVALID",
                    "放大原图不是普通文件",
                ));
            }
            if meta.len() == 0 || meta.len() > MAX_STORED_IMAGE_BYTES as u64 {
                return Err(ApiError::new(
                    400,
                    "TASK_INPUT_INVALID",
                    "放大原图超过 16 MiB 限制",
                ));
            }
            let bytes = Arc::new(tokio::fs::read(&file_path).await?);
            if bytes.len() > MAX_STORED_IMAGE_BYTES {
                return Err(ApiError::new(
                    400,
                    "TASK_INPUT_INVALID",
                    "放大原图超过 16 MiB 限制",
                ));
            }
            if decode::sniff(&bytes).is_none() {
                return Err(ApiError::new(
                    400,
                    "INVALID_IMAGE",
                    "放大原图不是受支持的 PNG/JPEG/WebP 图像",
                ));
            }
            if !admission::owner_matches(&root, &name, bytes.clone(), owner, cancel).await? {
                return Err(ApiError::new(
                    403,
                    "TASK_INPUT_FORBIDDEN",
                    "放大原图不属于当前所有者",
                ));
            }
            let (w, h) = tokio::task::spawn_blocking(move || probe_dimensions(&bytes))
                .await
                .map_err(|_| unavailable())??;
            Ok((name, w, h))
        }
        (None, Some(encoded)) => {
            let trimmed = encoded.trim();
            if trimmed.is_empty() {
                return Err(ApiError::new(
                    400,
                    "INVALID_IMAGE",
                    "缺少 imageBase64 图像数据",
                ));
            }
            if trimmed.len() > MAX_BASE64_LEN {
                return Err(ApiError::new(
                    413,
                    "IMAGE_TOO_LARGE",
                    "Base64 放大原图解码后不能超过 8 MiB",
                ));
            }
            let decoded = STANDARD.decode(trimmed.as_bytes()).map_err(|_| {
                ApiError::new(400, "INVALID_IMAGE", "imageBase64 不是有效的标准 Base64")
            })?;
            if decoded.len() > MAX_BASE64_IMAGE_BYTES {
                return Err(ApiError::new(
                    413,
                    "IMAGE_TOO_LARGE",
                    "Base64 放大原图解码后不能超过 8 MiB",
                ));
            }
            if decoded.len() < MIN_IMAGE_BYTES {
                return Err(ApiError::new(400, "INVALID_IMAGE", "放大原图过小"));
            }
            let (sniffed, _) = decode::sniff(&decoded).ok_or_else(|| {
                ApiError::new(400, "INVALID_IMAGE", "仅支持 PNG、JPEG 或 WebP 图片")
            })?;
            if let Some(declared) = mime_type.as_deref() {
                let normalized = declared.trim().to_ascii_lowercase();
                if !matches!(normalized.as_str(), "image/png" | "image/jpeg" | "image/webp")
                    || normalized != sniffed
                {
                    return Err(ApiError::new(
                        400,
                        "INVALID_IMAGE",
                        "声明的 mimeType 与实际图片格式不匹配",
                    ));
                }
            }
            let probe_bytes = Bytes::from(decoded);
            let for_probe = probe_bytes.clone();
            let (w, h) = tokio::task::spawn_blocking(move || probe_dimensions(&for_probe))
                .await
                .map_err(|_| unavailable())??;
            let admission = crate::images::upload_body::admit(cancel).await?;
            let name = muse
                .images
                .upload(
                    probe_bytes,
                    owner.to_owned(),
                    cancel.clone(),
                    admission,
                    reuse,
                )
                .await?;
            Ok((name, w, h))
        }
    }
}

pub(super) async fn create(
    State(state): State<crate::AppState>,
    Extension(muse): Extension<Arc<Muse>>,
    reuse: Option<Extension<Arc<remote::UploadIndex>>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(input): Json<UpscaleRequest>,
) -> Response {
    if let Some(response) = muse.job_limit.check(false) {
        return response;
    }
    let result = create_inner(
        state,
        muse,
        reuse.map(|Extension(index)| index),
        peer,
        headers,
        input,
    )
    .await;
    http::response(result, StatusCode::ACCEPTED)
}

async fn create_inner(
    state: crate::AppState,
    muse: Arc<Muse>,
    reuse: Option<Arc<remote::UploadIndex>>,
    peer: SocketAddr,
    headers: HeaderMap,
    input: UpscaleRequest,
) -> Result<Value> {
    state.host.check_running()?;
    let owner = generation::request_owner(&headers, peer, &HashMap::new());
    let store = muse.store()?;
    if owner != store.owner {
        return Err(ApiError::new(
            403,
            "TASK_INPUT_FORBIDDEN",
            "远程放大需要有效的当前所有者凭据",
        ));
    }
    let key = input.request_key.clone();
    muse.images
        .requests
        .intent(key.clone(), owner.clone(), "anima")?;

    let upscaler = UpscalerKind::parse(input.upscaler.as_deref())?;
    let scale = input.scale.unwrap_or(1.5);
    if !scale.is_finite() {
        return Err(ApiError::invalid("scale 必须是有限数值"));
    }

    let cancel = state.shutdown.child_token();
    let _guard = cancel.clone().drop_guard();
    let (image_name, src_w, src_h) = resolve_input_image(
        &muse,
        &owner,
        reuse,
        input.init_image,
        input.image_base64,
        input.mime_type,
        &cancel,
    )
    .await?;

    if !(512..=1536).contains(&src_w)
        || !(512..=1536).contains(&src_h)
        || src_w % 16 != 0
        || src_h % 16 != 0
    {
        return Err(ApiError::invalid(format!(
            "独立放大原图宽高须为 512–1536 且为 16 的倍数（当前 {src_w}×{src_h}）"
        )));
    }

    let requested_model = input.model_id.as_deref().map(str::trim);
    let use_moss_pixel = upscaler == UpscalerKind::Remacri
        && (scale == 1.5 || scale == 2.0)
        && requested_model.is_none_or(|id| {
            generation::native::adapters::model(id)
                .is_some_and(|spec| spec["family"] == "moss-image")
        });

    let (prepared, target_w, target_h, resolved_model, resolved_family) = if use_moss_pixel {
        if input.negative.as_deref().is_some_and(|s| !s.is_empty())
            || input.hires_denoise.is_some()
            || input.hires_steps.is_some()
            || input.hires_cfg.is_some()
        {
            return Err(ApiError::invalid(
                "Remacri 纯像素放大不接受 negative、hiresDenoise、hiresSteps 或 hiresCfg",
            ));
        }
        let model = requested_model.unwrap_or(DEFAULT_MOSS_UPSCALE_MODEL);
        let target_w = ((src_w as f64) * scale).round() as u64;
        let target_h = ((src_h as f64) * scale).round() as u64;
        let source_task_id = match input.source_task_id.as_deref() {
            Some(id) if uuid::Uuid::parse_str(id).is_ok() => id.to_owned(),
            Some(_) => return Err(ApiError::invalid("sourceTaskId 必须是有效的 UUID")),
            None => deterministic_source_uuid(&key),
        };
        let seed = input.seed.unwrap_or(0);
        if seed > 2_147_483_647 {
            return Err(ApiError::invalid("Remacri 放大 seed 须为 0–2147483647"));
        }
        let payload = json!({
            "modelId": model,
            "prompt": input.prompt.as_deref().unwrap_or(""),
            "negative": "",
            "width": target_w,
            "height": target_h,
            "steps": 0,
            "cfg": 0,
            "seed": seed,
            "initImage": image_name,
            "mossUpscaleScale": scale,
            "mossUpscaleSourceTaskId": source_task_id,
        });
        // Reuse `runtime-rs/src/images/native_upscale.rs` directly via `native_adapters::validate`.
        native_adapters::validate(&payload, "moss-image")?;
        (
            PreparedScene {
                kind: "upscale".into(),
                id: upscaler.id().into(),
                family: "moss-image",
                model_id: model.to_owned(),
                payload,
                seed: Some(seed),
                max_seed: 2_147_483_647,
                variants: 1,
            },
            target_w,
            target_h,
            model.to_owned(),
            "moss-image",
        )
    } else {
        if input.source_task_id.is_some() {
            return Err(ApiError::invalid(
                "sourceTaskId 仅用于 MOSS Remacri 1.5x/2x 纯像素放大",
            ));
        }
        if !(1.1..=3.0).contains(&scale) {
            return Err(ApiError::invalid("Anima 独立放大倍率 scale 须在 1.1–3.0 之间"));
        }
        let model = requested_model.unwrap_or(ANIMA);
        let spec = catalog::model(model)?;
        if spec["family"] != "anima" {
            return Err(ApiError::invalid(
                "UltraSharp 或自定义倍率放大需要 Anima 模型 ID（默认 anima-miaomiao-v1.6）",
            ));
        }
        if input.seed.is_some_and(|seed| seed > MAX_SEED) {
            return Err(ApiError::invalid(format!("seed 须为 0–{MAX_SEED}")));
        }
        let default_prompt = match upscaler {
            UpscalerKind::UltraSharp => "masterpiece, best quality",
            UpscalerKind::Remacri => "upscale",
        };
        let prompt = input
            .prompt
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(default_prompt);
        let mut payload = json!({
            "modelId": model,
            "prompt": prompt,
            "negative": input.negative.as_deref().unwrap_or(""),
            "width": src_w,
            "height": src_h,
            "steps": spec["steps"],
            "cfg": spec["cfg"],
            "teaCache": false,
            "initImage": image_name,
            "denoisingStrength": 0.8,
            "hiresFix": true,
            "hiresOnly": true,
            "hiresUpscaler": upscaler.anima_name(),
            "hiresScale": scale,
            "hiresDenoise": input.hires_denoise.unwrap_or(0.8),
            "hiresSteps": input.hires_steps.unwrap_or(10),
            "hiresCfg": input.hires_cfg.unwrap_or(5.5),
        });
        if let Some(seed) = input.seed {
            payload["seed"] = json!(seed);
        }
        submission::prepare_payload(&mut payload, "anima")?;
        let target_w = (((src_w as f64) * scale / 16.0).round() as u64) * 16;
        let target_h = (((src_h as f64) * scale / 16.0).round() as u64) * 16;
        (
            PreparedScene {
                kind: "upscale".into(),
                id: upscaler.id().into(),
                family: "anima",
                model_id: model.to_owned(),
                payload,
                seed: input.seed,
                max_seed: MAX_SEED,
                variants: 1,
            },
            target_w,
            target_h,
            model.to_owned(),
            "anima",
        )
    };

    let fingerprint = crate::storage::json_fingerprint(&json!([
        "upscale",
        upscaler.id(),
        resolved_family,
        resolved_model,
        image_name,
        scale,
        src_w,
        src_h,
        input.source_task_id,
        input.prompt,
        input.negative,
        input.hires_denoise,
        input.hires_steps,
        input.hires_cfg,
        input.seed,
    ]));

    let mut receipt = batches::enqueue_prepared(
        &muse,
        &owner,
        key,
        fingerprint,
        vec![prepared],
        upscaler == UpscalerKind::Remacri,
        upscaler == UpscalerKind::UltraSharp,
    )
    .await?;
    receipt["upscale"] = json!({
        "upscaler": upscaler.id(),
        "family": resolved_family,
        "modelId": resolved_model,
        "scale": scale,
        "initImage": image_name,
        "sourceWidth": src_w,
        "sourceHeight": src_h,
        "targetWidth": target_w,
        "targetHeight": target_h,
    });
    Ok(receipt)
}
