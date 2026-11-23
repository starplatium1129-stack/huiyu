use super::*;
fn scene_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let mut data = json_column(row, 0)?;
    data["sortOrder"] = row.get::<_, i64>(1)?.into();
    data["createdAt"] = row
        .get::<_, Option<String>>(2)?
        .map(Value::String)
        .unwrap_or_default();
    data["updatedAt"] = row
        .get::<_, Option<String>>(3)?
        .map(Value::String)
        .unwrap_or_default();
    Ok(data)
}
impl Catalog {
    pub(crate) fn chat_cards(&self, id: Option<&str>) -> Result<Vec<Value>> {
        let mut query = self.connection.prepare(
            "SELECT json_object(
                 'id', card.value->>'$.id', 'catalogId', c.id,
                 'name', card.value->>'$.document.data.name',
                 'description', substr(card.value->>'$.document.data.description',1,160),
                 'greeting', card.value->>'$.document.data.first_mes', 'avatarUrl', '')
             FROM content_records d CROSS JOIN json_each(d.payload) card
             CROSS JOIN content_records c
             WHERE d.kind='document' AND d.id='chat-cards' AND d.deleted=0
                 AND (?1 IS NULL OR card.value->>'$.id'=?1)
                 AND c.kind='character' AND c.id=card.key AND c.deleted=0
             ORDER BY c.sort_order,c.id",
        )?;
        Ok(query
            .query_map([id], |row| json_column(row, 0))?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub(crate) fn chat_card_document(&self, card_id: &str) -> Result<Option<String>> {
        Ok(self
            .connection
            .query_row(
                "SELECT card.value->'$.document' FROM content_records d, json_each(d.payload) card
                 JOIN content_records c ON c.kind='character' AND c.id=card.key AND c.deleted=0
                 WHERE d.kind='document' AND d.id='chat-cards' AND d.deleted=0 AND card.value->>'$.id'=?1",
                [card_id],
                |row| row.get(0),
            )
            .optional()?)
    }

    fn blueprint_rows(&self, id: &str) -> Result<Vec<Value>> {
        let mut statement = self.connection.prepare("SELECT payload FROM content_records WHERE kind='blueprint' AND character_id=?1 AND deleted=0 ORDER BY sort_order,id")?;
        Ok(statement
            .query_map([id], |row| json_column(row, 0))?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }
    pub fn character_blueprints(&self, id: &str) -> Result<Value> {
        validation::key("character", id)?;
        let transaction = self.connection.unchecked_transaction()?;
        let version = self.version()?;
        let blueprints = self.blueprint_rows(id)?;
        transaction.commit()?;
        let mut value = json!({"ok":true,"version":version,"blueprints":null});
        value["blueprints"] = Value::Array(blueprints);
        Ok(value)
    }
    pub(crate) fn character_profile_exists(&self, id: &str) -> Result<bool> {
        // Match the profile identity exposed by characters.json.
        Ok(self
            .connection
            .prepare_cached(
                "SELECT 1 FROM content_records WHERE kind='character' AND deleted=0
             AND json_type(payload,'$.profile.id')='text'
             AND json_extract(payload,'$.profile.id')=?1 LIMIT 1",
            )?
            .exists([id])?)
    }
    pub(crate) fn portrait_image(&self, id: &str) -> Result<Option<String>> {
        Ok(self.connection.query_row(
            "SELECT payload->>'$.profile.portrait.image' FROM content_records
             WHERE kind='character' AND id=?1 AND deleted=0 AND json_type(payload,'$.profile.portrait.image')='text'",
            [id], |row| row.get(0),
        ).optional()?)
    }
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
    pub(crate) fn default_outfit_id(&self, character: &str) -> Result<Option<String>> {
        Ok(self.connection.query_row(
            "SELECT id FROM content_records WHERE kind='outfit' AND deleted=0 AND character_id=?1
             AND json_extract(payload,'$.outfit.default')=1 ORDER BY sort_order,id LIMIT 1",
            [character], |row| row.get(0),
        ).optional()?)
    }

    pub fn character_bundle(&self, id: &str) -> Result<Value> {
        let transaction = self.connection.unchecked_transaction()?;
        let mut character = self.get("character", id)?;
        let mut popular = character
            .data
            .get_mut("popular")
            .map(Value::take)
            .unwrap_or_default();
        let mut statement = self.connection.prepare("SELECT payload FROM content_records WHERE kind='outfit' AND character_id=?1 AND deleted=0 ORDER BY sort_order,id")?;
        let outfits = statement
            .query_map([id], |row| {
                let mut data = json_column(row, 0)?;
                Ok((data["characterId"] == id)
                    .then(|| data.get_mut("outfit").map(Value::take).unwrap_or_default()))
            })?
            .filter_map(|item| item.transpose())
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if popular.is_object() {
            popular["outfits"] = outfits.into();
        }
        let blueprints = self.blueprint_rows(id)?;
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
        if ["character-chat.json", "character-chat-directory.json", "character-drawing.json"].contains(&name) {
            let sql = if name == "character-chat-directory.json" {
                "SELECT json_object('id', payload->>'$.profile.id',
                    'portrait', json_object('image', payload->>'$.profile.portrait.image'),
                    'source', payload->>'$.profile.source', 'alias', payload->'$.profile.alias',
                    'franchise', payload->>'$.popular.franchise', 'aliases', payload->'$.popular.aliases',
                    'originalName', payload->>'$.popular.originalName')
                 FROM content_records WHERE kind='character' AND deleted=0
                    AND json_type(payload,'$.profile.id')='text' ORDER BY sort_order,id"
            } else if name == "character-chat.json" {
                "SELECT json_object(
                    'id', payload->>'$.profile.id', 'name', payload->>'$.profile.name',
                    'bg_story', payload->>'$.profile.bg_story', 'personality', payload->'$.profile.personality',
                    'likes', payload->'$.profile.likes', 'speech', payload->>'$.profile.speech',
                    'identity', payload->'$.profile.identity', 'portrait', payload->'$.profile.portrait',
                    'source', payload->>'$.profile.source', 'alias', payload->'$.profile.alias',
                    'franchise', payload->>'$.popular.franchise', 'aliases', payload->'$.popular.aliases',
                    'originalName', payload->>'$.popular.originalName')
                 FROM content_records WHERE kind='character' AND deleted=0
                    AND json_type(payload,'$.profile.id')='text' ORDER BY sort_order,id"
            } else {
                "SELECT CASE WHEN payload->>'$.profile.type' = 'popular'
                    THEN json_object('id', payload->>'$.profile.id', 'accent_color', payload->>'$.profile.accent_color')
                    ELSE payload->'$.profile' END
                 FROM content_records WHERE kind='character' AND deleted=0
                    AND json_type(payload,'$.profile.id')='text' ORDER BY sort_order,id"
            };
            let mut query = self.connection.prepare(sql)?;
            let profiles = query.query_map([], |row| json_column(row, 0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            return Ok(Some(Value::Array(profiles)));
        }
        if name == "character-archive.json" {
            // The bookshelf and biography never read the relationship atlas.
            let mut query = self.connection.prepare(
                "SELECT json_remove(payload->'$.profile', '$.relationshipGraph')
                 FROM content_records WHERE kind='character' AND deleted=0 AND json_type(payload,'$.profile')='object'
                 ORDER BY sort_order,id",
            )?;
            let profiles = query
                .query_map([], |row| json_column(row, 0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            return Ok(Some(Value::Array(profiles)));
        }
        if name == "popular-directory.json" {
            let mut statement = self.connection.prepare(
                "SELECT json_object(
                    'id', payload->>'$.popular.id', 'displayName', payload->>'$.popular.displayName',
                    'originalName', payload->>'$.popular.originalName', 'franchise', payload->>'$.popular.franchise',
                    'aliases', payload->'$.popular.aliases', 'characterTokens', payload->'$.popular.characterTokens',
                    'portraitPending', json(CASE WHEN payload->>'$.profile.portrait.image'='../assets/characters/portrait-pending.svg'
                        THEN 'true' ELSE 'false' END))
                 FROM content_records WHERE kind='character' AND deleted=0 AND json_type(payload,'$.popular')='object'
                 ORDER BY sort_order,id",
            )?;
            let rows = statement
                .query_map([], |row| json_column(row, 0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            return Ok(Some(Value::Array(rows)));
        }
        if name == "scene-titles.json" {
            let mut statement = self.connection.prepare(
                "SELECT id,title FROM content_records WHERE kind='scene' AND deleted=0 ORDER BY sort_order,id",
            )?;
            let rows = statement
                .query_map([], |row| {
                    Ok(json!({"id": text_column(row, 0)?, "title": text_column(row, 1)?}))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            return Ok(Some(Value::Array(rows)));
        }
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
            let mut statement = self.connection.prepare(
                "SELECT payload FROM content_records WHERE kind='character' AND deleted=0 ORDER BY sort_order,id",
            )?;
            let profiles = statement
                .query_map([], |row| {
                    Ok(json_column(row, 0)?.get_mut("profile").map(Value::take))
                })?
                .filter_map(|item| item.transpose())
                .collect::<rusqlite::Result<Vec<_>>>()?;
            return Ok(Some(Value::Array(profiles)));
        }
        if name == "popular-characters.json" {
            let mut outfits = std::collections::HashMap::<String, Vec<Value>>::new();
            let mut statement = self.connection.prepare(
                "SELECT payload FROM content_records WHERE kind='outfit' AND deleted=0 ORDER BY sort_order,id",
            )?;
            let mut rows = statement.query([])?;
            while let Some(row) = rows.next()? {
                let mut data = json_column(row, 0)?;
                outfits
                    .entry(data["characterId"].as_str().unwrap().into())
                    .or_default()
                    .push(data.get_mut("outfit").map(Value::take).unwrap_or_default());
            }
            let mut statement = self.connection.prepare(
                "SELECT id,payload FROM content_records WHERE kind='character' AND deleted=0 ORDER BY sort_order,id",
            )?;
            let characters = statement
                .query_map([], |row| {
                    let id: String = row.get(0)?;
                    let mut data = json_column(row, 1)?;
                    let portrait_pending = data
                        .pointer("/profile/portrait/image")
                        .and_then(Value::as_str)
                        == Some("../assets/characters/portrait-pending.svg");
                    Ok(data.get_mut("popular").map(|popular| {
                        let mut value = popular.take();
                        value["portraitPending"] = portrait_pending.into();
                        value["outfits"] = outfits.remove(&id).unwrap_or_default().into();
                        value
                    }))
                })?
                .filter_map(|item| item.transpose())
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut value = json!({"version":1,"characters":null});
            value["characters"] = Value::Array(characters);
            return Ok(Some(value));
        }
        if name == "scene-blueprints.json" {
            let mut statement = self.connection.prepare(
                "SELECT payload FROM content_records WHERE kind='blueprint' AND deleted=0 ORDER BY sort_order,id",
            )?;
            let blueprints = statement
                .query_map([], |row| json_column(row, 0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut value = json!({"version":2,"blueprints":null});
            value["blueprints"] = Value::Array(blueprints);
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
            let core = match self
                .document("curation")?
                .get_mut("personaCoreSceneIds")
                .map(Value::take)
            {
                Some(Value::Array(values)) => values,
                _ => Vec::new(),
            };
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
                    let character = text_column(row, 1)?;
                    if let Some(index) = ["nene", "natsume", "triad"]
                        .iter()
                        .position(|c| *c == character)
                    {
                        counts[index] += 1;
                    }
                    metadata.insert(id.clone(), json!({"sortOrder":row.get::<_,i64>(2)?,"createdAt":optional_text_column(row,3)?,"updatedAt":optional_text_column(row,4)?}));
                    ids.push(id);
                }
                let mut shards = serde_json::Map::new();
                for (key, count) in ["nene", "natsume", "shared"].into_iter().zip(counts) {
                    shards.insert(
                        key.into(),
                        json!({"file":format!("scenes-{key}.json"),"count":count}),
                    );
                }
                let mut value = json!({"version":2,"total":ids.len(),"shards":null,"tiers":{"core":null},"orderedIds":null,"metadata":null});
                value["shards"] = Value::Object(shards);
                value["tiers"]["core"] = Value::Array(core);
                value["orderedIds"] = Value::Array(ids.into_iter().map(Value::String).collect());
                value["metadata"] = Value::Object(metadata);
                return Ok(Some(value));
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
                let mut statement = self.connection.prepare(
                    "SELECT payload,sort_order,created_at,updated_at FROM content_records WHERE kind='scene'
                     AND deleted=0 AND character_id=?1 ORDER BY sort_order,id"
                )?;
                statement
                    .query_map([character], scene_row)?
                    .collect::<rusqlite::Result<Vec<_>>>()?
            } else if name == "scenes-core.json" {
                let mut statement = self.connection.prepare(
                    "SELECT payload,sort_order,created_at,updated_at FROM content_records WHERE kind='scene' AND deleted=0
                     AND id IN (SELECT value FROM json_each(?1) WHERE type='text')
                     ORDER BY sort_order,id"
                )?;
                // Materialize membership once; duplicates still select one row, only strings match.
                statement
                    .query_map([serde_json::to_string(&core)?], scene_row)?
                    .collect::<rusqlite::Result<Vec<_>>>()?
            } else {
                let mut statement = self.connection.prepare(
                    "SELECT payload,sort_order,created_at,updated_at FROM content_records WHERE kind='scene'
                     AND deleted=0 ORDER BY sort_order,id",
                )?;
                statement
                    .query_map([], scene_row)?
                    .collect::<rusqlite::Result<Vec<_>>>()?
            };
            return Ok(Some(Value::Array(scenes)));
        }
        Ok(None)
    }
}
pub(super) fn projected_file(name: &str) -> bool {
    [
        "popular-directory.json",
        "character-archive.json",
        "character-chat.json",
        "character-chat-directory.json",
        "character-drawing.json",
        "scene-titles.json",
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
