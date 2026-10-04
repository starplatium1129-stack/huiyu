use super::*;
impl Catalog {
    pub fn check(&self) -> Result<Value> {
        let transaction = self.connection.unchecked_transaction()?;
        let integrity: String = self
            .connection
            .query_row("PRAGMA quick_check", [], |r| r.get(0))?;
        if integrity != "ok" {
            return Err(ApiError::new(503, "CATALOG_INTEGRITY", integrity));
        }
        validation::relations(&self.connection)?;
        let mut overrides = std::collections::HashMap::new();
        for name in [
            "characters.json",
            "popular-characters.json",
            "scene-blueprints.json",
            "scenes.json",
            "curation.json",
            "tags.json",
            "loras.json",
        ] {
            if let Some(value) = self.projection_owned(name)? {
                overrides.insert(format!("data/{name}"), value);
            }
        }
        let options = crate::maintenance::Options {
            root: self.options.source.clone(),
            runtime: self
                .options
                .database
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .to_owned(),
            assets_root: None,
            showcase: None,
        };
        let contracts = crate::maintenance::contracts::validate_with(&options, overrides)
            .map_err(|e| ApiError::invalid(format!("{} {}", e.message, e.extra)))?;
        let value = json!({"ok":true,"integrity":integrity,"contracts":contracts,"stats":self.stats()?,"scope":"内容结构与关联；不代表图片或设备验收"});
        transaction.commit()?;
        Ok(value)
    }
}
