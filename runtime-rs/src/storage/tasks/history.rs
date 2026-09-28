use super::*;

pub(super) fn read(c: &Context, principal: &str) -> Result<Value> {
    let mut query = c.db.prepare_cached("SELECT i.migration_id,i.body FROM migration_items i JOIN migration_sessions s ON s.migration_id=i.migration_id
        WHERE s.principal_id=? AND s.state IN ('verified','activated') AND json_extract(i.body,'$.domain')='history'
        AND json_extract(i.body,'$.key')='aics_task_center_v1' ORDER BY s.revision,i.item_id")?;
    let rows = query.query_map([principal], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut snapshots = Vec::new();
    let mut indices = std::collections::HashMap::<String, usize>::new();
    let mut groups: Vec<Vec<(f64, Value)>> = Vec::new();
    for row in rows {
        let (migration, body) = row?;
        let body: Value = serde_json::from_str(&body)?;
        let mut value = body["value"].clone();
        if let Some(text) = value.as_str() {
            let Ok(decoded) = serde_json::from_str(text) else {
                continue;
            };
            value = decoded;
        }
        if let Some(index) = body["index"].as_f64() {
            let group = *indices.entry(migration).or_insert_with(|| {
                groups.push(Vec::new());
                groups.len() - 1
            });
            groups[group].push((index, value));
        } else {
            snapshots.push(value);
        }
    }
    for mut group in groups {
        group.sort_by(|a, b| a.0.total_cmp(&b.0));
        snapshots.push(Value::Array(
            group.into_iter().map(|(_, value)| value).collect(),
        ));
    }
    Ok(json!({"snapshots": snapshots}))
}
