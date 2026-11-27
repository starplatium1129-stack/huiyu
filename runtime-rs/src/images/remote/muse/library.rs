use super::*;
use flate2::{Decompress, FlushDecompress, Status, read::DeflateDecoder};
use rusqlite::OpenFlags;
use std::io::Read;

const RECIPE_DATABASE: &str = "remote-scene-recipes.sqlite";

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SceneRecipe {
    sources: Vec<[String; 2]>,
    anima: Value,
    anima_with_lora: Option<Value>,
    anima_lora_source: Option<[String; 2]>,
    moss: Value,
    #[serde(default)]
    krea2: Option<Value>,
}

pub(super) fn unavailable() -> ApiError {
    ApiError::new(
        503,
        "SCENE_RECIPES_UNAVAILABLE",
        "远程资料未安装，请同步桌面端",
    )
}

pub(super) fn open_bundled_library(config: &crate::config::Config) -> Result<Connection> {
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

pub(super) fn studio_wardrobe(
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

pub(super) struct RecipeLibrary {
    pub(super) db: Connection,
    pub(super) catalog: crate::catalog::Catalog,
    snapshots: PathBuf,
    loras: PathBuf,
}

impl RecipeLibrary {
    pub(super) fn new(config: &crate::config::Config, loras: PathBuf) -> Result<Self> {
        Ok(Self {
            db: open_bundled_library(config)?,
            catalog: crate::catalog::Catalog::open_readonly(crate::catalog::Options::from_config(
                config,
            ))?,
            snapshots: config.app_root.join("data/catalog"),
            loras,
        })
    }

    pub(super) fn guest_default_outfit(&self, character: &str) -> Result<String> {
        if let Some(id) = self.catalog.default_outfit_id(character)? {
            return Ok(id);
        }
        self.db
            .query_row(
                "SELECT id FROM studio_wardrobe WHERE character=?1 ORDER BY rowid LIMIT 1",
                [character],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| {
                ApiError::new(
                    404,
                    "GUEST_CHARACTER_RECIPE_MISSING",
                    "该角色暂未同步出图配方，请选择她的场景蓝图",
                )
            })
    }

    fn kind(&self, requested: Option<&str>, id: &str) -> Result<String> {
        if id.is_empty() || id.len() > 180 {
            return Err(ApiError::invalid("请选择目录返回的场景或蓝图 ID"));
        }
        match requested {
            Some(kind @ ("scene" | "blueprint" | "outfit")) => Ok(kind.to_owned()),
            Some(_) => Err(ApiError::invalid("出图类型须为 scene、blueprint、outfit 或 prompt")),
            None => self
                .db
                .query_row(
                    "SELECT kind FROM recipes WHERE kind IN ('scene','blueprint','outfit') AND id=?1
                ORDER BY CASE kind WHEN 'scene' THEN 0 WHEN 'blueprint' THEN 1 ELSE 2 END LIMIT 1",
                    [id],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or_else(recipe_missing),
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

    pub(super) fn prepare(
        &self,
        scene: SceneSelection,
        default_model: Option<&str>,
    ) -> Result<PreparedScene> {
        if scene.uses_prompt_only_fields() {
            return Err(ApiError::invalid(
                "negative、steps、cfg、角色 LoRA、layout、referenceImages 和漫画处理参数需要与自定义 prompt/manga 一起使用；目录出图支持 width/height、Anima 底图/蒙版和 Krea 2 styleLoraId",
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
            id if generation::native::adapters::model(id).is_some_and(|m| m["family"] == "krea2") => "krea2",
            _ => {
                return Err(ApiError::invalid(
                    "按目录 ID 出图支持 MiaoMiao Anima 1.6、MOSS BASE v1.0/v1.1 与已登记的原生 Krea 2",
                ));
            }
        };
        if scene.has_edit_fields() && family != "anima" {
            return Err(ApiError::invalid(
                "目录出图的参考底图、蒙版和构图控制仅适用于 Anima",
            ));
        }
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
        let mut payload = match family {
            "anima" => candidate.unwrap_or(recipe.anima),
            "krea2" => match recipe.krea2.take() {
                Some(krea_payload) => krea_payload,
                None => krea::build_catalog_payload(self, &kind, id, outfit, model, &recipe.anima)?,
            },
            _ => recipe.moss,
        };
        let fields = payload.as_object_mut().ok_or_else(unavailable)?;
        fields.insert("modelId".into(), json!(model));
        if family == "krea2" && let Some(spec) = generation::native::adapters::model(model) {
            fields.insert("steps".into(), spec["steps"].clone());
            fields.insert("cfg".into(), spec["cfg"].clone());
        }
        scene.apply_styles(&mut payload, family)?;
        scene.apply_tea_cache_options(&mut payload, family)?;
        scene.apply_moss_options(&mut payload, family)?;
        scene.apply_edit_options(&mut payload, family)?;
        submission::apply_upscale(&mut payload, family, scene.upscale)?;
        let size = submission::dimensions(scene.width, scene.height)?;
        if let Some((width, height)) = size {
            if family == "moss-image" {
                layout::resize_catalog_prompt(&mut payload, width, height)?;
            }
            payload["width"] = json!(width);
            payload["height"] = json!(height);
        }
        if family == "moss-image"
            || family == "krea2"
            || size.is_some()
            || scene.upscale.is_some()
            || scene.tea_cache.is_some()
            || scene.tea_cache_thresh.is_some()
            || scene.has_styles()
            || scene.has_edit_fields()
        {
            submission::prepare_payload(&mut payload, family)?;
        }
        Ok(PreparedScene {
            cast_fusion: None,
            kind,
            id: id.to_owned(),
            family,
            model_id: model.to_owned(),
            payload,
            seed: scene.seed,
            max_seed,
            variants,
        })
    }
}

pub(super) struct PreparedScene {
    pub(super) cast_fusion: Option<crate::interrogate::fuse::FuseCastInput>,
    pub(super) kind: String,
    pub(super) id: String,
    pub(super) family: &'static str,
    pub(super) model_id: String,
    pub(super) payload: Value,
    pub(super) seed: Option<u64>,
    pub(super) max_seed: u64,
    pub(super) variants: u8,
}

pub(super) fn recipe_missing() -> ApiError {
    ApiError::new(
        404,
        "SCENE_RECIPE_NOT_FOUND",
        "该记录没有打包的出图配方，请确认 kind 和完整 id",
    )
}
