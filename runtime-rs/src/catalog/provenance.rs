use super::*;

pub(super) fn same(left: &Record, right: &Record) -> bool {
    left.data == right.data && left.sort_order == right.sort_order
}

/// Local revisions cannot be compared across databases. An export may advance a
/// target only when its content is a known ancestor/default of this authority.
pub(super) fn export_ancestor(
    connection: &Connection,
    previous: &Record,
    was_removed: bool,
    incoming: &Record,
    removed: bool,
) -> Result<()> {
    if same(previous, incoming) && was_removed == removed {
        return Ok(());
    }
    if !was_removed || removed {
        let mut history = connection.prepare_cached(
            "SELECT record,deleted FROM content_history WHERE kind=?1 AND id=?2 AND revision<=?3",
        )?;
        let mut rows = history.query(params![incoming.kind, incoming.id, incoming.revision])?;
        while let Some(row) = rows.next()? {
            let record: Record = serde_json::from_str(text_column(row, 0)?)?;
            if same(previous, &record) && was_removed == row.get::<_, bool>(1)? {
                return Ok(());
            }
        }
        let seed: Option<(String, bool)> = connection
            .query_row(
                "SELECT record,deleted FROM content_seed WHERE kind=?1 AND id=?2",
                params![incoming.kind, incoming.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((record, deleted)) = seed {
            let record: Record = serde_json::from_str(&record)?;
            if same(previous, &record) && was_removed == deleted {
                return Ok(());
            }
        }
    }
    Err(ApiError::new(
        409,
        "CATALOG_EXPORT_CONFLICT",
        format!(
            "不能覆盖来源不一致或较新的项目记录 {}:{}；目标不是本工作库的已知历史，请先比较并合并后再导出",
            incoming.kind, incoming.id,
        ),
    ))
}

/// Bundle records share a previously accepted upstream baseline. This checks
/// upstream metadata, never the user's independent local revision counter.
pub(super) fn seed_update(connection: &Connection, incoming: &Record, removed: bool) -> Result<()> {
    let seed: Option<(String, bool)> = connection
        .query_row(
            "SELECT record,deleted FROM content_seed WHERE kind=?1 AND id=?2",
            params![incoming.kind, incoming.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((encoded, deleted)) = seed else {
        return Ok(());
    };
    let before: Record = serde_json::from_str(&encoded)?;
    let changed = !same(&before, incoming) || deleted != removed;
    let timestamp = |record: &Record| -> Result<Option<chrono::DateTime<chrono::FixedOffset>>> {
        record
            .updated_at
            .as_deref()
            .map(chrono::DateTime::parse_from_rfc3339)
            .transpose()
            .map_err(|_| ApiError::invalid("快照 updatedAt 不是有效的 RFC3339 时间"))
    };
    let before_time = timestamp(&before)?;
    let next_time = timestamp(incoming)?;
    let stale = incoming.revision < before.revision
        || (incoming.revision == before.revision && changed)
        || (before_time.is_some() && next_time < before_time);
    if stale {
        return Err(ApiError::new(
            409,
            "CATALOG_SNAPSHOT_STALE",
            format!(
                "快照回退被拒绝 {}:{}：传入修订 {}，已接收的上游修订 {}；请从正确工作库重新导出，个人内容和原基线均未改写",
                incoming.kind, incoming.id, incoming.revision, before.revision,
            ),
        ));
    }
    Ok(())
}

pub(super) fn export_pins(record: &Record, policy: &Path) -> Result<()> {
    if record.kind != "document" || record.id != "prompt-pinned-scenes" {
        return Ok(());
    }
    let canonical: Value = serde_json::from_slice(&std::fs::read(policy)?)?;
    if record.data != canonical {
        return Err(ApiError::new(
            409,
            "CATALOG_PIN_CONFLICT",
            "导出拒绝覆盖定稿保护基线；工作库与 pin-capture 基线不一致，请先恢复或按单条定稿流程核对",
        ));
    }
    Ok(())
}
