use super::*;

pub(super) async fn recipe_detail(
    State(state): State<crate::AppState>,
    Extension(muse): Extension<Arc<Muse>>,
    Path((kind, id)): Path<(String, String)>,
) -> Response {
    if let Some(response) = muse.search_limit.check(false) {
        return response;
    }
    http::response(describe(&state, kind, id).await, StatusCode::OK)
}

pub(super) async fn describe(state: &crate::AppState, kind: String, id: String) -> Result<Value> {
    state.host.check_running()?;
    let config = state.config.clone();
    tokio::task::spawn_blocking(move || {
            if !matches!(kind.as_str(), "character" | "scene" | "blueprint" | "outfit") || id.is_empty() || id.len() > 180 {
                return Err(ApiError::invalid("请选择目录返回的场景、蓝图或服装 ID"));
            }
            if kind == "character" {
                let catalog = crate::catalog::Catalog::open_readonly(crate::catalog::Options::from_config(&config))?;
                let id = catalog.remote_character_id(&id)?;
                let record = catalog.get(&kind, &id)?;
                let profile = &record.data["profile"];
                let popular = &record.data["popular"];
                return Ok(json!({"character":{"id":id,"title":profile.get("name").unwrap_or(&popular["displayName"]),
                    "franchise":popular.get("franchise").unwrap_or(&profile["source"]),
                    "characterTokens":popular["characterTokens"],"copyrightTokens":popular["copyrightTokens"],
                    "identityTokens":popular["identityTokens"],"identityProse":popular["identityProse"],
                    "visualDna":profile["visual_dna"]}}));
            }
            let library = RecipeLibrary::new(&config, PathBuf::new())?;
            let bundled = library.db.query_row("SELECT EXISTS(SELECT 1 FROM recipes WHERE kind=?1 AND id=?2)", [&kind, &id], |row| row.get::<_,bool>(0))?;
            if kind == "outfit" {
                let mut detail = if id.starts_with("studio/") {
                    let (character,title,tags): (String,String,String) = library.db.query_row("SELECT character,title,tags FROM studio_wardrobe WHERE id=?", [&id],
                        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional()?.ok_or_else(recipe_missing)?;
                    json!({"characterId":character,"title":title,"tokens":serde_json::from_str::<Value>(&tags)?,"rating":"Unrated"})
                } else {
                    let record = library.catalog.get(&kind,&id)?;
                    let outfit = &record.data["outfit"];
                    json!({"characterId":record.data["characterId"],"title":outfit["name"],"tokens":outfit["tokens"],"prose":outfit["prose"],
                        "rating":library.catalog.remote_rating(&kind,&id)?})
                };
                detail["id"] = json!(id);
                detail["kind"] = json!(kind);
                detail["compatibleModels"] = if bundled { json!(RECIPE_MODELS) } else { json!([]) };
                return Ok(json!({"outfit":detail}));
            }
            let record = library.catalog.get(&kind, &id)?;
            let data = &record.data;
            let (seed, source) = if let Some(seed) = data["seed"].as_u64().filter(|seed| *seed <= MAX_SEED) {
                (Some(seed), Some("scene"))
            } else {
                let seed = data["audit"]["seed"].as_u64().filter(|seed| *seed <= MAX_SEED);
                (seed, seed.map(|_| "reference"))
            };
            Ok(json!({"scene":{"kind":kind,"id":id,"title":data["title"],
                "characterId":data.get("characterId").unwrap_or(&data["char"]),"outfitId":data["outfitId"],
                "size":data["recommendedSize"],"seed":seed,"seedSource":source,"variants":1,"maxVariants":MAX_VARIANTS,"hasBundledRecipe":bundled,
                "compatibleModels":if bundled { json!(RECIPE_MODELS) } else { json!([]) }}}))
        }).await.map_err(|_| unavailable())?
}
