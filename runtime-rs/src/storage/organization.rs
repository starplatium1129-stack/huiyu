use super::*;
use canonical::entity_key;
use rusqlite::{OptionalExtension, params};
use std::collections::{BTreeSet, HashSet};

struct Member {
    key: String,
    position: Option<i64>,
    order: (u64, i64),
    live: bool,
}
struct Album {
    id: Option<Value>,
    rows: Vec<Member>,
    suffix: Option<usize>,
}
// The transaction owns virtual rows until one final rebuild. Order records the
// rowid order produced by each DELETE/INSERT, including effects on receipts.
#[derive(Default)]
struct Memberships {
    albums: HashMap<String, Album>,
    write: u64,
}
impl Memberships {
    fn album(&mut self, c: &Context, key: &str) -> Result<&mut Album> {
        if !self.albums.contains_key(key) {
            let id =
                c.db.prepare_cached("SELECT id_json FROM projects WHERE id_key=?")?
                    .query_row([key], |row| row.get::<_, String>(0))
                    .optional()?
                    .map(|id| serde_json::from_str(&id))
                    .transpose()?;
            let mut statement = c.db.prepare_cached(
                "SELECT r.artwork_key,r.position,r.rowid,a.id_key IS NOT NULL AND a.deleted_at IS NULL
                 FROM project_artworks r LEFT JOIN artworks a ON a.id_key=r.artwork_key
                 WHERE r.project_key=? ORDER BY r.position",
            )?;
            let mut rows = statement.query([key])?;
            let mut members = Vec::new();
            while let Some(row) = rows.next()? {
                c.check_cancel()?;
                members.push(Member {
                    key: row.get(0)?,
                    position: row.get::<_, i64>(1).ok(),
                    order: (0, row.get(2)?),
                    live: row.get(3)?,
                });
            }
            // Clean snapshots can be released. Dirty rows must stay until the
            // final flush; 8 MiB/32 albums is a soft limit, not a dirty-row cap.
            if self.albums.len() >= 32 || self
                .albums
                .iter()
                .map(|(key, album)| {
                    key.len()
                        + album.rows.capacity() * std::mem::size_of::<Member>()
                        + album
                            .rows
                            .iter()
                            .map(|row| row.key.capacity())
                            .sum::<usize>()
                })
                .sum::<usize>() > 8 * 1024 * 1024 {
                self.albums.retain(|_, album| album.suffix.is_some());
            }
            self.albums.insert(
                key.into(),
                Album {
                    id,
                    rows: members,
                    suffix: None,
                },
            );
        }
        Ok(self.albums.get_mut(key).unwrap())
    }
    fn references(&self, c: &Context, key: &str) -> Result<Vec<Value>> {
        let mut statement = c.db.prepare_cached(
            "SELECT p.id_json,r.position,r.project_key,r.rowid FROM project_artworks r
             LEFT JOIN projects p ON p.id_key=r.project_key WHERE r.artwork_key=?",
        )?;
        let mut rows = statement.query([key])?;
        let mut references = Vec::new();
        while let Some(row) = rows.next()? {
            let album: String = row.get(2)?;
            if self
                .albums
                .get(&album)
                .is_some_and(|album| album.suffix.is_some())
            {
                continue;
            }
            let id: Option<String> = row.get(0)?;
            let id = id
                .ok_or_else(|| conflict("MEMBERSHIP_INVALID", "Album membership is unavailable"))?;
            references.push(((0, row.get::<_, i64>(3)?), json!({"projectId":serde_json::from_str::<Value>(&id)?,"position":row.get::<_,i64>(1)?})));
        }
        for album in self.albums.values().filter(|album| album.suffix.is_some()) {
            if let Some(row) = album.rows.iter().find(|row| row.key == key) {
                references.push((
                    row.order,
                    json!({"projectId":album.id,"position":row.position}),
                ));
            }
        }
        // The reverse artwork index reads rowids in order. New suffix rows are
        // after all surviving rows, even when SQLite reuses deleted rowids.
        references.sort_unstable_by_key(|(order, _)| *order);
        Ok(references.into_iter().map(|(_, value)| value).collect())
    }
    fn replace(&mut self, c: &Context, album: &str, key: &str, previous: Option<usize>, next: Option<usize>) -> Result<()> {
        let write = self.write + 1;
        let current = self.album(c, album)?;
        if previous == next || current.id.is_none() {
            return Ok(());
        }
        let new = Member {
            key: key.into(),
            position: None,
            order: (write, 0),
            live: true,
        };
        let mut keys: Vec<_> = current.rows.iter().filter(|row| row.key != key).collect();
        if let Some(position) = next {
            keys.insert(position, &new);
        }
        let mut prefix = 0;
        for row in &current.rows {
            if row.position != Some(prefix as i64) {
                prefix = 0;
                break;
            }
            if keys.get(prefix).is_none_or(|next| next.key != row.key) {
                break;
            }
            prefix += 1;
        }
        // Check every virtually inserted suffix now, so a later removal cannot
        // hide the failure that the sequential writer would have encountered.
        if keys.iter().skip(prefix).any(|row| !row.live) {
            return Err(ApiError::new(
                404,
                "NOT_FOUND",
                "Project artwork does not exist",
            ));
        }
        drop(keys);
        let moved = previous
            .map(|position| current.rows.remove(position))
            .unwrap_or(new);
        if let Some(position) = next {
            current.rows.insert(position, moved);
        }
        for (position, row) in current.rows.iter_mut().enumerate().skip(prefix) {
            row.position = Some(position as i64);
            row.order = (write, position as i64);
        }
        current.suffix = Some(current.suffix.map_or(prefix, |old| old.min(prefix)));
        self.write = write;
        Ok(())
    }
    fn flush(&self, c: &Context) -> Result<()> {
        let mut rows = Vec::new();
        for (key, album) in &self.albums {
            if let Some(prefix) = album.suffix {
                c.check_cancel()?;
                records::truncate_membership(c, key, prefix)?;
                rows.extend(
                    album
                        .rows
                        .iter()
                        .enumerate()
                        .skip(prefix)
                        .map(|(position, row)| (key, position, row)),
                );
            }
        }
        // Delete each album suffix once, then insert surviving rows in global
        // write order. Flushing whole albums in turn would reorder references.
        rows.sort_unstable_by_key(|(_, _, row)| row.order);
        let mut insert = c.db.prepare_cached(records::MEMBERSHIP_INSERT)?;
        for (key, position, row) in rows {
            c.check_cancel()?;
            if insert.execute(params![key, position as i64, row.key])? != 1 {
                return Err(ApiError::new(
                    404,
                    "NOT_FOUND",
                    "Project artwork does not exist",
                ));
            }
        }
        Ok(())
    }
}

