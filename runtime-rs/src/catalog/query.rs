use super::*;
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Query {
    pub kind: String,
    #[serde(default)]
    pub search: String,
    #[serde(default)]
    pub character: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub rating: String,
    #[serde(default)]
    pub sort: String,
    #[serde(default)]
    pub created_from: String,
    #[serde(default)]
    pub created_to: String,
    pub page: Option<i64>,
    pub page_size: Option<i64>,
}
impl Catalog {
    pub fn query(&self, query: &Query) -> Result<Value> {
        let transaction = self.connection.unchecked_transaction()?;
        let date = |text: &str| -> Result<Option<chrono::DateTime<chrono::FixedOffset>>> {
            if text.is_empty() {
                Ok(None)
            } else {
                chrono::DateTime::parse_from_rfc3339(text)
                    .map(Some)
                    .map_err(|_| ApiError::invalid("创建时间筛选需要 RFC3339 日期时间"))
            }
        };
        if date(&query.created_from)?
            .zip(date(&query.created_to)?)
            .is_some_and(|(from, to)| from >= to)
        {
            return Err(ApiError::invalid("创建时间范围的起点必须早于终点"));
        }
        if query.kind != "media" && !KINDS.contains(&query.kind.as_str()) {
            return Err(ApiError::invalid("记录类型无效"));
        }
        let page = query.page.unwrap_or(1).max(1);
        let size = query.page_size.unwrap_or(24).clamp(1, 100);
        let order = match query.sort.as_str() {
            "title" => "title COLLATE NOCASE,sort_order,id",
            "newest" => "created_at IS NULL,created_at DESC,sort_order,id",
            "updated" => "updated_at IS NULL,updated_at DESC,sort_order,id",
            "id" => "id",
            "" | "order" => "sort_order,id",
            _ => return Err(ApiError::invalid("排序方式无效")),
        };
        let (first_kind, second_kind) = if query.kind == "media" {
            ("scene", "blueprint")
        } else {
            (query.kind.as_str(), query.kind.as_str())
        };
        // Omitted filters must not hide indexed predicates behind optional ORs.
        // Bind every supplied value; only the fixed SQL fragments are assembled.
        let mut filter = String::from("kind IN (?,?) AND deleted=0");
        let mut values: Vec<rusqlite::types::Value> =
            vec![first_kind.to_owned().into(), second_kind.to_owned().into()];
        let search = query.search.trim().to_lowercase();
        for (predicate, value) in [
            ("instr(search_text,lower(?))>0", search.as_str()),
            ("character_id=?", query.character.as_str()),
            ("category=?", query.category.as_str()),
            ("rating=?", query.rating.as_str()),
            (
                "julianday(created_at)>=julianday(?)",
                query.created_from.as_str(),
            ),
            (
                "julianday(created_at)<julianday(?)",
                query.created_to.as_str(),
            ),
        ] {
            if !value.is_empty() {
                filter.push_str(" AND ");
                filter.push_str(predicate);
                values.push(value.to_owned().into());
            }
        }
        let total: i64 = self.connection.query_row(
            &format!("SELECT count(*) FROM content_records WHERE {filter}"),
            rusqlite::params_from_iter(&values),
            |r| r.get(0),
        )?;
        let selected_page = page.min(((total + size - 1) / size).max(1));
        let mut statement = self.connection.prepare(&format!("SELECT kind,id,revision,sort_order,created_at,updated_at,title,character_id,category,rating FROM content_records WHERE {filter} ORDER BY {order} LIMIT ? OFFSET ?"))?;
        values.extend([size.into(), ((selected_page - 1) * size).into()]);
        let items = statement.query_map(rusqlite::params_from_iter(&values), |r| {
            Ok(json!({"kind":r.get::<_,String>(0)?,"id":r.get::<_,String>(1)?,"revision":r.get::<_,i64>(2)?,"sortOrder":r.get::<_,i64>(3)?,"createdAt":r.get::<_,Option<String>>(4)?,"updatedAt":r.get::<_,Option<String>>(5)?,
                "title":r.get::<_,String>(6)?,"characterId":r.get::<_,String>(7)?,"category":r.get::<_,String>(8)?,"rating":r.get::<_,String>(9)?}))
        })?.collect::<rusqlite::Result<Vec<_>>>()?;
        let mut facets = self.connection.prepare("SELECT DISTINCT character_id,category,rating FROM content_records WHERE kind IN (?1,?2) AND deleted=0")?;
        let mut characters = std::collections::BTreeSet::new();
        let mut categories = std::collections::BTreeSet::new();
        let mut ratings = std::collections::BTreeSet::new();
        for result in facets.query_map([first_kind, second_kind], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })? {
            let (character, category, rating) = result?;
            if !character.is_empty() {
                characters.insert(character);
            }
            if !category.is_empty() {
                categories.insert(category);
            }
            if !rating.is_empty() {
                ratings.insert(rating);
            }
        }
        let value = json!({"ok":true,"version":self.version()?,"items":items,"total":total,"page":selected_page,"pageSize":size,"facets":{"characters":characters,"categories":categories,"ratings":ratings}});
        transaction.commit()?;
        Ok(value)
    }
    pub fn history(&self, kind: &str, id: &str) -> Result<Value> {
        validation::key(kind, id)?;
        let mut statement = self.connection.prepare("SELECT revision,at,batch,deleted FROM content_history WHERE kind=?1 AND id=?2 ORDER BY revision DESC LIMIT 100")?;
        let items = statement.query_map(params![kind,id], |r| Ok(json!({"revision":r.get::<_,i64>(0)?,"at":r.get::<_,String>(1)?,"batch":r.get::<_,String>(2)?,"removed":r.get::<_,bool>(3)?})))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(json!({"ok":true,"items":items}))
    }
    pub fn historical(&self, kind: &str, id: &str, revision: i64) -> Result<Record> {
        validation::key(kind, id)?;
        let text: String = self
            .connection
            .query_row(
                "SELECT record FROM content_history WHERE kind=?1 AND id=?2 AND revision=?3",
                params![kind, id, revision],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| ApiError::new(404, "CATALOG_HISTORY_NOT_FOUND", "历史修订不存在"))?;
        Ok(serde_json::from_str(&text)?)
    }
}
