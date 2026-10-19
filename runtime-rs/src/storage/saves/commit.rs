use super::*;

pub(in crate::storage) enum Prepared {
    Complete(Value),
    Verify(Publication),
}

pub(in crate::storage) struct Publication {
    pub key: String,
    pub media: Value,
    principal: String,
    target: Target,
}

enum Target {
    Save {
        row: Operation,
        library: bool,
        lease_created: i64,
    },
    Append(Value),
}

fn check_append_replay(c: &Context, command: &Value) -> Result<()> {
    let artwork = &command["artwork"];
    let key = entity_key(&artwork["id"])?;
    let alias = string(artwork, "image_id")?;
    // The immutable receipt proves the old append, not the current visibility.
    // Read only the indexed row's deletion state and media identity.
    let current: Option<(Option<i64>, Option<String>)> =
        c.db.prepare_cached(
            "SELECT deleted_at,json_extract(body,'$.image_id') FROM artworks WHERE id_key=?",
        )?
        .query_row([key], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()?;
    let Some((deleted_at, current_alias)) = current else {
        return Err(conflict(
            "ARTWORK_NOT_LIVE",
            "Previously committed artwork no longer exists",
        ));
    };
    if deleted_at.is_some() {
        return Err(conflict(
            "ARTWORK_NOT_LIVE",
            "Previously committed artwork is in trash; restore it before saving",
        ));
    }
    if current_alias.as_deref() != Some(alias) {
        return Err(conflict(
            "OPERATION_CONFLICT",
            "Previously committed artwork identifies different media",
        ));
    }
    Ok(())
}

fn lease(c: &Context, key: &str, hash: &str) -> Result<i64> {
    let row: Option<(String, Option<String>, Option<String>, i64)> =
        c.db.query_row(
            "SELECT kind,hash,operation_key,created_at FROM leases WHERE id=?",
            [key],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((kind, stored_hash, operation, created)) = row else {
        return Err(conflict(
            "OPERATION_CONFLICT",
            "Media preparation lease is missing",
        ));
    };
    if kind != "staging"
        || stored_hash.as_deref() != Some(hash)
        || operation.as_deref() != Some(key)
    {
        return Err(conflict(
            "OPERATION_CONFLICT",
            "Media preparation lease changed",
        ));
    }
    Ok(created)
}

fn insert_artwork(c: &Context, key: &str, body: &Value, revision: i64) -> Result<Value> {
    // Return the persisted encoding (including ECMAScript number normalization)
    // in the insert itself, without another lookup of the same large body.
    Ok(c.db
        .prepare_cached(
            "INSERT INTO artworks VALUES(?,?,?,?,NULL) RETURNING id_json,body,revision,deleted_at",
        )?
        .query_row(
            params![key, stringify(&body["id"]), stringify(body), revision],
            records::decode_artwork,
        )?)
}

pub(in crate::storage) fn prepare(
    c: &mut Context,
    principal: &str,
    command: Value,
) -> Result<Prepared> {
    c.check_cancel()?;
    if principal.is_empty() {
        return Err(ApiError::new(
            401,
            "UNAUTHORIZED",
            "Desktop principal is required",
        ));
    }
    c.writer()?;
    c.owner.check()?;
    let id = string(&command, "operationId")?;
    if id.is_empty() || id.len() > 200 {
        return Err(invalid("A stable operation ID is required"));
    }
    if command["kind"] == "appendArtwork" {
        if let Some((_, receipt)) = c.operation_receipt(principal, &command)? {
            if let Some(receipt) = receipt {
                check_append_replay(c, &command)?;
                return Ok(Prepared::Complete(receipt));
            }
        }
        let alias = string(&command["artwork"], "image_id")?;
        let source = c.lookup_media(alias)?;
        let media = json!({"alias":alias,"sha256":source.sha256,"bytes":source.total_bytes,"mime":source.mime});
        media::validate(&media)?;
        let key = canonical::digest(stringify(&json!([principal, "appendArtwork", id])));
        return Ok(Prepared::Verify(Publication {
            key,
            media,
            principal: principal.into(),
            target: Target::Append(command),
        }));
    }
    let library = command["kind"] == "commitMedia";
    let mut row = super::prepared(
        c,
        principal,
        id,
        if library {
            "prepareMedia"
        } else {
            "saveArtwork"
        },
    )?;
    if row.state == "aborted" {
        return Err(conflict("OPERATION_CONFLICT", "Save operation was aborted"));
    }
    if let Some(receipt) = row.receipt.take() {
        return Ok(Prepared::Complete(receipt));
    }
    let media = row.input["media"].clone();
    media::validate(&media)?;
    let lease_created = lease(c, &row.key, string(&media, "sha256")?)?;
    Ok(Prepared::Verify(Publication {
        key: row.key.clone(),
        media,
        principal: principal.into(),
        target: Target::Save {
            row,
            library,
            lease_created,
        },
    }))
}

impl Publication {
    pub fn source(&self, root: &std::path::Path) -> Result<PathBuf> {
        let object = media::object_path(root, string(&self.media, "sha256")?)?;
        if matches!(self.target, Target::Append(_)) || object.try_exists()? {
            return Ok(object);
        }
        media::staging_path(root, &self.key, string(&self.media, "alias")?)
    }

    pub fn check(&self, c: &mut Context) -> Result<()> {
        match &self.target {
            Target::Save {
                row, lease_created, ..
            } => {
                let current = super::prepared(c, &self.principal, &row.id, &row.kind)?;
                current.check(&row.kind, &row.input)?;
                if current.key != row.key
                    || current.input != row.input
                    || current.state != row.state
                    || current.receipt.is_some()
                    || lease(c, &row.key, string(&self.media, "sha256")?)? != *lease_created
                {
                    return Err(conflict(
                        "OPERATION_CONFLICT",
                        "Save changed during media verification",
                    ));
                }
            }
            Target::Append(command) => {
                if let Some((_, receipt)) = c.operation_receipt(&self.principal, command)? {
                    if receipt.is_some() {
                        return Err(conflict(
                            "OPERATION_CONFLICT",
                            "Artwork append changed during verification",
                        ));
                    }
                }
                let source = c.lookup_media(string(&self.media, "alias")?)?;
                if source.sha256 != string(&self.media, "sha256")?
                    || Some(source.total_bytes) != self.media["bytes"].as_u64()
                    || Some(source.mime.as_str()) != self.media["mime"].as_str()
                {
                    return Err(conflict(
                        "MEDIA_INVALID",
                        "Artwork media changed during verification",
                    ));
                }
            }
        }
        Ok(())
    }

    pub fn commit(
        &self,
        c: &mut Context,
        check_file: impl Fn(&Context) -> Result<()>,
    ) -> Result<Value> {
        let receipt = c.transaction(|c| {
            check_file(c)?;
            self.check(c)?;
            let hash = string(&self.media, "sha256")?;
            let alias = string(&self.media, "alias")?;
            let receipt = match &self.target {
                Target::Save { row, library, .. } => {
                    alias_check(c, &self.media)?;
                    let object: Option<(i64, String)> = c.db.query_row(
                        "SELECT bytes,mime FROM media_objects WHERE hash=?", [hash], |r| Ok((r.get(0)?, r.get(1)?)),
                    ).optional()?;
                    if object.is_some_and(|(bytes, mime)| Some(bytes) != self.media["bytes"].as_i64()
                        || Some(mime.as_str()) != self.media["mime"].as_str())
                    {
                        return Err(conflict("MEDIA_INVALID", "Stored media metadata differs"));
                    }
                    let revision = c.next_revision()?;
                    c.db.execute("INSERT OR IGNORE INTO media_objects VALUES(?,?,?)", params![hash,self.media["bytes"].as_i64(),string(&self.media,"mime")?])?;
                    c.db.execute("INSERT OR IGNORE INTO media_aliases VALUES(?,?)", params![alias,hash])?;
                    let mut receipt = json!({"operationId":row.id,"kind":if *library {"commitMedia"} else {"saveArtwork"},"revision":revision});
                    if *library {
                        c.db.execute("INSERT OR IGNORE INTO media_refs VALUES('temporary',?,?)", params![alias,hash])?;
                    } else {
                        let mut body = row.input["artwork"].clone();
                        let key = entity_key(&body["id"])?;
                        if records::artwork(c, &key)?.is_some() {
                            return Err(conflict("OPERATION_CONFLICT", "Artwork ID already exists"));
                        }
                        body["image_id"] = alias.into();
                        let artwork = insert_artwork(c, &key, &body, revision)?;
                        c.db.execute("INSERT INTO media_refs VALUES('artwork',?,?)", params![key,hash])?;
                        receipt["artwork"] = artwork;
                    }
                    c.commit_operation(&row.key, &receipt)?;
                    c.db.execute("DELETE FROM leases WHERE operation_key=?", [&row.key])?;
                    receipt
                }
                Target::Append(command) => {
                    let (key, previous) = c.start_operation(&self.principal, command)?;
                    if let Some(receipt) = previous {
                        check_append_replay(c, command)?;
                        return Ok(receipt);
                    }
                    let art = &command["artwork"];
                    let artwork_key = entity_key(&art["id"])?;
                    if records::artwork(c, &artwork_key)?.is_some() {
                        return Err(conflict("OPERATION_CONFLICT", "Artwork already exists"));
                    }
                    let revision = c.next_revision()?;
                    let artwork = insert_artwork(c, &artwork_key, art, revision)?;
                    c.db.execute("INSERT INTO media_refs VALUES('artwork',?,?)", params![artwork_key,hash])?;
                    c.db.execute("DELETE FROM media_refs WHERE owner_kind='temporary' AND owner_id=?", [alias])?;
                    let mut receipt = json!({"operationId":command["operationId"],"kind":"appendArtwork","revision":revision});
                    receipt["artwork"] = artwork;
                    c.commit_operation(&key, &receipt)?;
                    receipt
                }
            };
            check_file(c)?;
            Ok(receipt)
        })?;
        if matches!(self.target, Target::Save { .. }) {
            media::cleanup(c, &self.key, &self.media);
        }
        Ok(receipt)
    }
}
