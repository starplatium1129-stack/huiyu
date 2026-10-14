use super::*;
use canonical::digest;
use std::collections::BTreeSet;

pub(in crate::storage) const ALIAS_FIELDS: &[&str] = &[
    "image_id",
    "imageId",
    "firstFrameImageId",
    "lastFrameImageId",
    "sourceImageId",
    "videoImageId",
];

fn owner(domain: &str, key: &str) -> String {
    digest(stringify(&json!([domain, key])))
}

fn collect(value: &Value, aliases: &mut BTreeSet<String>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect(item, aliases);
            }
        }
        Value::Object(fields) => {
            for (key, value) in fields {
                if ALIAS_FIELDS.contains(&key.as_str())
                    && let Some(alias) = value.as_str().filter(|alias| !alias.is_empty())
                {
                    aliases.insert(alias.into());
                } else {
                    collect(value, aliases);
                }
            }
        }
        _ => {}
    }
}

pub(in crate::storage) fn replace(
    c: &Context,
    domain: &str,
    key: &str,
    value: &Value,
) -> Result<()> {
    let owner = owner(domain, key);
    let mut aliases = BTreeSet::new();
    // Profile snapshots also retain legacy localStorage JSON strings. Match
    // migration's reference validation without changing their persisted value.
    let parsed = value
        .as_str()
        .and_then(|value| serde_json::from_str::<Value>(value).ok());
    collect(parsed.as_ref().unwrap_or(value), &mut aliases);
    c.db.execute(
        "DELETE FROM media_refs WHERE owner_kind='profile' AND owner_id=?",
        [&owner],
    )?;
    let mut insert = c.db.prepare_cached(
        "INSERT OR IGNORE INTO media_refs SELECT 'profile',?1,hash FROM media_aliases WHERE alias=?2",
    )?;
    for alias in aliases {
        c.check_cancel()?;
        insert.execute(params![owner, alias])?;
    }
    Ok(())
}

pub(in crate::storage) fn remove(c: &Context, domain: &str, key: &str) -> Result<()> {
    c.db.execute(
        "DELETE FROM media_refs WHERE owner_kind='profile' AND owner_id=?",
        [owner(domain, key)],
    )?;
    Ok(())
}

pub(in crate::storage) fn clear_domain(c: &Context, domain: &str) -> Result<()> {
    let mut keys =
        c.db.prepare_cached("SELECT record_key FROM profile_records WHERE domain=?")?;
    let mut rows = keys.query([domain])?;
    while let Some(row) = rows.next()? {
        c.check_cancel()?;
        remove(c, domain, &row.get::<_, String>(0)?)?;
    }
    Ok(())
}

pub(in crate::storage) fn refresh_all(c: &Context) -> Result<()> {
    let mut statement =
        c.db.prepare_cached("SELECT domain,record_key,body FROM profile_records")?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        c.check_cancel()?;
        let domain = row.get::<_, String>(0)?;
        let key = row.get::<_, String>(1)?;
        let value: Value = serde_json::from_str(text_column(row, 2)?)?;
        replace(c, &domain, &key, &value)?;
    }
    Ok(())
}
