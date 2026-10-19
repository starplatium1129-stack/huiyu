use super::*;
use std::sync::Arc;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Page {
    ok: bool,
    version: i64,
    items: Vec<Value>,
    total: i64,
    page: i64,
    page_size: i64,
    #[serde(serialize_with = "Value::serialize")]
    facets: Arc<Value>,
}

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
        let Page { ok, version, items, total, page, page_size, facets } =
            self.query_cached(query, None)?;
        let mut value = json!({"ok":ok,"version":version,"items":null,"total":total,"page":page,"pageSize":page_size,"facets":null});
        value["items"] = Value::Array(items);
        value["facets"] = Arc::unwrap_or_clone(facets);
        Ok(value)
    }
    pub(super) fn query_cached(&self, query: &Query, cache: Option<&FacetCache>) -> Result<Page> {
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
            // DESC already puts NULL last; a leading IS NULL expression
            // prevents catalog_newest from supplying the date order.
            "newest" => "created_at DESC,sort_order,id",
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
        // Select the cache generation before any other SELECT pins this snapshot.
        let cached = cache
            .map(|cache| cache.select(self, &query.kind))
            .transpose()?;
        let version = match &cached {
            Some((generation, _)) => generation.version,
            None => self.version()?,
        };
        // Omitted filters must not hide indexed predicates behind optional ORs.
        // Bind every supplied value; only the fixed SQL fragments are assembled.
        let (mut filter, mut values): (String, Vec<rusqlite::types::Value>) =
            if query.kind == "media" {
                (
                    "kind IN (?,?) AND deleted=0".into(),
                    vec![first_kind.to_owned().into(), second_kind.to_owned().into()],
                )
            } else {
                // A single equality lets catalog_order satisfy pagination directly;
                // a duplicate-value IN still introduces a temporary sort in SQLite.
                (
                    "kind=? AND deleted=0".into(),
                    vec![query.kind.clone().into()],
                )
            };
        let search = query.search.trim().to_lowercase();
        let mut narrowed = false;
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
                narrowed = true;
                filter.push_str(" AND ");
                filter.push_str(predicate);
                values.push(value.to_owned().into());
            }
        }
        // Facets and the unfiltered total share one scan and one revision.
        // Warm unfiltered pagination needs neither another count nor a full scan.
        let (publish_generation, (facets, unfiltered_total)) = match cached {
            Some((_, Some(value))) => (None, value),
            Some((generation, None)) => (Some(generation), self.facets(first_kind, second_kind)?),
            None => (None, self.facets(first_kind, second_kind)?),
        };
        let total: i64 = if narrowed {
            self.connection.query_row(
                &format!("SELECT count(*) FROM content_records WHERE {filter}"),
                rusqlite::params_from_iter(&values),
                |r| r.get(0),
            )?
        } else {
            unfiltered_total
        };
        let selected_page = page.min(((total + size - 1) / size).max(1));
        let mut statement = self.connection.prepare(&format!("SELECT kind,id,revision,sort_order,created_at,updated_at,title,character_id,category,rating FROM content_records WHERE {filter} ORDER BY {order} LIMIT ? OFFSET ?"))?;
        values.extend([size.into(), ((selected_page - 1) * size).into()]);
        let items = statement.query_map(rusqlite::params_from_iter(&values), |r| {
            Ok(json!({"kind":text_column(r,0)?,"id":text_column(r,1)?,"revision":r.get::<_,i64>(2)?,"sortOrder":r.get::<_,i64>(3)?,"createdAt":optional_text_column(r,4)?,"updatedAt":optional_text_column(r,5)?,
                "title":text_column(r,6)?,"characterId":text_column(r,7)?,"category":text_column(r,8)?,"rating":text_column(r,9)?}))
        })?.collect::<rusqlite::Result<Vec<_>>>()?;
        let value = Page {
            ok: true,
            version,
            items,
            total,
            page: selected_page,
            page_size: size,
            facets,
        };
        transaction.commit()?;
        if let (Some(cache), Some(generation)) = (cache, publish_generation) {
            cache.publish(generation, &query.kind, value.facets.clone(), unfiltered_total)?;
        }
        Ok(value)
    }
    fn facets(&self, first_kind: &str, second_kind: &str) -> Result<(Arc<Value>, i64)> {
        let mut facets = self.connection.prepare("SELECT character_id,category,rating,count(*) FROM content_records WHERE kind IN (?1,?2) AND deleted=0 GROUP BY character_id,category,rating")?;
        let mut characters = std::collections::BTreeSet::new();
        let mut categories = std::collections::BTreeSet::new();
        let mut ratings = std::collections::BTreeSet::new();
        let mut total = 0;
        let mut rows = facets.query([first_kind, second_kind])?;
        while let Some(row) = rows.next()? {
            let character = text_column(row, 0)?;
            let category = text_column(row, 1)?;
            let rating = text_column(row, 2)?;
            let count = row.get::<_, i64>(3)?;
            total += count;
            if !character.is_empty() && !characters.contains(character) {
                characters.insert(character.to_owned());
            }
            if !category.is_empty() && !categories.contains(category) {
                categories.insert(category.to_owned());
            }
            if !rating.is_empty() && !ratings.contains(rating) {
                ratings.insert(rating.to_owned());
            }
        }
        let mut value = json!({"characters":null,"categories":null,"ratings":null});
        value["characters"] = characters.into_iter().map(Value::String).collect();
        value["categories"] = categories.into_iter().map(Value::String).collect();
        value["ratings"] = ratings.into_iter().map(Value::String).collect();
        Ok((Arc::new(value), total))
    }
    pub fn history(&self, kind: &str, id: &str) -> Result<Value> {
        validation::key(kind, id)?;
        let mut statement = self.connection.prepare("SELECT revision,at,batch,deleted FROM content_history WHERE kind=?1 AND id=?2 ORDER BY revision DESC LIMIT 100")?;
        let items = statement.query_map(params![kind,id], |r| Ok(json!({"revision":r.get::<_,i64>(0)?,"at":text_column(r,1)?,"batch":text_column(r,2)?,"removed":r.get::<_,bool>(3)?})))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let mut value = json!({"ok":true,"items":null});
        value["items"] = Value::Array(items);
        Ok(value)
    }
    pub fn historical(&self, kind: &str, id: &str, revision: i64) -> Result<Record> {
        validation::key(kind, id)?;
        let record = self
            .connection
            .query_row(
                "SELECT record FROM content_history WHERE kind=?1 AND id=?2 AND revision=?3",
                params![kind, id, revision],
                |r| Ok(serde_json::from_str::<Record>(text_column(r, 0)?)),
            )
            .optional()?
            .ok_or_else(|| ApiError::new(404, "CATALOG_HISTORY_NOT_FOUND", "历史修订不存在"))?;
        Ok(record?)
    }
}
