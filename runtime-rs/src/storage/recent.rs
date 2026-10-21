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
        .transpose()?.unwrap_or(3);
    artwork_index::refresh(c)?;
    let sql = "SELECT r.id_json,r.timestamp_json,r.revision FROM artwork_gallery_index g
            JOIN artwork_read_index r ON r.id_key=g.id_key ORDER BY g.time DESC,g.id_key LIMIT ?1";
    let mut statement = c.db.prepare_cached(sql)?;
    let mut rows = statement.query([limit])?;
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
