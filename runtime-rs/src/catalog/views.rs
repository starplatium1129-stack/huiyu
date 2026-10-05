use super::*;
impl Catalog {
    pub fn next_scene_id(&self) -> Result<String> {
        let highest: i64=self.connection.query_row("SELECT COALESCE(MAX(CAST(substr(id,3) AS INTEGER)),0) FROM content_records WHERE kind='scene'",[],|r|r.get(0))?;
        let retired = self.document("retired-scenes")?;
        let retired_max = retired["records"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| {
                v["id"]
                    .as_str()
                    .and_then(crate::maintenance::state::scene_number)
            })
            .max()
            .unwrap_or(0);
        let highest = (highest as u64).max(retired_max);
        if highest >= 9_007_199_254_740_991 {
            return Err(ApiError::invalid("场景编号已用尽"));
        }
        Ok(format!("sc{:03}", highest + 1))
    }
    pub fn character_bundle(&self, id: &str) -> Result<Value> {
        let transaction = self.connection.unchecked_transaction()?;
        let character = self.get("character", id)?;
        let mut popular = character.data["popular"].clone();
        let mut statement = self.connection.prepare(&format!("SELECT {COLUMNS} FROM content_records WHERE kind='outfit' AND character_id=?1 AND deleted=0 ORDER BY sort_order,id"))?;
        let outfits = statement
            .query_map([id], row)?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .filter(|r| r.data["characterId"] == id)
            .map(|r| r.data["outfit"].clone())
            .collect::<Vec<_>>();
        if popular.is_object() {
            popular["outfits"] = outfits.into();
        }
        let mut statement = self.connection.prepare(&format!("SELECT {COLUMNS} FROM content_records WHERE kind='blueprint' AND character_id=?1 AND deleted=0 ORDER BY sort_order,id"))?;
        let blueprints = statement
            .query_map([id], row)?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .map(|r| r.data)
            .collect::<Vec<_>>();
        let value = json!({"ok":true,"version":self.version()?,"profile":character.data["profile"],"character":popular,"blueprints":blueprints});
        transaction.commit()?;
        Ok(value)
    }
    pub fn projection(&self, name: &str) -> Result<Option<Value>> {
        let transaction = self.connection.unchecked_transaction()?;
        let value = self.projection_owned(name)?;
        transaction.commit()?;
        Ok(value)
    }
    pub(super) fn projection_owned(&self, name: &str) -> Result<Option<Value>> {
        if name == "tags-dictionary.json" {
            let tags = self.document("tags")?;
            let policy = self.document("tag-dictionary-policy")?;
            return Ok(Some(
                crate::bootstrap::tags::dictionary(
                    tags.as_array()
                        .ok_or_else(|| ApiError::invalid("标签库无效"))?,
                    &policy,
                )
                .map_err(|e| ApiError::invalid(e.message))?,
            ));
        }
        if name == "characters.json" {
            return Ok(Some(
                self.records("character")?
                    .into_iter()
                    .filter_map(|r| r.data.get("profile").cloned())
                    .collect::<Vec<_>>()
                    .into(),
            ));
        }
        if name == "popular-characters.json" {
            let mut outfits = std::collections::HashMap::<String, Vec<Value>>::new();
            for r in self.records("outfit")? {
                outfits
                    .entry(r.data["characterId"].as_str().unwrap().into())
                    .or_default()
                    .push(r.data["outfit"].clone());
            }
            let characters = self
                .records("character")?
                .into_iter()
                .filter_map(|r| {
                    let mut value = r.data.get("popular")?.clone();
                    value["outfits"] = outfits.remove(&r.id).unwrap_or_default().into();
                    Some(value)
                })
                .collect::<Vec<_>>();
            return Ok(Some(json!({"version":1,"characters":characters})));
        }
        if name == "scene-blueprints.json" {
            return Ok(Some(
                json!({"version":2,"blueprints":self.records("blueprint")?.into_iter().map(|r|r.data).collect::<Vec<_>>()}),
            ));
        }
        if [
            "curation.json",
            "tags.json",
            "loras.json",
            "prompt-pinned-scenes.json",
            "retired-scenes.json",
        ]
        .contains(&name)
        {
            return Ok(Some(self.document(name.trim_end_matches(".json"))?));
        }
        if [
            "scenes.json",
            "scenes-nene.json",
            "scenes-natsume.json",
            "scenes-shared.json",
            "scenes-core.json",
            "scenes-index.json",
        ]
        .contains(&name)
        {
            let scenes = self.records("scene")?;
            let core = self.document("curation")?["personaCoreSceneIds"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            if name == "scenes-index.json" {
                let mut shards = serde_json::Map::new();
                for (character, key) in [
                    ("nene", "nene"),
                    ("natsume", "natsume"),
                    ("triad", "shared"),
                ] {
                    shards.insert(key.into(),json!({"file":format!("scenes-{key}.json"),"count":scenes.iter().filter(|r|r.data["char"]==character).count()}));
                }
                return Ok(Some(
                    json!({"version":2,"total":scenes.len(),"shards":shards,"tiers":{"core":core},"orderedIds":scenes.iter().map(|r|&r.id).collect::<Vec<_>>(),"metadata":scenes.iter().map(|r|(r.id.clone(),json!({"sortOrder":r.sort_order,"createdAt":r.created_at,"updatedAt":r.updated_at}))).collect::<serde_json::Map<_,_>>()}),
                ));
            }
            let character = match name {
                "scenes-nene.json" => Some("nene"),
                "scenes-natsume.json" => Some("natsume"),
                "scenes-shared.json" => Some("triad"),
                _ => None,
            };
            let values = scenes
                .into_iter()
                .filter(|r| {
                    character.is_none_or(|c| r.data["char"] == c)
                        && (name != "scenes-core.json" || core.contains(&json!(r.id)))
                })
                .map(|r| {
                    let mut data = r.data;
                    data["sortOrder"] = r.sort_order.into();
                    data["createdAt"] = json!(r.created_at);
                    data["updatedAt"] = json!(r.updated_at);
                    data
                })
                .collect::<Vec<_>>();
            return Ok(Some(values.into()));
        }
        Ok(None)
    }
    pub fn scene_state(&self) -> Result<Value> {
        let mut occupied = self
            .connection
            .prepare("SELECT id FROM content_records WHERE kind='scene'")?;
        let highest = occupied
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .iter()
            .filter_map(|id| crate::maintenance::state::scene_number(id))
            .chain(
                self.document("retired-scenes")?["records"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|v| {
                        v["id"]
                            .as_str()
                            .and_then(crate::maintenance::state::scene_number)
                    }),
            )
            .max()
            .unwrap_or(0);
        let scenes = self
            .records("scene")?
            .into_iter()
            .map(|r| r.data)
            .collect::<Vec<_>>();
        let blueprints = self
            .records("blueprint")?
            .into_iter()
            .map(|r| r.data)
            .collect::<Vec<_>>();
        Ok(
            json!({"ok":true,"writesEnabled":true,"version":self.version()?,"snapshot":{"scenes":scenes,"blueprints":blueprints,"tags":self.document("tags")?,"curation":self.document("curation")?},"nextSceneId":format!("sc{:03}",highest+1),"sceneCount":scenes.len()}),
        )
    }
}
pub fn projection(config: &crate::config::Config, name: &str) -> Result<Option<Value>> {
    if ![
        "characters.json",
        "popular-characters.json",
        "scene-blueprints.json",
        "curation.json",
        "tags.json",
        "tags-dictionary.json",
        "loras.json",
        "scenes.json",
        "scenes-nene.json",
        "scenes-natsume.json",
        "scenes-shared.json",
        "scenes-core.json",
        "scenes-index.json",
    ]
    .contains(&name)
    {
        return Ok(None);
    }
    Catalog::open(Options::from_config(config))?.projection(name)
}
