use super::super::*;
use axum::{
    Extension, Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::{get, post},
};
use rusqlite::{Connection, OptionalExtension};
use std::{collections::HashMap, net::SocketAddr, time::Duration};
use tokio::sync::{Mutex, Notify};

mod batches;
mod cast;
pub(crate) use cast::fusion_scene_is_wardrobe_free;
pub(crate) mod companion;
mod details;
mod history;
mod krea;
mod layout;
mod legacy;
mod library;
mod preview;
mod submission;
pub(crate) mod upscale;
use library::{PreparedScene, RecipeLibrary, recipe_missing, studio_wardrobe, unavailable};
use submission::SceneSelection;

pub(super) const PREVIEW_PATH: &str = "/api/muse/jobs/preview";
const DRAW_BODY_BYTES: usize = 64 * 1024;

pub(crate) const ANIMA: &str = "anima-miaomiao-v1.6";
const MAX_SEED: u64 = 9_007_199_254_740_991;
const MAX_VARIANTS: u8 = 8;
pub(super) fn krea_models() -> Vec<&'static str> {
    generation::native::adapters::manifest()["models"].as_object().unwrap().iter()
        .filter(|(_, model)| model["family"] == "krea2" && model["media"] == "image")
        .map(|(id, _)| id.as_str()).collect()
}
pub(super) fn recipe_models() -> Vec<&'static str> {
    let mut models = vec![ANIMA, "moss-miaomiao-base-v1.0", "moss-miaomiao-base-v1.1"];
    models.extend(krea_models());
    models
}

pub(crate) async fn guest_catalog(state: &crate::AppState, uri: &axum::http::Uri) -> Result<Value> {
    let Query(mut input) =
        Query::<Search>::try_from_uri(uri).map_err(|_| ApiError::invalid("素材查询参数无效"))?;
    if !matches!(
        input.kind.as_str(),
        "character" | "blueprint" | "scene" | "media"
    ) {
        return Err(ApiError::invalid("请选择角色或场景蓝图"));
    }
    input.page_size = input.page_size.min(40);
    lookup(state, input).await
}

pub(in crate::images) async fn guest_recipe(
    state: &crate::AppState,
    images: &Service,
    scene: Option<(String, String)>,
    character: Option<String>,
) -> Result<Value> {
    let config = state.config.clone();
    let loras = if images.native {
        images.backend.native_settings()?.loras_root
    } else {
        config.ai_workspace_root.join("ComfyUI/models/loras")
    };
    tokio::task::spawn_blocking(move || {
        let library = RecipeLibrary::new(&config, loras)?;
        let (kind, id) = if let Some(scene) = scene {
            scene
        } else {
            let character = character.ok_or_else(|| ApiError::invalid("请选择角色"))?;
            ("outfit".into(), library.guest_default_outfit(&character)?)
        };
        let selection = SceneSelection {
            kind: Some(kind),
            id: Some(id),
            ..Default::default()
        };
        Ok(library.prepare(selection, Some(ANIMA))?.payload)
    })
    .await
    .map_err(|_| unavailable())?
}

struct Muse {
    images: Arc<Service>,
    search_limit: generation::RateLimit,
    poll_limit: generation::RateLimit,
    job_limit: generation::RateLimit,
    batch_ready: Notify,
    batch_gate: Mutex<()>,
}

pub(super) fn router(
    images: Arc<Service>,
    host: Arc<crate::host::HostAuthority>,
) -> Router<crate::AppState> {
    let muse = Arc::new(Muse {
        images,
        search_limit: generation::RateLimit::with("素材查询", 30, 500),
        poll_limit: generation::RateLimit::with("出图进度查询", 60, 100),
        job_limit: generation::RateLimit::new("场景出图"),
        batch_ready: Notify::new(),
        batch_gate: Mutex::new(()),
    });
    let worker = muse.clone();
    muse.images
        .uploads
        .spawn(async move { batches::dispatch(worker, host).await });
    Router::new()
        .route("/api/muse/catalog", get(search))
        .route(companion::OPTIONS_PATH, get(companion::remote_drawing_options))
        .route(
            "/api/muse/catalog/{kind}/{*id}",
            get(details::recipe_detail),
        )
        .route(
            "/api/muse/jobs",
            get(history::recent)
                .post(draw)
                .layer(DefaultBodyLimit::max(DRAW_BODY_BYTES)),
        )
        .route(
            PREVIEW_PATH,
            post(preview::draw_preview).layer(DefaultBodyLimit::max(DRAW_BODY_BYTES)),
        )
        .route("/api/muse/queue", get(history::queue))
        .route(
            "/api/muse/batches",
            post(batches::create).layer(DefaultBodyLimit::max(256 * 1024)),
        )
        .route(
            upscale::UPSCALE_PATH,
            post(upscale::create).layer(DefaultBodyLimit::max(upscale::MAX_BODY_BYTES)),
        )
        .route(
            "/api/muse/batches/{key}",
            get(batches::status).delete(batches::cancel_batch),
        )
        .route(
            "/api/muse/batches/{key}/{request}",
            get(batches::item_status).delete(batches::cancel_item),
        )
        .layer(Extension(muse))
}

