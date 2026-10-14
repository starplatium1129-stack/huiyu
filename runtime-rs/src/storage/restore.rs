use super::*;
use canonical::entity_key;
use rusqlite::OptionalExtension;
use std::collections::BTreeSet;
use verified_media::{Identity, Verified};

#[derive(Clone, PartialEq, Eq)]
struct Reference {
    owner_kind: String,
    hash: String,
    bytes: u64,
    mime: String,
}
impl Reference {
    fn metadata(&self) -> Value {
        json!({"sha256":self.hash,"bytes":self.bytes,"mime":self.mime})
    }
}
struct Publication {
    command: Value,
    principal: String,
    artwork_key: String,
    revision: i64,
    deleted_at: Option<i64>,
    references: Vec<Reference>,
}
enum Prepared {
    Complete(Value),
    Verify(Publication),
}

// The existing media-writer permit bounds both restores and result commits.
// Keep GC protection and file ownership until the actual hash worker exits.
pub(super) struct Pending {
    id: String,
    publication: Publication,
    identity: Identity,
    reply: oneshot::Sender<Result<Value>>,
    _permit: OwnedSemaphorePermit,
}
impl Pending {
    pub(super) fn protects(&self, hash: &str) -> bool {
        self.publication
            .references
            .iter()
            .any(|reference| reference.hash == hash)
    }
    pub(super) fn cancel(&self) {
        self.identity.cancel.store(true, Ordering::Relaxed);
    }
}

fn artwork_state(c: &Context, key: &str) -> Result<(i64, Option<i64>)> {
    c.db.prepare_cached("SELECT revision,deleted_at FROM artworks WHERE id_key=?")?
        .query_row([key], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()?
        .ok_or_else(|| ApiError::new(404, "NOT_FOUND", "Artwork does not exist"))
}
fn references(c: &Context, key: &str) -> Result<Vec<Reference>> {
    let mut statement = c.db.prepare_cached(
        "SELECT r.owner_kind,m.hash,m.bytes,m.mime FROM media_refs r
         JOIN media_objects m ON m.hash=r.hash
         WHERE r.owner_kind IN ('artwork','trash') AND r.owner_id=?
         ORDER BY r.owner_kind,m.hash",
    )?;
    let mut rows = statement.query([key])?;
    let mut references = Vec::new();
    while let Some(row) = rows.next()? {
        c.check_cancel()?;
        references.push(Reference {
            owner_kind: row.get(0)?,
            hash: row.get(1)?,
            bytes: u64::try_from(row.get::<_, i64>(2)?)
                .map_err(|_| conflict("MEDIA_INVALID", "Invalid media byte count"))?,
            mime: row.get(3)?,
        });
    }
    Ok(references)
}
fn prepare(c: &Context, principal: &str, command: &Value) -> Result<Prepared> {
    c.check_cancel()?;
    if principal.is_empty() {
        return Err(ApiError::new(
            401,
            "UNAUTHORIZED",
            "Desktop principal is required",
        ));
    }
    if command["kind"] != "restoreArtwork" {
        return Err(invalid("Invalid artwork restore command"));
    }
    let operation_id = string(command, "operationId")?;
    if operation_id.is_empty() || operation_id.len() > 200 {
        return Err(invalid("A stable operation ID is required"));
    }
    c.writer()?;
    c.owner.check()?;
    if let Some(operation) = c.operation(principal, operation_id)? {
        operation.check("restoreArtwork", command)?;
        if let Some(receipt) = operation.receipt {
            return Ok(Prepared::Complete(receipt));
        }
    }
    let artwork_key = entity_key(&command["id"])?;
    let (revision, deleted_at) = artwork_state(c, &artwork_key)?;
    if command["expectedRevision"] != revision {
        return Err(conflict(
            "REVISION_CONFLICT",
            "Artwork has a newer revision",
        ));
    }
    Ok(Prepared::Verify(Publication {
        references: references(c, &artwork_key)?,
        command: command.clone(),
        principal: principal.into(),
        artwork_key,
        revision,
        deleted_at,
    }))
}

pub(super) fn start(
    c: &mut Context,
    command: &Value,
    principal: &str,
    reply: oneshot::Sender<Result<Value>>,
    permit: OwnedSemaphorePermit,
    sender: &mpsc::WeakSender<Work>,
) {
    let publication = match prepare(c, principal, command) {
        Ok(Prepared::Complete(value)) => {
            let _ = reply.send(Ok(value));
            return;
        }
        Ok(Prepared::Verify(publication)) => publication,
        Err(error) => {
            let _ = reply.send(Err(error));
            return;
        }
    };
    let identity = match Identity::new(c).and_then(|identity| {
        identity.check(c)?;
        Ok(identity)
    }) {
        Ok(identity) => identity,
        Err(error) => {
            let _ = reply.send(Err(error));
            return;
        }
    };
    let pending = Pending {
        id: uuid::Uuid::new_v4().to_string(),
        publication,
        identity,
        reply,
        _permit: permit,
    };
    match spawn(&pending, sender) {
        Ok(()) => c.restore_commit = Some(pending),
        Err(error) => {
            let _ = pending.reply.send(Err(error));
        }
    }
}
fn spawn(pending: &Pending, sender: &mpsc::WeakSender<Work>) -> Result<()> {
    let sender = sender.upgrade().ok_or_else(unavailable)?;
    let id = pending.id.clone();
    let identity = pending.identity.clone();
    let mut seen = BTreeSet::new();
    let sources = pending
        .publication
        .references
        .iter()
        .filter(|reference| seen.insert(reference.hash.as_str()))
        .map(|reference| {
            Ok((
                media::object_path(&identity.root, &reference.hash)?,
                reference.metadata(),
            ))
        })
        .collect::<Result<Vec<_>>>()?;
    std::thread::Builder::new()
        .name("workspace-restore-verify".into())
        .spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                identity.check_paths()?;
                let verified = sources
                    .into_iter()
                    .map(|(path, metadata)| verified_media::verify(&identity, &path, &metadata))
                    .collect::<Result<Vec<_>>>()?;
                identity.check_paths()?;
                Ok(verified)
            }))
            .unwrap_or_else(|_| Err(unavailable()));
            // The sender retains the SQLite actor/owner until completion is queued.
            let _ = sender.blocking_send(Work::RestoreVerified(id, result));
        })?;
    Ok(())
}

