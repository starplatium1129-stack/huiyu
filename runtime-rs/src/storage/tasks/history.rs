use super::*;

pub(super) fn read(c: &Context, principal: &str) -> Result<Value> {
    let mut query = c.db.prepare_cached("SELECT i.migration_id,i.body FROM migration_items i JOIN migration_sessions s ON s.migration_id=i.migration_id
        WHERE s.principal_id=? AND s.state IN ('verified','activated') AND json_extract(i.body,'$.domain')='history'
        AND json_extract(i.body,'$.key')='aics_task_center_v1' ORDER BY s.revision,i.item_id")?;
    let mut rows = query.query([principal])?;
    let mut snapshots = Vec::new();
    let mut indices = std::collections::HashMap::<String, usize>::new();
    let mut groups: Vec<Vec<(f64, Value)>> = Vec::new();
    while let Some(row) = rows.next()? {
        c.check_cancel()?;
        let migration: String = row.get(0)?;
        let mut body: Value = serde_json::from_str(text_column(row, 1)?)?;
        let index = body["index"].as_f64();
        let mut value = body.get_mut("value").map(Value::take).unwrap_or_default();
        if let Some(text) = value.as_str() {
            let Ok(decoded) = serde_json::from_str(text) else {
                continue;
            };
            value = decoded;
        }
        if let Some(index) = index {
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
    let mut result = json!({"snapshots": null});
    result["snapshots"] = Value::Array(snapshots);
    Ok(result)
}