impl Muse {
    fn store(&self) -> Result<&Arc<generation::remote_images::Store>> {
        self.images.backend.remote_store().ok_or_else(closed)
    }
}

#[derive(serde::Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct Search {
    kind: String,
    search: String,
    character: String,
    category: String,
    rating: String,
    page: i64,
    page_size: i64,
}

impl Default for Search {
    fn default() -> Self {
        Self {
            kind: "media".into(),
            search: String::new(),
            character: String::new(),
            category: String::new(),
            rating: String::new(),
            page: 1,
            page_size: 15,
        }
    }
}

async fn search(
    State(state): State<crate::AppState>,
    Extension(muse): Extension<Arc<Muse>>,
    Query(input): Query<Search>,
) -> Response {
    if let Some(response) = muse.search_limit.check(false) {
        return response;
    }
    let result = async {
        state.host.check_running()?;
        lookup(&state, input).await
    }
    .await;
    http::response(result, StatusCode::OK)
}

async fn lookup(state: &crate::AppState, input: Search) -> Result<Value> {
    let kind = match input.kind.trim() {
        "wardrobe" | "服装" => "outfit",
        "角色" => "character",
        "场景" => "media",
        kind => kind,
    };
    if !matches!(
        kind,
        "character" | "outfit" | "scene" | "blueprint" | "media"
    ) || [
        &input.search,
        &input.character,
        &input.category,
        &input.rating,
    ]
    .iter()
    .any(|value| value.chars().count() > 160)
        || input.page < 1
        || !(1..=500).contains(&input.page_size)
    {
        return Err(ApiError::invalid(
            "查询类型或分页参数无效，pageSize 须为 1–500",
        ));
    }
    let config = state.config.clone();
    let mut query = crate::catalog::Query {
        kind: kind.into(),
        sort: "relevance".into(),
        search: input.search,
        character: input.character,
        category: input.category,
        rating: match input.rating.trim().to_ascii_lowercase().as_str() {
            "" => "",
            "all" => "All",
            "sfw" => "SFW",
            "sensitive" => "Sensitive",
            "r15" => "R15",
            "r18" | "nsfw" => "R18",
            "unrated" => "Unrated",
            _ => {
                return Err(ApiError::invalid(
                    "rating 可用 All、SFW、Sensitive、R15、R18 或 Unrated",
                ));
            }
        }
        .into(),
        page: Some(input.page),
        page_size: Some(input.page_size),
        ..Default::default()
    };
    let facets = state.catalog_facets.clone();
    tokio::task::spawn_blocking(move || {
        let catalog =
            crate::catalog::Catalog::open_readonly(crate::catalog::Options::from_config(&config))?;
        query.character = match query.character.trim() {
            "宁宁" => "nene".into(),
            "夏目" => "natsume".into(),
            character => catalog.remote_character_id(character)?,
        };
        let wardrobe = if query.kind == "outfit"
            && matches!(query.character.as_str(), "" | "nene" | "natsume")
            && matches!(query.category.as_str(), "" | "Clothing")
            && matches!(query.rating.as_str(), "" | "Unrated")
        {
            studio_wardrobe(&config, &query)?
        } else {
            Vec::new()
        };
        let mut result = catalog.remote_lookup(&query, &facets, &wardrobe)?;
        if query.kind == "outfit" {
            let ratings = result["ratings"].as_array_mut().unwrap();
            if !ratings.contains(&json!("Unrated")) {
                ratings.push(json!("Unrated"));
            }
        }
        Ok(result)
    })
    .await
    .map_err(|_| ApiError::new(503, "CATALOG_UNAVAILABLE", "内容库查询未完成"))?
}

async fn draw(
    State(state): State<crate::AppState>,
    Extension(muse): Extension<Arc<Muse>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(mut input): Json<Value>,
) -> Response {
    if let Some(response) = muse.job_limit.check(false) {
        return response;
    }
    let result = async {
        state.host.check_running()?;
        let owner = generation::request_owner(&headers, peer, &HashMap::new());
        let key = input
            .as_object_mut()
            .and_then(|object| object.remove("requestKey"))
            .and_then(|key| key.as_str().map(str::to_owned))
            .ok_or_else(|| ApiError::invalid("请为出图提交指定 requestKey"))?;
        let input: SceneSelection = serde_json::from_value(input)
            .map_err(|error| ApiError::invalid(format!("出图参数无效：{error}")))?;
        batches::enqueue(&state, &muse, &owner, key, None, vec![input]).await
    }
    .await;
    http::response(result, StatusCode::ACCEPTED)
}
