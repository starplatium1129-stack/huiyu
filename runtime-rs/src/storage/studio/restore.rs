use super::*;

/// Imported metadata lives in the artwork authority. Media and metadata are promoted in the
/// candidate workspace's existing verification transaction, before migration leases are removed.
pub(in crate::storage) fn restore_records(c: &Context, records: &[Value]) -> Result<()> {
    let entries = |key: &'static str| {
        records
            .iter()
            .filter(move |row| row["domain"] == "studio" && row["key"] == key)
            .map(|row| &row["value"])
    };
    for project in entries("huiyu:studio:projects") {
        c.check_cancel()?;
        let key = id(project, "id")?;
        text(project, "title", 160, false)?;
        positive(project, "revision")?;
        document(&project["workbench"], 262_144)?;
        c.db.execute(
            "INSERT INTO studio_projects VALUES(?,?)",
            params![key, stringify(project)],
        )?;
    }
    for asset in entries("huiyu:studio:assets") {
        c.check_cancel()?;
        let key = id(asset, "id")?;
        text(asset, "title", 160, false)?;
        positive(asset, "revision")?;
        if !matches!(
            asset["kind"].as_str(),
            Some("character" | "outfit" | "expression" | "pose" | "scene" | "keyframe" | "audio" | "clip")
        ) {
            return Err(invalid("迁移素材种类无效"));
        }
        c.db.execute(
            "INSERT INTO studio_assets VALUES(?,?)",
            params![key, stringify(asset)],
        )?;
    }
    for version in entries("huiyu:studio:versions") {
        c.check_cancel()?;
        insert_version(c, version)?;
    }
    for version in entries("huiyu:studio:versions") {
        origin_refs(c, &version["source"])?;
    }
    for asset in entries("huiyu:studio:assets") {
        let (count, max): (i64, Option<i64>) = c.db.query_row(
            "SELECT COUNT(*),MAX(number) FROM studio_versions WHERE asset_id=?",
            [id(asset, "id")?],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if Some(count) != max || count != positive(asset, "revision")? {
            return Err(invalid("迁移素材版本不完整"));
        }
    }
    for shot in entries("huiyu:studio:shots") {
        c.check_cancel()?;
        insert_shot(c, shot)?;
    }
    Ok(())
}
