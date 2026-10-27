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

fn collect<'a>(value: &'a Value, aliases: &mut BTreeSet<&'a str>) {
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
                    aliases.insert(alias);
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
    // Profile snapshots also retain legacy localStorage JSON strings. Match
    // migration's reference validation without changing their persisted value.
    let parsed = value
        .as_str()
        .and_then(|value| serde_json::from_str::<Value>(value).ok());
    replace_decoded(c, domain, key, parsed.as_ref().unwrap_or(value))
}

// The save path shares this one-level decoding with credential validation.
// Do not parse another String layer: media reference discovery only owns one.
pub(super) fn replace_decoded(c: &Context, domain: &str, key: &str, value: &Value) -> Result<()> {
    let owner = owner(domain, key);
    let mut aliases = BTreeSet::new();
    collect(value, &mut aliases);
    let mut previous = BTreeSet::new();
    {
        let mut statement = c.db.prepare_cached(
            "SELECT hash FROM media_refs WHERE owner_kind='profile' AND owner_id=?",
        )?;
        let mut rows = statement.query([&owner])?;
        while let Some(row) = rows.next()? {
            c.check_cancel()?;
            previous.insert(row.get::<_, String>(0)?);
        }
    }
    // Always resolve current aliases, including aliases imported since the last
    // save. Compare hashes: different aliases may retain the same media object.
    let mut hashes = BTreeSet::new();
    let mut lookup =
        c.db.prepare_cached("SELECT hash FROM media_aliases WHERE alias=?")?;
    for alias in aliases {
        c.check_cancel()?;
        if let Some(hash) = lookup
            .query_row([alias], |row| row.get::<_, String>(0))
            .optional()?
        {
            hashes.insert(hash);
        }
    }
    if previous == hashes {
        return Ok(());
    }
    // Clearing a document still uses one DELETE, even for a large old archive.
    if hashes.is_empty() {
        c.check_cancel()?;
        c.db.execute(
            "DELETE FROM media_refs WHERE owner_kind='profile' AND owner_id=?",
            [&owner],
        )?;
        return Ok(());
    }
    let mut remove = c.db.prepare_cached(
        "DELETE FROM media_refs WHERE owner_kind='profile' AND owner_id=?1 AND hash=?2",
    )?;
    for hash in previous.difference(&hashes) {
        c.check_cancel()?;
        remove.execute(params![owner, hash])?;
    }
    let mut insert =
        c.db.prepare_cached("INSERT OR IGNORE INTO media_refs VALUES('profile',?1,?2)")?;
    for hash in hashes.difference(&previous) {
        c.check_cancel()?;
        insert.execute(params![owner, hash])?;
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
        let mut value: Value = serde_json::from_str(text_column(row, 2)?)?;
        if domain == "chat" && key == CHAT_ARCHIVE {
            value = super::archive::decode(&c.db, value)?;
        }
        if domain == "chat" && key == "aics_chat_v1" {
            value = super::messages::decode(&c.db, value)?;
        }
        replace(c, &domain, &key, &value)?;
    }
    Ok(())
}