fn field(body: &Value, name: &str) -> Value {
    match body.get(name) {
        Some(value) => json!({"present":true,"value":value}),
        None => json!({"present":false}),
    }
}

fn state(
    c: &Context,
    art: &Value,
    project: bool,
    tags: bool,
    members: &Memberships,
) -> Result<Value> {
    let mut value = json!({});
    if project {
        value["project"] = field(&art["body"], "project");
        value["memberships"] = Value::Array(members.references(c, &entity_key(&art["id"])?)?);
    }
    if tags {
        value["collectionTags"] = field(&art["body"], "collectionTags");
    }
    Ok(value)
}

fn tag_list(value: Option<&Value>) -> Result<Vec<String>> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let items = value
        .as_array()
        .filter(|items| items.len() <= 64)
        .ok_or_else(|| invalid("Collection tags must be an array of at most 64 strings"))?;
    let mut tags = Vec::new();
    for value in items {
        let tag = value
            .as_str()
            .map(str::trim)
            .filter(|tag| !tag.is_empty() && tag.chars().count() <= 64)
            .ok_or_else(|| invalid("Collection tags must contain 1–64 characters"))?;
        if !tags.iter().any(|old| old == tag) {
            tags.push(tag.to_owned());
        }
    }
    Ok(tags)
}

fn replace_memberships(
    c: &Context,
    key: &str,
    before: &[Value],
    references: &[Value],
    members: &mut Memberships,
    affected: &mut BTreeSet<String>,
) -> Result<()> {
    let albums = before
        .iter()
        .chain(references)
        .map(|reference| entity_key(&reference["projectId"]))
        .collect::<Result<BTreeSet<_>>>()?;
    for album in albums {
        let current = members.album(c, &album)?;
        let previous = current.rows.iter().position(|row| row.key == key);
        let remaining = current.rows.len() - usize::from(previous.is_some());
        let next = if let Some(reference) = references
            .iter()
            .find(|reference| entity_key(&reference["projectId"]).is_ok_and(|value| value == album))
        {
            let position = reference["position"]
                .as_u64()
                .ok_or_else(|| invalid("Album position is invalid"))?;
            let position = (position as usize).min(remaining);
            Some(position)
        } else {
            None
        };
        if previous != next {
            members.replace(c, &album, key, previous, next)?;
            affected.insert(album);
        }
    }
    Ok(())
}

