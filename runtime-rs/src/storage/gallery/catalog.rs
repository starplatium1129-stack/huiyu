use super::*;

pub(in crate::storage) struct CatalogCache {
    revision: i64,
    projects: String,
    value: Value,
}

fn generation(c: &Context) -> Result<Value> {
    let mut result = json!({});
    let mut missing = HashMap::new();
    for field in FIELDS {
        result[field] = json!([]);
        missing.insert(field.to_owned(), 0i64);
    }
    // One traversal supplies all six dimensions, including empty arrays.
    let mut statement = c.db.prepare_cached("SELECT f.key,v.value,count(*) FROM artwork_gallery_index g,json_each(g.facets,'$.generation') f LEFT JOIN json_each(f.value) v ON 1 GROUP BY f.key,v.value ORDER BY f.key,count(*) DESC,v.value")?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        c.check_cancel()?;
        let field: String = row.get(0)?;
        let Some(absent) = missing.get_mut(&field) else { continue };
        let count: i64 = row.get(2)?;
        if let Some(value) = row.get::<_, Option<String>>(1)? {
            result[&field].as_array_mut().unwrap().push(json!({"value":format!("v:{value}"),"count":count}));
        } else {
            *absent = count;
        }
    }
    for field in FIELDS {
        result[field].as_array_mut().unwrap().push(json!({"value":"missing","count":missing[field]}));
    }
    Ok(result)
}

fn buckets(c: &Context, path: &str) -> Result<Value> {
    let mut stmt = c.db.prepare(&format!("SELECT value,count(*) FROM artwork_gallery_index,json_each(facets,'$.{path}') GROUP BY value ORDER BY count(*) DESC,value"))?;
    let values = stmt.query_map([], |r| Ok(json!({"value":r.get::<_,String>(0)?,"count":r.get::<_,i64>(1)?})))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(values.into())
}

fn grouped(c: &Context, members: &str, covers: &mut HashMap<String, Value>) -> Result<HashMap<String, Value>> {
    // Rank IDs first: only the three covers per group decode artwork bodies.
    let sql = format!("WITH members AS ({members}), ranked AS (
        SELECT group_id,id_key,count(*) OVER(PARTITION BY group_id) AS total,
        row_number() OVER(PARTITION BY group_id ORDER BY time DESC,id_key) AS position FROM members)
        SELECT a.id_json,{},a.revision,a.deleted_at,r.id_key,r.group_id,r.total
        FROM ranked r JOIN artworks a USING(id_key) WHERE r.position<=3 ORDER BY r.group_id,r.position", records::GALLERY_BODY);
    let mut statement = c.db.prepare(&sql)?;
    let mut rows = statement.query([])?;
    let mut groups = HashMap::new();
    while let Some(row) = rows.next()? {
        c.check_cancel()?;
        let record = records::decode_artwork(row)?;
        let key: String = row.get(4)?;
        let id: String = row.get(5)?;
        let count: i64 = row.get(6)?;
        let group = groups.entry(id.clone()).or_insert_with(|| json!({"id":id,"count":count,"coverIds":[]}));
        group["coverIds"].as_array_mut().unwrap().push(record["id"].clone());
        covers.insert(key, record);
    }
    Ok(groups)
}

pub(in crate::storage) fn read(c: &Context) -> Result<Value> {
    let revision = artwork_index::revision(c)?;
    let projects = project_version(c)?;
    if let Some(cache) = c.gallery_catalog.borrow().as_ref()
        && cache.revision == revision && cache.projects == projects {
        return Ok(cache.value.clone());
    }
    let generation = generation(c)?;
    let mut covers = HashMap::new();
    let mut manual = grouped(c, "SELECT p.id_key AS group_id,g.id_key,g.time FROM projects p JOIN project_artworks m ON m.project_key=p.id_key JOIN artwork_gallery_index g ON g.id_key=m.artwork_key JOIN artwork_read_index i ON i.id_key=g.id_key WHERE json_type(p.body,'$.smartRule') IS NULL", &mut covers)?;
    let mut characters = grouped(c, "SELECT COALESCE(j.value,'__unassigned__') AS group_id,g.id_key,g.time FROM artwork_gallery_index g JOIN artwork_read_index i USING(id_key) LEFT JOIN json_each(g.facets,'$.characters') j ON 1", &mut covers)?.into_values().collect::<Vec<_>>();
    characters.sort_by(|a,b| {
        (a["id"] == "__unassigned__").cmp(&(b["id"] == "__unassigned__"))
            .then_with(|| b["count"].as_i64().cmp(&a["count"].as_i64()))
            .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
    });
    let mut albums = Vec::new();
    let mut stmt = c.db.prepare_cached("SELECT id_key,json_type(body,'$.smartRule') IS NOT NULL FROM projects ORDER BY id_key")?;
    let ids = stmt.query_map([], |r| Ok((r.get::<_,String>(0)?,r.get::<_,bool>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (id, smart) in ids {
        c.check_cancel()?;
        let value = if smart {
            let f = filter(c, &json!({"projectId":id}))?;
            let mut ids = Vec::new();
            for item in items(c, &f, 3)? {
                let record = &item["record"];
                ids.push(record["id"].clone());
                covers.insert(item["key"].as_str().unwrap().into(), record.clone());
            }
            json!({"id":id,"count":count(c,&f)?,"coverIds":ids})
        } else {
            manual.remove(&id).unwrap_or_else(|| json!({"id":id,"count":0,"coverIds":[]}))
        };
        albums.push(value);
    }
    let value = json!({"revision":revision,"projectsVersion":projects,"total":count(c,&Filter::default())?,
        "favoriteCount":count(c,&filter(c,&json!({"favoriteOnly":true}))?)?,"tags":buckets(c,"tags")?,"generation":generation,
        "albums":albums,"characters":characters,"covers":covers.into_values().collect::<Vec<_>>()});
    *c.gallery_catalog.borrow_mut() = Some(CatalogCache { revision, projects, value: value.clone() });
    Ok(value)
}