impl Publication {
    fn check_files(&self, c: &Context, verified: &[Verified]) -> Result<()> {
        let hashes = self
            .references
            .iter()
            .map(|reference| reference.hash.as_str())
            .collect::<BTreeSet<_>>();
        if hashes.len() != verified.len() {
            return Err(conflict(
                "MEDIA_INVALID",
                "Artwork media verification is incomplete",
            ));
        }
        for reference in &self.references {
            c.check_cancel()?;
            let path = media::object_path(&c.root, &reference.hash)?;
            let proof = verified
                .iter()
                .find(|proof| proof.matches(&path, &reference.metadata()))
                .ok_or_else(|| conflict("MEDIA_INVALID", "Artwork media metadata changed"))?;
            proof.check(&c.root)?;
        }
        Ok(())
    }
    fn commit(&self, c: &mut Context, identity: &Identity, verified: &[Verified]) -> Result<Value> {
        c.transaction(|c| {
            identity.check(c)?;
            let (operation, previous) = c.start_operation(&self.principal, &self.command)?;
            if let Some(receipt) = previous { return Ok(receipt); }
            if artwork_state(c, &self.artwork_key)? != (self.revision, self.deleted_at) {
                return Err(conflict("REVISION_CONFLICT", "Artwork has a newer revision"));
            }
            if references(c, &self.artwork_key)? != self.references {
                return Err(conflict("MEDIA_INVALID", "Artwork media references changed"));
            }
            self.check_files(c, verified)?;
            let revision = c.next_revision()?;
            if self.deleted_at.is_some() {
                records::restore(c, &self.artwork_key, revision)?;
            }
            let mut receipt = json!({"operationId":self.command["operationId"],"kind":"restoreArtwork","revision":revision});
            if let Some(artwork) = records::artwork(c, &self.artwork_key)? {
                receipt["changed"] = json!(artwork["revision"] == revision);
                receipt["artwork"] = artwork;
            }
            c.commit_operation(&operation, &receipt)?;
            // Verify the expected post-restore state before COMMIT too. Restore
            // intentionally transfers trash references into the artwork namespace.
            let expected_revision = if self.deleted_at.is_some() { revision } else { self.revision };
            if artwork_state(c, &self.artwork_key)? != (expected_revision, None) {
                return Err(conflict("REVISION_CONFLICT", "Artwork changed during restoration"));
            }
            let mut expected_refs = self.references.clone();
            if self.deleted_at.is_some() {
                for reference in &mut expected_refs { reference.owner_kind = "artwork".into(); }
                expected_refs.sort_by(|left, right| left.hash.cmp(&right.hash));
            }
            if references(c, &self.artwork_key)? != expected_refs {
                return Err(conflict("MEDIA_INVALID", "Artwork media references changed during restoration"));
            }
            identity.check(c)?;
            self.check_files(c, verified)?;
            Ok(receipt)
        })
    }
}

pub(super) fn finish(c: &mut Context, id: String, verified: Result<Vec<Verified>>) {
    if c.restore_commit
        .as_ref()
        .is_none_or(|pending| pending.id != id)
    {
        return;
    }
    let pending = c.restore_commit.take().unwrap();
    c.cancel = pending.identity.cancel.clone();
    let result = (|| {
        pending.identity.check(c)?;
        pending.publication.commit(c, &pending.identity, &verified?)
    })();
    let _ = pending.reply.send(result);
}