fn organize(c: &Context, command: &Value, revision: i64) -> Result<Vec<Value>> {
    let ids = command["ids"]
        .as_array()
        .filter(|items| !items.is_empty() && items.len() <= 200)
        .ok_or_else(|| invalid("Artwork organization must contain 1–200 IDs"))?;
    let keys = ids.iter().map(entity_key).collect::<Result<Vec<_>>>()?;
    if keys.iter().collect::<HashSet<_>>().len() != keys.len() {
        return Err(invalid("Artwork IDs must be unique"));
    }
    let expected = command["expectedRevisions"]
        .as_array()
        .filter(|items| items.len() == ids.len())
        .ok_or_else(|| invalid("Expected artwork revisions are required"))?;
    // Keep the original first valid matching entry, including its revision
    // value. Invalid or repeated IDs retain the same per-artwork rejection.
    let mut revisions = HashMap::new();
    for row in expected {
        if let Ok(key) = entity_key(&row["id"]) {
            revisions.entry(key).or_insert(row);
        }
    }
    let project_change = command.get("projectId").is_some();
    let project = match command.get("projectId") {
        None | Some(Value::Null) => None,
        Some(id) => Some(
            records::project_header(c, &entity_key(id)?)?
                .ok_or_else(|| ApiError::new(404, "NOT_FOUND", "Album no longer exists"))?,
        ),
    };
    if project
        .as_ref()
        .is_some_and(|row| row.smart)
    {
        return Err(invalid(
            "Smart albums collect artwork by conditions; edit the album rule",
        ));
    }
    let tags_change = command.get("collectionTags").is_some();
    if tags_change && !command["collectionTags"].is_object() {
        return Err(invalid("Collection tag changes must be an object"));
    }
    let add = tag_list(command["collectionTags"].get("add"))?;
    let remove = tag_list(command["collectionTags"].get("remove"))?;
    if !project_change && add.is_empty() && remove.is_empty() {
        return Err(invalid("No organization changes were requested"));
    }
    let mut changes = Vec::new();
    let mut affected = BTreeSet::new();
    let mut members = Memberships::default();
    for key in keys {
        c.check_cancel()?;
        let mut art = records::artwork(c, &key)?
            .filter(|row| row["deletedAt"].is_null())
            .ok_or_else(|| ApiError::new(404, "NOT_FOUND", "Artwork no longer exists"))?;
        let expected = revisions
            .get(&key)
            .ok_or_else(|| invalid("Artwork expected revision is missing"))?;
        if expected["revision"] != art["revision"] {
            return Err(conflict(
                "REVISION_CONFLICT",
                "Artwork has a newer revision",
            ));
        }
        let before = state(c, &art, project_change, tags_change, &members)?;
        if project_change {
            let refs = if let Some(project) = &project {
                let project_key = entity_key(&project.id)?;
                let target = members.album(c, &project_key)?;
                let position = target
                    .rows
                    .iter()
                    .position(|row| row.key == key)
                    .unwrap_or(target.rows.len());
                // The recipe project field is text; album IDs retain their
                // original JSON type in project rows and membership arrays.
                art["body"]["project"] = json!(project_key);
                vec![json!({"projectId":project.id,"position":position})]
            } else {
                art["body"]
                    .as_object_mut()
                    .ok_or_else(|| invalid("Artwork body is invalid"))?
                    .remove("project");
                Vec::new()
            };
            replace_memberships(c, &key, before["memberships"].as_array().unwrap(), &refs, &mut members, &mut affected)?;
        }
        if tags_change {
            let mut tags: Vec<String> = art["body"]["collectionTags"]
                .as_array()
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|tag| !tag.is_empty() && !remove.iter().any(|old| old == tag))
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            for tag in &add {
                if !tags.contains(tag) {
                    tags.push(tag.clone());
                }
            }
            let mut seen = HashSet::new();
            tags.retain(|tag| seen.insert(tag.clone()));
            if tags.len() > 64 {
                return Err(invalid("An artwork can have at most 64 collection tags"));
            }
            art["body"]["collectionTags"] = json!(tags);
        }
        let after = state(c, &art, project_change, tags_change, &members)?;
        if before != after {
            c.db.execute(
                "UPDATE artworks SET body=?,revision=? WHERE id_key=?",
                params![stringify(&art["body"]), revision, key],
            )?;
            let mut change = json!({"id":art["id"],"before":null,"after":null});
            change["before"] = before;
            change["after"] = after;
            changes.push(change);
        }
    }
    members.flush(c)?;
    for album in affected {
        records::refresh_membership(c, &album, revision)?;
    }
    Ok(changes)
}

