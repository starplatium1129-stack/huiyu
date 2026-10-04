use super::*;
use std::collections::HashSet;
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Change {
    pub kind: String,
    pub id: String,
    pub expected_revision: i64,
    pub data: Option<Value>,
    pub patch: Option<Value>,
    pub sort_order: Option<i64>,
    pub created_at: Option<String>,
    #[serde(default)]
    pub remove: bool,
}
pub(super) fn merge(value: &mut Value, patch: &Value) -> Result<()> {
    let fields = patch
        .as_object()
        .ok_or_else(|| ApiError::invalid("字段补丁必须是对象"))?;
    let target = value
        .as_object_mut()
        .ok_or_else(|| ApiError::invalid("此记录需要完整替换，不能使用字段补丁"))?;
    for (key, next) in fields {
        if next.is_object() && target.get(key).is_some_and(Value::is_object) {
            merge(target.get_mut(key).unwrap(), next)?;
        } else {
            target.insert(key.clone(), next.clone());
        }
    }
    Ok(())
}
fn fields(record: &Record) -> (String, String, String, String, String) {
    let value = &record.data;
    let text = |v: &Value| v.as_str().unwrap_or("").to_owned();
    let title = match record.kind.as_str() {
        "character" => text(&value["popular"]["displayName"]),
        "outfit" => text(&value["outfit"]["name"]),
        "document" => record.id.clone(),
        _ => text(&value["title"]),
    };
    let title = if title.is_empty() {
        value["profile"]["name"]
            .as_str()
            .unwrap_or(&record.id)
            .into()
    } else {
        title
    };
    let character = match record.kind.as_str() {
        "character" => record.id.clone(),
        "scene" => text(&value["char"]),
        _ => text(&value["characterId"]),
    };
    let category = if record.kind == "character" {
        text(&value["popular"]["franchise"])
    } else if record.kind == "outfit" {
        text(&value["outfit"]["category"])
    } else {
        text(&value["category"])
    };
    let rating =
        if value["adult"] == true || value["mature"] == true || value["outfit"]["adult"] == true {
            "R18".into()
        } else {
            value["rating"]
                .as_str()
                .or(value["sampleRating"].as_str())
                .unwrap_or("All")
                .into()
        };
    let search = format!(
        "{} {} {}",
        record.id,
        title,
        serde_json::to_string(value).unwrap()
    )
    .to_lowercase();
    (title, character, category, rating, search)
}
pub(super) fn put(connection: &Connection, record: &Record, removed: bool) -> Result<()> {
    let (title, character, category, rating, search) = fields(record);
    connection.execute("INSERT INTO content_records(kind,id,revision,sort_order,created_at,updated_at,payload,title,character_id,category,rating,search_text,deleted) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,sort_order=excluded.sort_order,created_at=excluded.created_at,updated_at=excluded.updated_at,payload=excluded.payload,title=excluded.title,character_id=excluded.character_id,category=excluded.category,rating=excluded.rating,search_text=excluded.search_text,deleted=excluded.deleted",params![record.kind,record.id,record.revision,record.sort_order,record.created_at,record.updated_at,serde_json::to_string(&record.data)?,title,character,category,rating,search,removed])?;
    Ok(())
}
pub(super) fn history(
    connection: &Connection,
    record: &Record,
    removed: bool,
    batch: &str,
    at: &str,
) -> Result<()> {
    connection.execute("INSERT INTO content_history(batch,kind,id,revision,at,record,deleted) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![batch,record.kind,record.id,record.revision,at,serde_json::to_string(record)?,removed])?;
    Ok(())
}
impl Catalog {
    pub fn apply(&mut self, changes: &[Change], preview: bool) -> Result<Value> {
        self.apply_with_seeds(changes, preview, &[])
    }
    pub(super) fn apply_with_seeds(
        &mut self,
        changes: &[Change],
        preview: bool,
        seeds: &[(Record, bool)],
    ) -> Result<Value> {
        if (changes.is_empty() && seeds.is_empty()) || changes.len() > 10000 {
            return Err(ApiError::invalid("变更集不能为空且不能超过 10000 条"));
        }
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let seed_index = seeds
            .iter()
            .map(|(r, _)| ((r.kind.as_str(), r.id.as_str()), r))
            .collect::<std::collections::HashMap<_, _>>();
        for change in changes {
            if change.kind == "document"
                && !["tags", "curation", "tag-dictionary-policy"].contains(&change.id.as_str())
                && !seed_index
                    .get(&(change.kind.as_str(), change.id.as_str()))
                    .is_some_and(|r| change.data.as_ref() == Some(&r.data))
            {
                return Err(ApiError::invalid("此系统记录只能通过专用维护流程更新"));
            }
        }
        let changes = super::dependencies::expand(&transaction, changes)?;
        let batch = uuid::Uuid::new_v4().to_string();
        let at = now();
        let mut seen = HashSet::new();
        let mut result = Vec::new();
        let mut diffs = Vec::new();
        for change in &changes {
            validation::key(&change.kind, &change.id)?;
            if !seen.insert((&change.kind, &change.id)) {
                return Err(ApiError::invalid("变更集中有重复记录"));
            }
            let current = transaction
                .query_row(
                    &format!(
                        "SELECT {COLUMNS},deleted FROM content_records WHERE kind=?1 AND id=?2"
                    ),
                    params![change.kind, change.id],
                    |r| Ok((row(r)?, r.get::<_, bool>(7)?)),
                )
                .optional()?;
            if current.as_ref().map_or(0, |(r, _)| r.revision) != change.expected_revision
                || current.as_ref().is_some_and(|(_, removed)| *removed)
            {
                return Err(ApiError::new(
                    409,
                    "CATALOG_CONFLICT",
                    format!(
                        "记录 {}:{} 已改变或下架（读取修订 {}，当前 {}）；草稿已保留，请比较当前记录后合并",
                        change.kind,
                        change.id,
                        change.expected_revision,
                        current.as_ref().map_or(0, |(r, _)| r.revision)
                    ),
                ));
            }
            if change.remove && (current.is_none() || change.kind == "document") {
                return Err(ApiError::invalid("不能删除不存在的记录或系统文档"));
            }
            if change.patch.is_some() && change.data.is_some() {
                return Err(ApiError::invalid("不能同时提交完整内容和字段补丁"));
            }
            let mut patched = current.as_ref().map(|(r, _)| r.data.clone());
            if let Some(patch) = &change.patch {
                merge(
                    patched
                        .as_mut()
                        .ok_or_else(|| ApiError::invalid("字段补丁只能用于已有记录"))?,
                    patch,
                )?;
            }
            let value = change
                .data
                .as_ref()
                .or(patched.as_ref())
                .ok_or_else(|| ApiError::invalid("新记录缺少内容"))?;
            if let Some((before, _)) = &current
                && before.data.get("generatedRecipe").is_some()
                && before.data.get("generatedRecipe") != value.get("generatedRecipe")
            {
                return Err(ApiError::invalid("生成来源配方不能在普通编辑中改写"));
            }
            if !change.remove
                && !(change.kind == "document"
                    && !["tags", "curation", "tag-dictionary-policy"].contains(&change.id.as_str()))
            {
                validation::data(&change.kind, &change.id, value)?;
            }
            if change.kind == "document" && change.id == "prompt-pinned-scenes" {
                let policy: Value = serde_json::from_slice(&std::fs::read(
                    self.options.source.join("data/prompt-pinned-scenes.json"),
                )?)?;
                if value != &policy {
                    return Err(ApiError::invalid(
                        "定稿基线必须与已验证的 pin-capture 基线一致",
                    ));
                }
            }
            if let Some((before, _)) = &current {
                validation::pins(
                    &transaction,
                    &self.options.source,
                    before,
                    (!change.remove).then_some(value),
                )?;
            }
            if change.kind == "scene" && current.is_none() {
                let retired: String = transaction.query_row("SELECT payload FROM content_records WHERE kind='document' AND id='retired-scenes'",[],|r|r.get(0))?;
                let retired: Value = serde_json::from_str(&retired)?;
                if retired["records"]
                    .as_array()
                    .is_some_and(|rows| rows.iter().any(|r| r["id"] == change.id))
                {
                    return Err(ApiError::invalid("已退役的场景 ID 不能复用"));
                }
            }
            let order = match change.sort_order {
                Some(order) => order,
                None => match &current {
                    Some((r, _)) => r.sort_order,
                    None => transaction.query_row(
                        "SELECT COALESCE(MAX(sort_order),-1)+1 FROM content_records WHERE kind=?1",
                        [&change.kind],
                        |r| r.get(0),
                    )?,
                },
            };
            let imported = seed_index.get(&(change.kind.as_str(), change.id.as_str()));
            let created_at = if let Some(date) = &change.created_at {
                let date = chrono::DateTime::parse_from_rfc3339(date)
                    .map_err(|_| ApiError::invalid("createdAt 需要有来源的 RFC3339 日期时间"))?
                    .with_timezone(&chrono::Utc)
                    .to_rfc3339();
                if current
                    .as_ref()
                    .and_then(|(r, _)| r.created_at.as_ref())
                    .is_some_and(|old| old != &date)
                {
                    return Err(ApiError::invalid(
                        "已有创建时间不能重写；createdAt 只补录未知时间",
                    ));
                }
                Some(date)
            } else {
                current.as_ref().map_or_else(
                    || imported.map_or_else(|| Some(at.clone()), |r| r.created_at.clone()),
                    |(r, _)| r.created_at.clone(),
                )
            };
            let record = Record {
                kind: change.kind.clone(),
                id: change.id.clone(),
                revision: change.expected_revision + 1,
                sort_order: order,
                created_at,
                updated_at: if current.is_none() {
                    imported.map_or_else(|| Some(at.clone()), |r| r.updated_at.clone())
                } else {
                    Some(at.clone())
                },
                data: value.clone(),
            };
            if current.as_ref().is_some_and(|(r, _)| {
                r.data == record.data
                    && r.sort_order == record.sort_order
                    && r.created_at == record.created_at
            }) && !change.remove
            {
                continue;
            }
            put(&transaction, &record, change.remove)?;
            history(&transaction, &record, change.remove, &batch, &at)?;
            diffs.push(json!({"kind":change.kind,"id":change.id,"before":current.as_ref().map(|(r,_)|r),"after":if change.remove{None}else{Some(&record)}}));
            result.push(json!({"kind":record.kind,"id":record.id,"revision":record.revision,"removed":change.remove}));
        }
        validation::relations(&transaction)?;
        if changes.iter().any(|c| {
            c.kind == "document" && ["tags", "tag-dictionary-policy"].contains(&c.id.as_str())
        }) {
            let tags = super::dependencies::document(&transaction, "tags")?;
            let policy = super::dependencies::document(&transaction, "tag-dictionary-policy")?;
            crate::bootstrap::tags::dictionary(
                tags.as_array()
                    .ok_or_else(|| ApiError::invalid("标签库无效"))?,
                &policy,
            )
            .map_err(|e| ApiError::invalid(e.message))?;
        }
        if changes
            .iter()
            .any(|c| c.kind == "document" && c.id == "curation")
        {
            let ids = super::dependencies::rows(&transaction, "scene")?
                .into_iter()
                .map(|r| r.id)
                .collect::<Vec<_>>();
            let active = ids.iter().map(String::as_str).collect();
            let value = super::dependencies::document(&transaction, "curation")?;
            let clean = crate::maintenance::validation::curation(&value, &active, &Value::Null)
                .map_err(|e| ApiError::invalid(e.message))?;
            for field in [
                "personaCoreSceneIds",
                "signatureSceneIds",
                "curatedSceneIds",
                "reviewSceneIds",
            ] {
                if value[field].as_array().is_some_and(|items| {
                    items
                        .iter()
                        .any(|id| id.as_str().is_none_or(|id| !active.contains(id)))
                }) {
                    return Err(ApiError::invalid("策展引用了不存在的场景"));
                }
            }
            if clean["signatureSceneIds"].as_array().is_some_and(|items| {
                items.iter().any(|id| {
                    !value["curatedSceneIds"]
                        .as_array()
                        .is_some_and(|curated| curated.contains(id))
                })
            }) {
                return Err(ApiError::invalid("招牌场景必须同时属于精选场景"));
            }
        }
        for (record, removed) in seeds {
            transaction.execute("INSERT INTO content_seed(kind,id,record,deleted) VALUES(?1,?2,?3,?4) ON CONFLICT(kind,id) DO UPDATE SET record=excluded.record,deleted=excluded.deleted",params![record.kind,record.id,serde_json::to_string(record)?,removed])?;
        }
        if !result.is_empty() {
            transaction.execute(
                "UPDATE catalog_meta SET value=CAST(value AS INTEGER)+1 WHERE key='version'",
                [],
            )?;
        }
        let version: String = transaction.query_row(
            "SELECT value FROM catalog_meta WHERE key='version'",
            [],
            |r| r.get(0),
        )?;
        let value = json!({"ok":true,"preview":preview,"batch":batch,"version":version.parse::<i64>().unwrap(),"items":result,"diffs":diffs});
        if preview {
            transaction.rollback()?;
        } else {
            transaction.commit()?;
        }
        Ok(value)
    }
}
