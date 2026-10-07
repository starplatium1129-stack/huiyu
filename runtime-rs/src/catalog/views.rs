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
        let mut character = self.get("character", id)?;
        let mut popular = character
            .data
            .get_mut("popular")
            .map(Value::take)
            .unwrap_or_default();
        let mut statement = self.connection.prepare(&format!("SELECT {COLUMNS} FROM content_records WHERE kind='outfit' AND character_id=?1 AND deleted=0 ORDER BY sort_order,id"))?;
        let outfits = statement
            .query_map([id], row)?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .filter(|r| r.data["characterId"] == id)
            .map(|mut r| {
                r.data
                    .get_mut("outfit")
                    .map(Value::take)
                    .unwrap_or_default()
            })
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
        // Move owned JSON bodies into the envelope instead of cloning them through json!.
        let mut value = json!({"ok":true,"version":self.version()?,"profile":null,"character":null,"blueprints":null});
        value["profile"] = character
            .data
            .get_mut("profile")
            .map(Value::take)
            .unwrap_or_default();
        value["character"] = popular;
        value["blueprints"] = Value::Array(blueprints);
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
                    .filter_map(|mut r| r.data.get_mut("profile").map(Value::take))
                    .collect::<Vec<_>>()
                    .into(),
            ));
        }
        if name == "popular-characters.json" {
            let mut outfits = std::collections::HashMap::<String, Vec<Value>>::new();
            for mut r in self.records("outfit")? {
                outfits
                    .entry(r.data["characterId"].as_str().unwrap().into())
                    .or_default()
                    .push(
                        r.data
                            .get_mut("outfit")
                            .map(Value::take)
                            .unwrap_or_default(),
                    );
            }
            let characters = self
                .records("character")?
                .into_iter()
                .filter_map(|mut r| {
                    let mut value = r.data.get_mut("popular")?.take();
                    value["outfits"] = outfits.remove(&r.id).unwrap_or_default().into();
                    Some(value)
                })
                .collect::<Vec<_>>();
            let mut value = json!({"version":1,"characters":null});
            value["characters"] = Value::Array(characters);
            return Ok(Some(value));
        }
        if name == "scene-blueprints.json" {
            let mut value = json!({"version":2,"blueprints":null});
            value["blueprints"] = self
                .records("blueprint")?
                .into_iter()
                .map(|r| r.data)
                .collect::<Vec<_>>()
                .into();
            return Ok(Some(value));
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
            let core = self.document("curation")?["personaCoreSceneIds"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            if name == "scenes-index.json" {
                // Lite directory loads need metadata, never prompt/story bodies.
                let mut statement = self.connection.prepare(
                    "SELECT id,character_id,sort_order,created_at,updated_at FROM content_records
                     WHERE kind='scene' AND deleted=0 ORDER BY sort_order,id",
                )?;
                let mut rows = statement.query([])?;
                let mut ids = Vec::new();
                let mut metadata = serde_json::Map::new();
                let mut counts = [0; 3];
                while let Some(row) = rows.next()? {
                    let id: String = row.get(0)?;
                    let character: String = row.get(1)?;
                    if let Some(index) = ["nene", "natsume", "triad"]
                        .iter()
                        .position(|c| *c == character)
                    {
                        counts[index] += 1;
                    }
                    metadata.insert(id.clone(), json!({"sortOrder":row.get::<_,i64>(2)?,"createdAt":row.get::<_,Option<String>>(3)?,"updatedAt":row.get::<_,Option<String>>(4)?}));
                    ids.push(id);
                }
                let mut shards = serde_json::Map::new();
                for (key, count) in ["nene", "natsume", "shared"].into_iter().zip(counts) {
                    shards.insert(
                        key.into(),
                        json!({"file":format!("scenes-{key}.json"),"count":count}),
                    );
                }
                return Ok(Some(
                    json!({"version":2,"total":ids.len(),"shards":shards,"tiers":{"core":core},"orderedIds":ids,"metadata":metadata}),
                ));
            }
            let character = match name {
                "scenes-nene.json" => Some("nene"),
                "scenes-natsume.json" => Some("natsume"),
                "scenes-shared.json" => Some("triad"),
                _ => None,
            };
            // Indexed shard predicates run before payload decoding. All supported writes
            // derive character_id from the scene's char field in write::put.
            let scenes = if let Some(character) = character {
                let mut statement = self.connection.prepare(&format!(
                    "SELECT {COLUMNS} FROM content_records WHERE kind='scene'
                     AND deleted=0 AND character_id=?1 ORDER BY sort_order,id"
                ))?;
                statement
                    .query_map([character], row)?
                    .collect::<rusqlite::Result<Vec<_>>>()?
            } else if name == "scenes-core.json" {
                let mut statement = self.connection.prepare(&format!(
                    "SELECT {COLUMNS} FROM content_records WHERE kind='scene' AND deleted=0
                     AND id IN (SELECT value FROM json_each(?1) WHERE type='text')
                     ORDER BY sort_order,id"
                ))?;
                // Materialize membership once; duplicates still select one row, only strings match.
                statement
                    .query_map([serde_json::to_string(&core)?], row)?
                    .collect::<rusqlite::Result<Vec<_>>>()?
            } else {
                self.records("scene")?
            };
            let values = scenes
                .into_iter()
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
pub(super) fn projected_file(name: &str) -> bool {
    [
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
}
