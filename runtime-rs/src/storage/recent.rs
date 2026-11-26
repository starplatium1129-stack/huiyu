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
        .transpose()?
        .unwrap_or(3);
    artwork_index::refresh(c)?;
    let records = command["projection"] == "records";
    let sql = if records {
        "SELECT r.id_json,r.timestamp_json,r.revision,a.body FROM artwork_gallery_index g
         JOIN artwork_read_index r ON r.id_key=g.id_key
         JOIN artworks a ON a.id_key=g.id_key AND a.deleted_at IS NULL
         ORDER BY g.time DESC,g.id_key LIMIT ?1"
    } else {
        "SELECT r.id_json,r.timestamp_json,r.revision FROM artwork_gallery_index g
         JOIN artwork_read_index r ON r.id_key=g.id_key ORDER BY g.time DESC,g.id_key LIMIT ?1"
    };
    let mut statement = c.db.prepare_cached(sql)?;
    let mut rows = statement.query([limit])?;
    let mut items = Vec::new();
    while let Some(row) = rows.next()? {
        c.check_cancel()?;
        let mut item = json!({"id":null,"timestamp":null,"revision":row.get::<_,i64>(2)?});
        item["id"] = super::records::json_column(row, 0)?;
        item["timestamp"] = super::records::json_column(row, 1)?;
        if records {
            item["body"] = super::records::json_column(row, 3)?;
            item["deletedAt"] = Value::Null;
        }
        items.push(item);
    }
    let mut result = json!({"items":null,"revision":c.revision()?});
    result["items"] = items.into();
    Ok(result)
}
