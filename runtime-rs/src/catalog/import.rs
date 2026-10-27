use super::*;
fn same(left: &Record, right: &Record) -> bool {
    left.data == right.data && left.sort_order == right.sort_order
}
impl Catalog {
    pub fn import(&mut self, snapshot: &Value, preview: bool) -> Result<Value> {
        self.import_with_policy(snapshot, preview, false)
    }
    pub(super) fn import_with_policy(
        &mut self,
        snapshot: &Value,
        preview: bool,
        preserve_local: bool,
    ) -> Result<Value> {
        if snapshot["version"] != 1 {
            return Err(ApiError::invalid("快照版本无效"));
        }
        let records = Vec::<Record>::deserialize(&snapshot["records"])?;
        let retired = match snapshot.get("retired") {
            Some(value) => Vec::<Record>::deserialize(value)?,
            None => Vec::new(),
        };
        if records.is_empty() && retired.is_empty() {
            return Err(ApiError::invalid("快照不能为空"));
        }
        let mut changes = Vec::new();
        let mut preserved = Vec::new();
        let seeds = records
            .into_iter()
            .map(|r| (r, false))
            .chain(retired.into_iter().map(|r| (r, true)))
            .collect::<Vec<_>>();
        let mut seen = std::collections::HashSet::new();
        let read = self.connection.unchecked_transaction()?;
        let mut current_query = read.prepare_cached(&format!(
            "SELECT {COLUMNS},deleted FROM content_records WHERE kind=?1 AND id=?2"
        ))?;
        let mut seed_query =
            read.prepare_cached("SELECT record,deleted FROM content_seed WHERE kind=?1 AND id=?2")?;
        for (incoming, removed) in &seeds {
            let removed = *removed;
            validation::key(&incoming.kind, &incoming.id)?;
            if !seen.insert((&incoming.kind, &incoming.id)) {
                return Err(ApiError::invalid("快照记录重复"));
            }
            let current = current_query
                .query_row(params![incoming.kind, incoming.id], |r| {
                    Ok((row(r)?, r.get::<_, bool>(7)?))
                })
                .optional()?;
            let base = seed_query
                .query_row(params![incoming.kind, incoming.id], |r| {
                    Ok((
                        serde_json::from_str::<Record>(text_column(r, 0)?),
                        r.get::<_, bool>(1)?,
                    ))
                })
                .optional()?
                .map(|(record, removed)| record.map(|record| (record, removed)))
                .transpose()?;
            let equal = current
                .as_ref()
                .is_some_and(|(r, old_removed)| same(r, incoming) && *old_removed == removed);
            let untouched = !equal
                && current.as_ref().zip(base.as_ref()).is_some_and(
                    |((r, old_removed), (b, base_removed))| {
                        same(r, b) && old_removed == base_removed
                    },
                );
            let incoming_unchanged = !equal
                && base
                    .as_ref()
                    .is_some_and(|(b, base_removed)| same(b, incoming) && *base_removed == removed);
            // Preserve the complete local record, including metadata, on repeat
            // imports too. The original incoming record remains the new seed;
            // a local record must never be mistaken for the upstream baseline.
            if preserve_local
                && !equal
                && !untouched
                && let Some(current) = current
            {
                preserved.push(current);
                continue;
            }
            let created_at = current
                .as_ref()
                .filter(|(r, _)| r.created_at.is_none())
                .and(incoming.created_at.clone());
            if !equal && !incoming_unchanged {
                if current.is_some() && !untouched {
                    return Err(ApiError::new(
                        409,
                        "CATALOG_IMPORT_CONFLICT",
                        format!(
                            "导入与本地修改冲突：{}:{}；本地内容保留，请先比较后合并",
                            incoming.kind, incoming.id
                        ),
                    ));
                }
                if current.as_ref().is_some_and(|(_, removed)| *removed) {
                    return Err(ApiError::invalid("快照不能重新启用已退役身份"));
                }
                changes.push(Change {
                    kind: incoming.kind.clone(),
                    id: incoming.id.clone(),
                    expected_revision: current.as_ref().map_or(0, |(r, _)| r.revision),
                    data: Some(incoming.data.clone()),
                    patch: None,
                    sort_order: Some(incoming.sort_order),
                    created_at,
                    remove: removed,
                });
            } else if created_at.is_some() && current.as_ref().is_some_and(|(_, removed)| !*removed)
            {
                let record = current.unwrap().0;
                changes.push(Change {
                    kind: record.kind,
                    id: record.id,
                    expected_revision: record.revision,
                    data: Some(record.data),
                    patch: None,
                    sort_order: None,
                    created_at,
                    remove: false,
                });
            }
        }
        drop(current_query);
        drop(seed_query);
        read.commit()?;
        self.apply_with_seeds(&changes, preview, &seeds, &preserved)
    }
}
