use super::*;

fn same_albums(a: &[Value], b: &[Value]) -> Result<bool> {
    let keys = |values: &[Value]| {
        values
            .iter()
            .map(|value| entity_key(&value["projectId"]))
            .collect::<Result<BTreeSet<_>>>()
    };
    Ok(keys(a)? == keys(b)?)
}

pub(super) fn undo(c: &Context, principal: &str, command: &Value, revision: i64) -> Result<Value> {
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
        let current_refs = after
            .get("memberships")
            .and_then(Value::as_array)
            .map(|_| members.references(c, &key))
            .transpose()?;
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
