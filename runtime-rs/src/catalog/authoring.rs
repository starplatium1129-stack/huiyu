use super::*;

impl Catalog {
    pub fn scene_authoring_context(&self, id: Option<&str>) -> Result<Value> {
        let target = match id {
            Some(id) => id.to_owned(),
            None => self.next_scene_id()?,
        };
        validation::key("scene", &target)?;
        let record = id.map(|_| self.get("scene", &target)).transpose()?;
        let pin_file = self.options.source.join("data/prompt-pinned-scenes.json");
        let pins: Value = if pin_file.is_file() {
            serde_json::from_slice(&std::fs::read(pin_file)?)?
        } else {
            self.document("prompt-pinned-scenes")?
        };
        if !pins["scenes"].is_object() {
            return Err(ApiError::invalid("定稿保护基线无效"));
        }
        let protected = pins["scenes"].get(&target).is_some();
        let revision = record.as_ref().map_or(0, |record| record.revision);
        Ok(json!({
            "ok":true,"mode":if record.is_some(){"existing"}else{"new"},
            "target":{"kind":"scene","id":target,"expectedRevision":revision},
            "record":record.map(Record::into_value).transpose()?,
            "pinned":protected,"protectedFields":if protected {json!(validation::PINNED_FIELDS)}else{json!([])},
            "version":self.version()?,
        }))
    }

    pub fn authoring_context(&self, target: &str, example: Option<&str>) -> Result<Value> {
        validation::key("character", target)?;
        let reference = example.unwrap_or(target);
        validation::key("character", reference)?;
        if let Some(example) = example {
            let mut bytes = target.bytes();
            if !bytes.next().is_some_and(|b| b.is_ascii_lowercase())
                || !bytes
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
            {
                return Err(ApiError::invalid(
                    "新角色编号需要小写英文字母开头，并只使用小写字母、数字、下划线或短横线",
                ));
            }
            if example == target
                || self
                    .connection
                    .prepare_cached(
                        "SELECT 1 FROM content_records WHERE kind='character' AND id=?1 LIMIT 1",
                    )?
                    .exists([target])?
            {
                return Err(ApiError::invalid(
                    "新角色编号已存在；已有角色请省略 --example",
                ));
            }
        }
        let transaction = self.connection.unchecked_transaction()?;
        let character = self.get("character", reference)?;
        if example.is_some() && !character.data["popular"].is_object() {
            return Err(ApiError::invalid("参考角色缺少绘图身份"));
        }
        let mut outfit_query = self.connection.prepare(
            "SELECT id FROM content_records WHERE kind='outfit' AND character_id=?1 AND deleted=0 ORDER BY sort_order,id",
        )?;
        let outfit_ids = outfit_query
            .query_map([reference], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let outfits = outfit_ids
            .into_iter()
            .map(|id| Ok(self.get("outfit", &id)?.into_value()?))
            .collect::<Result<Vec<_>>>()?;
        let total: i64 = self.connection.query_row(
            "SELECT count(*) FROM content_records WHERE kind='blueprint' AND character_id=?1 AND deleted=0",
            [reference], |row| row.get(0),
        )?;
        let mut blueprint_query = self.connection.prepare(
            "SELECT id,revision,title,category,rating,COALESCE(json_extract(payload,'$.outfitId'),'')
             FROM content_records WHERE kind='blueprint' AND character_id=?1 AND deleted=0
             ORDER BY sort_order,id LIMIT 100",
        )?;
        let blueprints = blueprint_query
            .query_map([reference], |row| {
                Ok(json!({
                    "id":row.get::<_, String>(0)?,"revision":row.get::<_, i64>(1)?,
                    "title":row.get::<_, String>(2)?,"category":row.get::<_, String>(3)?,
                    "rating":row.get::<_, String>(4)?,"outfitId":row.get::<_, String>(5)?,
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let version = self.version()?;
        let revision = character.revision;
        transaction.commit()?;
        Ok(json!({
            "ok":true,"mode":if example.is_some(){"new"}else{"existing"},
            "target":{"kind":"character","id":target,"expectedRevision":if example.is_some(){0}else{revision}},
            "referenceCharacter":character.into_value()?,"outfits":outfits,
            "blueprints":{"total":total,"truncated":total>100,"items":blueprints},
            "version":version,
        }))
    }
}
