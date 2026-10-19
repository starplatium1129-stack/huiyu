use super::*;
use rusqlite::params;

#[derive(Default)]
pub(super) struct Memberships(BTreeMap<String, Option<Vec<String>>>);
impl Memberships {
    fn insert(&mut self, c: &Context, project: &str, key: &str, position: usize) -> Result<()> {
        if !self.0.contains_key(project) {
            let keys = if records::project_header(c, project)?
                .is_none_or(|row| row.smart)
            {
                None
            } else {
                let mut statement = c.db.prepare_cached(
                    "SELECT p.artwork_key,a.id_json,a.deleted_at FROM project_artworks p
                     LEFT JOIN artworks a ON a.id_key=p.artwork_key
                     WHERE p.project_key=? ORDER BY p.position",
                )?;
                let mut rows = statement.query([project])?;
                let mut keys = Vec::new();
                while let Some(row) = rows.next()? {
                    c.check_cancel()?;
                    // Check existing members now, before a later batch item
                    // could restore and conceal a previously broken membership.
                    if matches!(row.get_ref(1)?, rusqlite::types::ValueRef::Null)
                        || row.get::<_, Option<i64>>(2)?.is_some()
                    {
                        return Err(ApiError::new(
                            404,
                            "NOT_FOUND",
                            "Project artwork does not exist",
                        ));
                    }
                    let _ = records::json_column(row, 1)?;
                    keys.push(row.get::<_, String>(0)?);
                }
                Some(keys)
            };
            self.0.insert(project.into(), keys);
        }
        if let Some(keys) = self.0.get_mut(project).unwrap()
            && !keys.iter().any(|existing| existing == key)
        {
            keys.insert(position.min(keys.len()), key.into());
        }
        Ok(())
    }
    pub fn flush(self, c: &Context, revision: i64) -> Result<()> {
        for (project, keys) in self.0 {
            c.check_cancel()?;
            if let Some(keys) = keys {
                records::update_membership(c, &project, &keys, revision)?;
            }
        }
        Ok(())
    }
}
pub(super) fn restore(
    c: &Context,
    key: &str,
    revision: i64,
    memberships: &mut Memberships,
) -> Result<()> {
    let refs = {
        let mut statement = c.db.prepare_cached("SELECT snapshot,project_refs FROM trash WHERE artwork_key=?")?;
        let mut rows = statement.query([key])?;
        let row = rows.next()?
            .ok_or_else(|| conflict("WORKSPACE_IDENTITY", "Artwork trash snapshot is missing"))?;
        let snapshot = text_column(row, 0)?;
        let refs = records::json_column(row, 1)?;
        c.db.prepare_cached("UPDATE artworks SET body=?,deleted_at=NULL,revision=? WHERE id_key=?")?
            .execute(params![snapshot, revision, key])?;
        refs
    };
    c.db.prepare_cached(
        "UPDATE media_refs SET owner_kind='artwork' WHERE owner_kind='trash' AND owner_id=?",
    )?
    .execute([key])?;
    for reference in refs
        .as_array()
        .ok_or_else(|| invalid("Invalid trash project references"))?
    {
        c.check_cancel()?;
        memberships.insert(
            c,
            string(reference, "project_key")?,
            key,
            reference["position"].as_u64().unwrap_or(0) as usize,
        )?;
    }
    c.db.prepare_cached("DELETE FROM trash WHERE artwork_key=?")?
        .execute([key])?;
    Ok(())
}
