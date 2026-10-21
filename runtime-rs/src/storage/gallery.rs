use super::*;
use gallery_index::FIELDS;
use rusqlite::{params_from_iter, types::Value as SqlValue};

const FROM: &str = "artwork_gallery_index g JOIN artwork_read_index i USING(id_key)";
#[derive(Default)]
struct Filter {
    clauses: Vec<String>,
    values: Vec<SqlValue>,
}
impl Filter {
    fn and(&mut self, sql: impl Into<String>) {
        self.clauses.push(sql.into());
    }
    fn bind(&mut self, value: impl Into<String>) {
        self.values.push(SqlValue::Text(value.into()));
    }
    fn sql(&self) -> String {
        if self.clauses.is_empty() {
            "1".into()
        } else {
            self.clauses.join(" AND ")
        }
    }
    fn member(&mut self, path: &str, value: &str) {
        if value.is_empty() {
            return;
        }
        if path == "characters" && value == "__unassigned__" {
            self.and("json_array_length(g.facets,'$.characters')=0");
        } else {
            self.and(format!(
                "EXISTS(SELECT 1 FROM json_each(g.facets,'$.{path}') WHERE value=?)"
            ));
            self.bind(value);
        }
    }
    fn manual(&mut self, id: &str) {
        if id.is_empty() {
            return;
        }
        self.and("EXISTS(SELECT 1 FROM projects p,json_each(p.body,'$.history_ids') m WHERE p.id_key=? AND json_type(p.body,'$.smartRule') IS NULL AND CAST(m.value AS TEXT)=g.id_key)");
        self.bind(id);
    }
    fn search(&mut self, search: &str) {
        for term in search.to_lowercase().split_whitespace() {
            self.and("instr(i.search_text,?)>0");
            self.bind(term);
        }
    }
    fn rule(&mut self, rule: &Value) -> Result<()> {
        let rule = project_commands::normalize_rule(rule)?;
        self.member("characters", rule["characterId"].as_str().unwrap());
        self.manual(rule["projectId"].as_str().unwrap());
        if rule["favoriteOnly"] == true {
            self.and("json_extract(g.facets,'$.favorite')=1");
        }
        self.search(rule["search"].as_str().unwrap());
        let tags = rule["tags"].as_array().unwrap();
        if !tags.is_empty() {
            self.and(format!(
                "({})",
                tags.iter()
                    .map(|_| "EXISTS(SELECT 1 FROM json_each(g.facets,'$.tags') WHERE value=?)")
                    .collect::<Vec<_>>()
                    .join(if rule["tagMatch"] == "any" {
                        " OR "
                    } else {
                        " AND "
                    })
            ));
            for tag in tags {
                self.bind(tag.as_str().unwrap());
            }
        }
        Ok(())
    }
}
fn filter(c: &Context, query: &Value) -> Result<Filter> {
    if !query.is_object() {
        return Err(invalid("Gallery query must be an object"));
    }
    let mut f = Filter::default();
    let text = |key: &str| -> Result<&str> {
        query
            .get(key)
            .map(|v| {
                v.as_str()
                    .filter(|s| s.len() <= 16000)
                    .ok_or_else(|| invalid("Invalid gallery condition"))
            })
            .unwrap_or(Ok(""))
    };
    f.member("characters", text("characterId")?);
    f.member("tags", text("tag")?);
    f.search(text("search")?);
    if query["favoriteOnly"] == true {
        f.and("json_extract(g.facets,'$.favorite')=1");
    }
    let project = text("projectId")?;
    if !project.is_empty() {
        match records::project(c, project)? {
            Some(p) if p["body"].get("smartRule").is_some() => {
                if f.rule(&p["body"]["smartRule"]).is_err() {
                    f.and("0");
                }
            }
            Some(_) => f.manual(project),
            None => f.and("0"),
        }
    }
    if let Some(rule) = query.get("rule") {
        f.rule(rule)?;
    }
    for field in FIELDS {
        let selected = query["generation"][field].as_str().unwrap_or("");
        if selected == "missing" {
            f.and(format!(
                "json_array_length(g.facets,'$.generation.{field}')=0"
            ));
        } else if let Some(value) = selected.strip_prefix("v:") {
            f.member(&format!("generation.{field}"), value);
        } else if !selected.is_empty() {
            return Err(invalid("Invalid generation condition"));
        }
    }
    Ok(f)
}
fn project_version(c: &Context) -> Result<String> {
    let mut stmt =
        c.db.prepare_cached("SELECT id_key,revision FROM projects ORDER BY id_key")?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(canonical::digest(serde_json::to_vec(&rows)?))
}
fn count(c: &Context, f: &Filter) -> Result<i64> {
    Ok(c.db.query_row(
        &format!("SELECT count(*) FROM {FROM} WHERE {}", f.sql()),
        params_from_iter(&f.values),
        |r| r.get(0),
    )?)
}
fn items(c: &Context, f: &Filter, limit: i64) -> Result<Vec<Value>> {
    let sql = format!(
        "SELECT a.id_json,{},a.revision,a.deleted_at,g.time,g.id_key FROM {FROM} JOIN artworks a USING(id_key) WHERE {} ORDER BY g.time DESC,g.id_key LIMIT {limit}",
        records::GALLERY_BODY,
        f.sql()
    );
    let mut stmt = c.db.prepare(&sql)?;
    let mut rows = stmt.query(params_from_iter(&f.values))?;
    let mut items = Vec::new();
    while let Some(row) = rows.next()? {
        c.check_cancel()?;
        items.push(json!({"record":records::decode_artwork(row)?,"time":row.get::<_,f64>(4)?,"key":row.get::<_,String>(5)?}));
    }
    Ok(items)
}
pub(super) fn read(c: &Context, command: &Value) -> Result<Value> {
    let revision = artwork_index::revision(c)?;
    let projects = project_version(c)?;
    let query = canonical::fingerprint(&command["query"]);
    let mut f = filter(c, &command["query"])?;
    let total = count(c, &f)?;
    let limit = command["limit"].as_i64().unwrap_or(24);
    if !(1..=200).contains(&limit) {
        return Err(invalid("Gallery limit must be 1–200"));
    }
    if let Some(cursor) = command.get("cursor").filter(|v| !v.is_null()) {
        if cursor["query"] != query {
            return Err(invalid("Gallery cursor belongs to a different query"));
        }
        if cursor["revision"] != revision || cursor["projects"] != projects {
            return Err(conflict(
                "GALLERY_CHANGED",
                "作品库在翻页期间发生变更，请重新读取",
            ));
        }
        let time = cursor["time"]
            .as_f64()
            .filter(|t| t.is_finite())
            .ok_or_else(|| invalid("Invalid gallery cursor"))?;
        let key = string(cursor, "key")?;
        f.and("(g.time<? OR (g.time=? AND g.id_key>?))");
        f.values.extend([
            SqlValue::Real(time),
            SqlValue::Real(time),
            SqlValue::Text(key.into()),
        ]);
    }
    let mut page = items(c, &f, limit + 1)?;
    let more = page.len() > limit as usize;
    page.truncate(limit as usize);
    let next = if more {
        let last = page.last().unwrap();
        json!({"time":last["time"],"key":last["key"],"revision":revision,"projects":projects,"query":query})
    } else {
        Value::Null
    };
    Ok(
        json!({"items":page.into_iter().map(|mut item| item["record"].take()).collect::<Vec<_>>(),"total":total,"nextCursor":next,"revision":revision,"projectsVersion":projects}),
    )
}
fn buckets(c: &Context, path: &str) -> Result<Value> {
    let mut stmt = c.db.prepare(&format!("SELECT value,count(*) FROM artwork_gallery_index,json_each(facets,'$.{path}') GROUP BY value ORDER BY count(*) DESC,value"))?;
    let values = stmt
        .query_map([], |r| {
            Ok(json!({"value":r.get::<_,String>(0)?,"count":r.get::<_,i64>(1)?}))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(values.into())
}
fn album(c: &Context, id: Value, f: &Filter, covers: &mut HashMap<String, Value>) -> Result<Value> {
    let page = items(c, f, 3)?;
    let mut ids = Vec::new();
    for item in page {
        let record = &item["record"];
        ids.push(record["id"].clone());
        covers.insert(item["key"].as_str().unwrap().into(), record.clone());
    }
    Ok(json!({"id":id,"count":count(c,f)?,"coverIds":ids}))
}
pub(super) fn catalog(c: &Context) -> Result<Value> {
    let mut generation = json!({});
    for field in FIELDS {
        let mut values = buckets(c, &format!("generation.{field}"))?
            .as_array()
            .unwrap()
            .clone();
        for value in &mut values {
            value["value"] = format!("v:{}", value["value"].as_str().unwrap()).into();
        }
        let missing: i64 = c.db.query_row(&format!("SELECT count(*) FROM artwork_gallery_index WHERE json_array_length(facets,'$.generation.{field}')=0"),[],|r| r.get(0))?;
        values.push(json!({"value":"missing","count":missing}));
        generation[field] = values.into();
    }
    let mut covers = HashMap::new();
    let mut albums = Vec::new();
    let mut stmt =
        c.db.prepare_cached("SELECT id_key FROM projects ORDER BY id_key")?;
    let ids = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for id in ids {
        c.check_cancel()?;
        albums.push(album(
            c,
            json!(id),
            &filter(c, &json!({"projectId":id}))?,
            &mut covers,
        )?);
    }
    let mut characters = Vec::new();
    let mut character_ids = buckets(c, "characters")?
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["value"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    character_ids.push("__unassigned__".into());
    for id in character_ids {
        c.check_cancel()?;
        let f = filter(c, &json!({"characterId":id}))?;
        let a = album(c, json!(id), &f, &mut covers)?;
        if a["count"].as_i64().unwrap() > 0 {
            characters.push(a);
        }
    }
    Ok(
        json!({"revision":artwork_index::revision(c)?,"projectsVersion":project_version(c)?,"total":count(c,&Filter::default())?,
        "favoriteCount":count(c,&filter(c,&json!({"favoriteOnly":true}))?)?,"tags":buckets(c,"tags")?,"generation":generation,
        "albums":albums,"characters":characters,"covers":covers.into_values().collect::<Vec<_>>() }),
    )
}
