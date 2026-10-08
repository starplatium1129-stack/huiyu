use super::*;

pub(super) fn read(c: &Context, command: &Value) -> Result<Value> {
    let limit = command
        .get("candidateLimit")
        .map(|value| {
            value
                .as_i64()
                .filter(|limit| (1..=200).contains(limit))
                .ok_or_else(|| invalid("Recent candidate limit must be 1–200"))
        })
        .transpose()?;
    artwork_index::refresh(c)?;
    let sql = if limit.is_some() {
        "SELECT id_json,timestamp_json,revision FROM (
            SELECT * FROM (SELECT id_key,id_json,timestamp_json,revision FROM artwork_read_index WHERE numeric_time IS NOT NULL
                ORDER BY numeric_time DESC,id_key LIMIT ?1)
            UNION ALL SELECT id_key,id_json,timestamp_json,revision FROM artwork_read_index WHERE numeric_time IS NULL
        ) ORDER BY id_key"
    } else {
        "SELECT id_json,timestamp_json,revision FROM artwork_read_index ORDER BY id_key"
    };
    let mut statement = c.db.prepare_cached(sql)?;
    let mut rows = if let Some(limit) = limit {
        statement.query([limit])?
    } else {
        statement.query([])?
    };
    let mut items = Vec::new();
    while let Some(row) = rows.next()? {
        c.check_cancel()?;
        items.push(json!({"id":serde_json::from_str::<Value>(text_column(row,0)?)?,
            "timestamp":serde_json::from_str::<Value>(text_column(row,1)?)?,"revision":row.get::<_,i64>(2)?}));
    }
    let mut result = json!({"items":null,"revision":c.revision()?});
    result["items"] = items.into();
    Ok(result)
}