fn same_albums(a: &[Value], b: &[Value]) -> Result<bool> {
    let keys = |values: &[Value]| {
        values
            .iter()
            .map(|value| entity_key(&value["projectId"]))
            .collect::<Result<BTreeSet<_>>>()
    };
    Ok(keys(a)? == keys(b)?)
}

fn undo(c: &Context, principal: &str, command: &Value, revision: i64) -> Result<Value> {
    let source = c
        .operation(principal, string(command, "sourceOperationId")?)?
        .filter(|row| row.kind == "organizeArtworks" && row.state == "committed")
        .and_then(|row| row.receipt)
        .ok_or_else(|| conflict("UNDO_UNAVAILABLE", "Organization receipt is unavailable"))?;
    let changes = source["changes"]
        .as_array()
        .ok_or_else(|| conflict("UNDO_UNAVAILABLE", "Organization receipt is invalid"))?;
    let mut affected = BTreeSet::new();
    let mut members = Memberships::default();
    let mut restored = 0;
    let mut skipped = 0;
    for change in changes.iter().rev() {
        c.check_cancel()?;
        let key = entity_key(&change["id"])?;
        let Some(mut art) = records::artwork(c, &key)?.filter(|row| row["deletedAt"].is_null())
        else {
            skipped += 1;
            continue;
        };
        let after = &change["after"];
        let before = &change["before"];
        let changed_field = ["project", "collectionTags"].iter().any(|name| {
            after
                .get(name)
                .is_some_and(|value| field(&art["body"], name) != *value)
        });
        let current_refs = after.get("memberships").and_then(Value::as_array)
            .map(|_| members.references(c, &key)).transpose()?;
        let changed_memberships = match after.get("memberships").and_then(Value::as_array) {
            Some(refs) => !same_albums(current_refs.as_deref().unwrap(), refs)?,
            None => false,
        };
        let old_refs = before.get("memberships").and_then(Value::as_array);
        let missing_album = old_refs.is_some_and(|refs| {
            refs.iter().any(|reference| {
                entity_key(&reference["projectId"])
                    .and_then(|key| records::project_header(c, &key))
                    .is_ok_and(|project| project.is_none())
            })
        });
        if changed_field || changed_memberships || missing_album {
            skipped += 1;
            continue;
        }
        for name in ["project", "collectionTags"] {
            if let Some(previous) = before.get(name) {
                if previous["present"] == true {
                    art["body"][name] = previous["value"].clone();
                } else {
                    art["body"]
                        .as_object_mut()
                        .ok_or_else(|| invalid("Artwork body is invalid"))?
                        .remove(name);
                }
            }
        }
        if let Some(refs) = old_refs {
            let current = match current_refs {
                Some(current) => current,
                None => members.references(c, &key)?,
            };
            replace_memberships(c, &key, &current, refs, &mut members, &mut affected)?;
        }
        c.db.execute(
            "UPDATE artworks SET body=?,revision=? WHERE id_key=?",
            params![stringify(&art["body"]), revision, key],
        )?;
        restored += 1;
    }
    members.flush(c)?;
    for album in affected {
        records::refresh_membership(c, &album, revision)?;
    }
    Ok(json!({"restored":restored,"skipped":skipped}))
}

pub(super) fn execute(c: &mut Context, principal: &str, command: &Value) -> Result<Value> {
    c.transaction(|c| {
        let (operation, previous) = c.start_operation(principal, command)?;
        if let Some(receipt) = previous {
            return Ok(receipt);
        }
        let revision = c.next_revision()?;
        let kind = string(command, "kind")?;
        let mut receipt = json!({});
        match kind {
            "organizeArtworks" => receipt["changes"] = Value::Array(organize(c, command, revision)?),
            "undoArtworkOrganization" => receipt = undo(c, principal, command, revision)?,
            _ => return Err(invalid("Unknown artwork organization command")),
        };
        receipt["operationId"] = command["operationId"].clone();
        receipt["kind"] = json!(kind);
        receipt["revision"] = json!(revision);
        c.commit_operation(&operation, &receipt)?;
        Ok(receipt)
    })
}
