use super::super::*;
use axum::{
    Extension, Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::{get, post},
};
use flate2::{Decompress, FlushDecompress, Status, read::DeflateDecoder};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::{collections::HashMap, io::Read, net::SocketAddr, time::Duration};
use tokio::sync::{Mutex, Notify};

mod batches;
mod details;
mod history;
mod legacy;
mod submission;
use submission::SceneSelection;

const ANIMA: &str = "anima-miaomiao-v1.6";
const RECIPE_DATABASE: &str = "remote-scene-recipes.sqlite";
const MAX_SEED: u64 = 9_007_199_254_740_991;
const MAX_VARIANTS: u8 = 8;
const RECIPE_MODELS: &[&str] = &[ANIMA, "moss-miaomiao-base-v1.0", "moss-miaomiao-base-v1.1"];

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
        .route(
            "/api/muse/catalog/{kind}/{*id}",
            get(details::recipe_detail),
        )
        .route(
            "/api/muse/jobs",
            get(history::recent)
                .post(draw)
                .layer(DefaultBodyLimit::max(64 * 1024)),
        )
        .route("/api/muse/queue", get(history::queue))
        .route(
            "/api/muse/batches",
            post(batches::create).layer(DefaultBodyLimit::max(256 * 1024)),
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
            let catalog = crate::catalog::Catalog::open_readonly(
                crate::catalog::Options::from_config(&config),
            )?;
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
    .await;
    http::response(result, StatusCode::OK)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SceneRecipe {
    sources: Vec<[String; 2]>,
    anima: Value,
    anima_with_lora: Option<Value>,
    anima_lora_source: Option<[String; 2]>,
    moss: Value,
}

fn unavailable() -> ApiError {
    ApiError::new(
        503,
        "SCENE_RECIPES_UNAVAILABLE",
        "远程资料未安装，请同步桌面端",
    )
}

fn open_bundled_library(config: &crate::config::Config) -> Result<Connection> {
    let db = Connection::open_with_flags(
        config.app_root.join(RECIPE_DATABASE),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| unavailable())?;
    let version: i64 = db.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version != 3 {
        return Err(unavailable());
    }
    Ok(db)
}

fn studio_wardrobe(
    config: &crate::config::Config,
    query: &crate::catalog::Query,
) -> Result<Vec<Value>> {
    let db = open_bundled_library(config)?;
    let mut statement = db.prepare(
        "SELECT id,character,title FROM studio_wardrobe
         WHERE (?1='' OR character=?1) AND (?2='' OR instr(terms,?2)>0) ORDER BY rowid",
    )?;
    let rows = statement.query_map(
        [
            query.character.as_str(),
            &query.search.trim().to_lowercase(),
        ],
        |row| {
            Ok(
                json!({"id":row.get::<_, String>(0)?, "characterId":row.get::<_, String>(1)?,
            "title":row.get::<_, String>(2)?, "kind":"outfit", "category":"Clothing", "rating":"Unrated"}),
            )
        },
    )?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

struct RecipeLibrary {
    db: Connection,
    catalog: crate::catalog::Catalog,
    snapshots: PathBuf,
    loras: PathBuf,
}

impl RecipeLibrary {
    fn new(config: &crate::config::Config, loras: PathBuf) -> Result<Self> {
        Ok(Self {
            db: open_bundled_library(config)?,
            catalog: crate::catalog::Catalog::open_readonly(crate::catalog::Options::from_config(
                config,
            ))?,
            snapshots: config.app_root.join("data/catalog"),
            loras,
        })
    }
    fn kind(&self, requested: Option<&str>, id: &str) -> Result<String> {
        if id.is_empty() || id.len() > 180 {
            return Err(ApiError::invalid("请选择目录返回的场景或蓝图 ID"));
        }
        match requested {
            Some(kind @ ("scene" | "blueprint" | "outfit")) => Ok(kind.to_owned()),
            Some(_) => Err(ApiError::invalid("出图类型须为 scene、blueprint、outfit 或 prompt")),
            None => self.db.query_row("SELECT kind FROM recipes WHERE kind IN ('scene','blueprint','outfit') AND id=?1
                ORDER BY CASE kind WHEN 'scene' THEN 0 WHEN 'blueprint' THEN 1 ELSE 2 END LIMIT 1", [id], |row| row.get(0)).optional()?.ok_or_else(recipe_missing),
        }
    }
    fn read(&self, kind: &str, id: &str, outfit: Option<&str>) -> Result<SceneRecipe> {
        let bytes: Vec<u8> = self
            .db
            .query_row(
                "SELECT recipe FROM recipes WHERE kind=?1 AND id=?2",
                [kind, id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(recipe_missing)?;
        let mut decoded = Vec::new();
        DeflateDecoder::new(bytes.as_slice())
            .take(131073)
            .read_to_end(&mut decoded)?;
        if decoded.len() > 131072 {
            return Err(unavailable());
        }
        if let Some(outfit) = outfit {
            let alternate: Vec<u8> = self.db.query_row("SELECT recipe FROM outfit_overrides WHERE kind=?1 AND scene=?2 AND outfit=?3",
                [kind, id, outfit], |row| row.get(0)).optional()?.ok_or_else(|| ApiError::new(422, "OUTFIT_INCOMPATIBLE",
                    "这套服装不能用于该场景，请选同一角色的完整服装 ID；多人和无角色场景需要保留原配方"))?;
            let mut reader = Decompress::new(false);
            reader.set_dictionary(&decoded).map_err(|_| unavailable())?;
            let mut replacement = Vec::with_capacity(131073);
            if reader
                .decompress_vec(&alternate, &mut replacement, FlushDecompress::Finish)
                .map_err(|_| unavailable())?
                != Status::StreamEnd
                || replacement.len() > 131072
            {
                return Err(unavailable());
            }
            decoded = replacement;
        }
        Ok(serde_json::from_slice(&decoded)?)
    }
    fn prepare(&self, scene: SceneSelection, default_model: Option<&str>) -> Result<PreparedScene> {
        if scene.uses_prompt_only_fields() {
            return Err(ApiError::invalid(
                "negative、steps、cfg 和角色 LoRA 参数需要与 prompt 一起使用；目录出图可以指定 width 和 height",
            ));
        }
        let (kind, id, outfit) = match (scene.id.as_deref(), scene.outfit_id.as_deref()) {
            (Some(id), outfit) => (self.kind(scene.kind.as_deref(), id)?, id, outfit),
            (None, Some(id)) if matches!(scene.kind.as_deref(), None | Some("outfit")) => {
                ("outfit".into(), id, None)
            }
            _ => {
                return Err(ApiError::invalid(
                    "请指定目录 id、独立 outfitId 或自定义 prompt",
                ));
            }
        };
        if id.is_empty()
            || id.len() > 180
            || outfit.is_some_and(|id| id.is_empty() || id.len() > 180)
            || (kind == "outfit" && outfit.is_some())
        {
            return Err(ApiError::invalid("请选择目录返回的场景、蓝图或服装 ID"));
        }
        let model = scene.model_id.as_deref().or(default_model).unwrap_or(ANIMA);
        let family = match model {
            ANIMA => "anima",
            "moss-miaomiao-base-v1.0" | "moss-miaomiao-base-v1.1" => "moss-image",
            _ => {
                return Err(ApiError::invalid(
                    "按目录 ID 出图支持 MiaoMiao Anima 1.6 和 MOSS BASE v1.0/v1.1",
                ));
            }
        };
        let (max_seed, variants) = submission::limits(&scene, family)?;
        let mut recipe = self.read(&kind, id, outfit)?;
        let candidate = recipe.anima_with_lora.take().filter(|binding| {
            family == "anima"
                && binding["loraId"]
                    .as_str()
                    .and_then(catalog::lora)
                    .and_then(|lora| lora["file"].as_str())
                    .and_then(|file| generation::native::resources::file(&self.loras, file, false))
                    .is_some()
        });
        if candidate.is_some()
            && let Some(source) = recipe.anima_lora_source
        {
            recipe.sources.push(source);
        }
        if !self
            .catalog
            .matches_bundled_records(&self.snapshots, &recipe.sources)?
        {
            return Err(ApiError::new(
                409,
                "SCENE_RECIPE_CHANGED",
                "本机场景、角色或服装已经修改，请在画室使用当前内容出图",
            ));
        }
        let mut payload = if family == "anima" {
            candidate.unwrap_or(recipe.anima)
        } else {
            recipe.moss
        };
        payload["modelId"] = json!(model);
        if let Some((width, height)) = submission::dimensions(scene.width, scene.height)? {
            payload["width"] = json!(width);
            payload["height"] = json!(height);
            submission::validate_payload(&payload, family)?;
        }
        Ok(PreparedScene {
            kind,
            id: id.to_owned(),
            family,
            payload,
            seed: scene.seed,
            max_seed,
            variants,
        })
    }
}

struct PreparedScene {
    kind: String,
    id: String,
    family: &'static str,
    payload: Value,
    seed: Option<u64>,
    max_seed: u64,
    variants: u8,
}

fn recipe_missing() -> ApiError {
    ApiError::new(
        404,
        "SCENE_RECIPE_NOT_FOUND",
        "该记录没有打包的出图配方，请确认 kind 和完整 id",
    )
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
        batches::enqueue(&state.config, &muse, &owner, key, None, vec![input]).await
    }
    .await;
    http::response(result, StatusCode::ACCEPTED)
}
