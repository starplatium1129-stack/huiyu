use super::*;

pub(super) fn read(c: &Context, command: &Value) -> Result<Value> {
    let limit = command
        .get("candidateLimit")
        .map(|value| {
            value
                .as_u64()
                .filter(|limit| (1..=200).contains(limit))
                .map(|limit| limit as usize)
                .ok_or_else(|| invalid("Recent candidate limit must be 1–200"))
        })
        .transpose()?;
    let mut statement = c.db.prepare_cached(
        "SELECT id_json,json_object('timestamp',body -> '$.timestamp'),revision
         FROM artworks WHERE deleted_at IS NULL ORDER BY id_key",
    )?;
    let mut rows = statement.query([])?;
    let mut items = Vec::new();
    let mut numeric: Vec<(f64, usize, Value)> = Vec::new();
    let mut ordinal = 0;
    while let Some(row) = rows.next()? {
        c.check_cancel()?;
        let mut item: Value = serde_json::from_str(text_column(row, 1)?)?;
        item["id"] = serde_json::from_str(text_column(row, 0)?)?;
        item["revision"] = row.get::<_, i64>(2)?.into();
        // artworkTimestamp uses numeric values directly, without Date clipping
        // or rounding. All other types retain browser Date/Number semantics.
        if let (Some(limit), Some(timestamp)) = (
            limit,
            item["timestamp"].as_f64().filter(|value| value.is_finite()),
        ) {
            let position = numeric
                .iter()
                .position(|(score, _, _)| timestamp > *score)
                .unwrap_or(numeric.len());
            if position < limit {
                numeric.insert(position, (timestamp, ordinal, item));
                numeric.truncate(limit);
            }
        } else {
            items.push((ordinal, item));
        }
        ordinal += 1;
    }
    // A pruned numeric row already has `limit` numeric predecessors, so no
    // legacy timestamp interpretation can put it in the final top `limit`.
    // Restore the original id_key order for stable JavaScript sorting ties.
    if !numeric.is_empty() {
        items.extend(
            numeric
                .into_iter()
                .map(|(_, ordinal, item)| (ordinal, item)),
        );
        items.sort_by_key(|(ordinal, _)| *ordinal);
    }
    let mut result = json!({"items":null,"revision":c.revision()?});
    result["items"] = Value::Array(items.into_iter().map(|(_, item)| item).collect());
    Ok(result)
}
