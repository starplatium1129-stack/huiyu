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
fn fields<'a>(record: &'a Record, payload: &str) -> (&'a str, &'a str, &'a str, &'a str, String) {
    let value = &record.data;
    fn text(value: &Value) -> &str {
        value.as_str().unwrap_or("")
    }
    let title = match record.kind.as_str() {
        "character" => text(&value["popular"]["displayName"]),
        "outfit" => text(&value["outfit"]["name"]),
        "document" => record.id.as_str(),
        _ => text(&value["title"]),
    };
    let title = if title.is_empty() {
        value["profile"]["name"].as_str().unwrap_or(&record.id)
    } else {
        title
    };
    let character = match record.kind.as_str() {
        "character" => record.id.as_str(),
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
            "R18"
        } else {
            value["rating"]
                .as_str()
                .or(value["sampleRating"].as_str())
                .unwrap_or("All")
        };
    let search = format!("{} {} {}", record.id, title, payload).to_lowercase();
    (title, character, category, rating, search)
}
pub(super) fn put(connection: &Connection, record: &Record, removed: bool) -> Result<()> {
    let payload = serde_json::to_string(&record.data)?;
    let (title, character, category, rating, search) = fields(record, &payload);
    connection.prepare_cached("INSERT INTO content_records(kind,id,revision,sort_order,created_at,updated_at,payload,title,character_id,category,rating,search_text,deleted) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,sort_order=excluded.sort_order,created_at=excluded.created_at,updated_at=excluded.updated_at,payload=excluded.payload,title=excluded.title,character_id=excluded.character_id,category=excluded.category,rating=excluded.rating,search_text=excluded.search_text,deleted=excluded.deleted")?.execute(params![record.kind,record.id,record.revision,record.sort_order,record.created_at,record.updated_at,payload,title,character,category,rating,search,removed])?;
    Ok(())
}
pub(super) fn history(
    connection: &Connection,
    record: &Record,
    removed: bool,
    batch: &str,
    at: &str,
) -> Result<String> {
    let mut statement = connection.prepare_cached("INSERT INTO content_history(batch,kind,id,revision,at,record,deleted) VALUES(?1,?2,?3,?4,?5,?6,?7)")?;
    let encoded = serde_json::to_string(record)?;
    statement.execute(params![
        batch,
        record.kind,
        record.id,
        record.revision,
        at,
        encoded,
        removed
    ])?;
    Ok(encoded)
}
impl Catalog {
    pub fn apply(&mut self, changes: &[Change], preview: bool) -> Result<Value> {
        self.apply_with_seeds(changes, preview, &[], &[])
    }
    pub(super) fn apply_with_seeds(
        &mut self,
        changes: &[Change],
        preview: bool,
        seeds: &[(Record, bool)],
        preserved: &[(Record, bool)],
    ) -> Result<Value> {
        if (changes.is_empty() && seeds.is_empty()) || changes.len() > 10000 {
            return Err(ApiError::invalid("变更集不能为空且不能超过 10000 条"));
        }
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        for (record, removed) in seeds {
            super::provenance::seed_update(&transaction, record, *removed)?;
        }
        let seed_index = seeds
            .iter()
            .map(|(r, _)| ((r.kind.as_str(), r.id.as_str()), r))
            .collect::<std::collections::HashMap<_, _>>();
        let retired_seeds = seeds
            .iter()
            .filter(|(_, removed)| *removed)
            .map(|(record, _)| ((record.kind.as_str(), record.id.as_str()), record))
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
        let expanded = super::dependencies::expand(&transaction, changes)?;
        let original = if expanded.is_none() { changes } else { &[] };
        let changes = original.iter().chain(
            expanded
                .as_deref()
                .unwrap_or(&[])
                .iter()
                .map(|change| change.as_ref()),
        );
        let preserved_keys: HashSet<_> = preserved
            .iter()
            .map(|(record, _)| (record.kind.as_str(), record.id.as_str()))
            .collect();
        if let Some(change) = changes
            .clone()
            .find(|change| preserved_keys.contains(&(change.kind.as_str(), change.id.as_str())))
        {
            return Err(ApiError::new(
                409,
                "CATALOG_PRESERVED_LOCAL_DEPENDENCY",
                format!(
                    "关联变更会修改已保留的本地记录 {}:{}；导入未写入，请先合并关联内容",
                    change.kind, change.id
                ),
            ));
        }
        let batch = uuid::Uuid::new_v4().to_string();
        let at = now();
        let mut seen = HashSet::new();
        let mut result = Vec::new();
        let mut diffs = Vec::new();
        let mut retired_imports = Vec::new();
        let mut retired_ids: Option<HashSet<String>> = None;
        let mut pin_policy = validation::PinPolicy::default();
        let mut current_query = transaction.prepare_cached(&format!(
            "SELECT {COLUMNS},deleted FROM content_records WHERE kind=?1 AND id=?2"
        ))?;
        // The planning read and this write transaction are separate. Protect
        // preserved rows with the same optimistic concurrency boundary as edits.
        for (expected, expected_removed) in preserved {
            let current = current_query
                .query_row(params![expected.kind, expected.id], |row_| {
                    Ok((row(row_)?, row_.get::<_, bool>(7)?))
                })
                .optional()?;
            if !current.as_ref().is_some_and(|(record, removed)| {
                record.revision == expected.revision
                    && record.data == expected.data
                    && record.sort_order == expected.sort_order
                    && record.created_at == expected.created_at
                    && record.updated_at == expected.updated_at
                    && removed == expected_removed
            }) {
                return Err(ApiError::new(
                    409,
                    "CATALOG_CONFLICT",
                    format!(
                        "已保留的本地记录 {}:{} 在导入前已变化；请重新预览",
                        expected.kind, expected.id
                    ),
                ));
            }
        }
        for change in changes.clone() {
            validation::key(&change.kind, &change.id)?;
            if !seen.insert((&change.kind, &change.id)) {
                return Err(ApiError::invalid("变更集中有重复记录"));
            }
            let current = current_query
                .query_row(params![change.kind, change.id], |r| {
                    Ok((row(r)?, r.get::<_, bool>(7)?))
                })
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
            let imported_retirement = change.remove
                && current.is_none()
                && change.expected_revision == 0
                && change.patch.is_none()
                && retired_seeds
                    .get(&(change.kind.as_str(), change.id.as_str()))
                    .is_some_and(|record| {
                        change.data.as_ref() == Some(&record.data)
                            && change.sort_order == Some(record.sort_order)
                            && (record.data.is_object() || record.data.is_array())
                    });
            if change.remove
                && (change.kind == "document" || current.is_none() && !imported_retirement)
            {
                return Err(ApiError::invalid("不能删除不存在的记录或系统文档"));
            }
            if change.patch.is_some() && change.data.is_some() {
                return Err(ApiError::invalid("不能同时提交完整内容和字段补丁"));
            }
            let mut patched = if change.patch.is_some() {
                current.as_ref().map(|(r, _)| r.data.clone())
            } else {
                None
            };
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
                .or_else(|| current.as_ref().map(|(record, _)| &record.data))
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
                    &mut pin_policy,
                    before,
                    (!change.remove).then_some(value),
                )?;
            }
            if change.kind == "scene" && current.is_none() && !change.remove {
                if retired_ids.is_none() {
                    let retired: String = transaction.query_row("SELECT payload FROM content_records WHERE kind='document' AND id='retired-scenes'",[],|r|r.get(0))?;
                    let mut retired: Value = serde_json::from_str(&retired)?;
                    retired_ids = Some(
                        retired
                            .get_mut("records")
                            .and_then(Value::as_array_mut)
                            .into_iter()
                            .flatten()
                            .filter_map(|row| match row.get_mut("id") {
                                Some(Value::String(id)) => Some(std::mem::take(id)),
                                _ => None,
                            })
                            .collect(),
                    );
                }
                if retired_ids.as_ref().unwrap().contains(&change.id) {
                    return Err(ApiError::invalid("已退役的场景 ID 不能复用"));
                }
            }
            let order = match change.sort_order {
                Some(order) => order,
                None => match &current {
                    Some((r, _)) => r.sort_order,
                    // Both deleted states participate, with one catalog_order
                    // index endpoint per state instead of scanning the kind.
                    None => transaction
                        .prepare_cached(
                            "SELECT COALESCE(MAX(sort_order),-1)+1 FROM (
                                SELECT MAX(sort_order) AS sort_order FROM content_records WHERE kind=?1 AND deleted=0
                                UNION ALL
                                SELECT MAX(sort_order) AS sort_order FROM content_records WHERE kind=?1 AND deleted=1
                            )",
                        )?
                        .query_row([&change.kind], |r| r.get(0))?,
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
            if !change.remove
                && current.as_ref().is_some_and(|(record, _)| {
                    record.data == *value
                        && record.sort_order == order
                        && record.created_at == created_at
                })
            {
                continue;
            }
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
                data: change
                    .data
                    .clone()
                    .or(patched)
                    .or_else(|| current.as_ref().map(|(record, _)| record.data.clone()))
                    .unwrap(),
            };
            put(&transaction, &record, change.remove)?;
            if record.kind == "document" && record.id == "retired-scenes" {
                // Later changes in this transaction must see the updated retirement list.
                retired_ids = None;
            }
            if record.kind == "document" && record.id == "prompt-pinned-scenes" {
                pin_policy.database_changed();
            }
            history(&transaction, &record, change.remove, &batch, &at)?;
            result.push(json!({"kind":record.kind,"id":record.id,"revision":record.revision,"removed":change.remove}));
            if imported_retirement {
                // A newly imported tombstone has no active before/after record.
                // Expose its real archived identity separately from edit diffs.
                retired_imports.push(record.into_value()?);
            } else {
                let mut diff =
                    json!({"kind":change.kind,"id":change.id,"before":null,"after":null});
                diff["before"] = current
                    .map(|(record, _)| record.into_value())
                    .transpose()?
                    .unwrap_or(Value::Null);
                if !change.remove {
                    diff["after"] = record.into_value()?;
                }
                diffs.push(diff);
            }
        }
        drop(current_query);
        validation::relations(&transaction)?;
        let prompt_review =
            super::prompt_guard::review(&diffs, &transaction, &self.options.source)?;
        if changes.clone().any(|c| {
            c.kind == "document" && ["tags", "tag-dictionary-policy"].contains(&c.id.as_str())
        }) {
            let tags = super::dependencies::document(&transaction, "tags")?;
            let policy = super::dependencies::document(&transaction, "tag-dictionary-policy")?;
            crate::bootstrap::tags::validate_dictionary(
                tags.as_array()
                    .ok_or_else(|| ApiError::invalid("标签库无效"))?,
                &policy,
            )
            .map_err(|e| ApiError::invalid(e.message))?;
        }
        if changes
            .clone()
            .any(|c| c.kind == "document" && c.id == "curation")
        {
            let mut statement = transaction.prepare(
                "SELECT id FROM content_records WHERE kind='scene' AND deleted=0 ORDER BY sort_order,id",
            )?;
            let ids = statement
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let active = ids.iter().map(String::as_str).collect();
            let value = super::dependencies::document(&transaction, "curation")?;
            let signature = crate::maintenance::validation::curation(&value, &active)
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
            let curated = value["curatedSceneIds"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect::<HashSet<_>>();
            if signature.iter().any(|id| !curated.contains(id)) {
                return Err(ApiError::invalid("招牌场景必须同时属于精选场景"));
            }
        }
        for (record, removed) in seeds {
            transaction.prepare_cached("INSERT INTO content_seed(kind,id,record,deleted) VALUES(?1,?2,?3,?4) ON CONFLICT(kind,id) DO UPDATE SET record=excluded.record,deleted=excluded.deleted")?.execute(params![record.kind,record.id,serde_json::to_string(record)?,removed])?;
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
        let preserved_local: Vec<_> = preserved
            .iter()
            .map(
                |(record, _)| json!({"kind":record.kind,"id":record.id,"revision":record.revision}),
            )
            .collect();
        let mut value = json!({"ok":true,"preview":preview,"batch":batch,"version":version.parse::<i64>().unwrap(),"items":null,"diffs":null,"retiredImports":null,"preservedLocal":null});
        value["items"] = Value::Array(result);
        value["diffs"] = Value::Array(diffs);
        value["retiredImports"] = Value::Array(retired_imports);
        value["preservedLocal"] = Value::Array(preserved_local);
        value["promptReview"] = prompt_review;
        pin_policy.check(&self.options.source)?;
        if preview {
            transaction.rollback()?;
        } else {
            transaction.commit()?;
        }
        Ok(value)
    }
}
