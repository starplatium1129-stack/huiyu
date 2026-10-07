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
        "SELECT id_json,body -> '$.timestamp',revision
         FROM artworks WHERE deleted_at IS NULL ORDER BY id_key",
    )?;
    let mut rows = statement.query([])?;
    let mut items = Vec::new();
    let mut numeric: Vec<(f64, usize, Value)> = Vec::new();
    let mut ordinal = 0;
    while let Some(row) = rows.next()? {
        c.check_cancel()?;
        let timestamp: Value = match row.get_ref(1)? {
            rusqlite::types::ValueRef::Null => Value::Null,
            _ => serde_json::from_str(text_column(row, 1)?)?,
        };
        let id: Value = serde_json::from_str(text_column(row, 0)?)?;
        let revision = row.get::<_, i64>(2)?;
        let score = timestamp.as_f64().filter(|value| value.is_finite());
        // Keep row decoding/validation, but allocate a response object only
        // for retained candidates. Missing timestamps still project as null.
        let item = || {
            let mut item = json!({"timestamp":null,"id":null,"revision":revision});
            item["timestamp"] = timestamp;
            item["id"] = id;
            item
        };
        // artworkTimestamp uses numeric values directly, without Date clipping
        // or rounding. All other types retain browser Date/Number semantics.
        if let (Some(limit), Some(score)) = (limit, score) {
            // Equal timestamps follow earlier rows, retaining stable ties.
            let position = numeric.partition_point(|(previous, _, _)| *previous >= score);
            if position < limit {
                numeric.insert(position, (score, ordinal, item()));
                numeric.truncate(limit);
            }
        } else {
            items.push((ordinal, item()));
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
