use super::*;
mod apply;
mod artwork;
mod batch;
use artwork::Artwork;
use canonical::entity_key;
use rusqlite::OptionalExtension;
use std::collections::{BTreeMap, BTreeSet};
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
    items: Vec<batch::Selection>,
}
#[derive(Default)]
pub(super) struct Verification {
    files: BTreeMap<String, Verified>,
    failed: BTreeMap<String, String>,
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
            .items
            .iter()
            .filter_map(|item| item.artwork.as_ref())
            .flat_map(|artwork| &artwork.references)
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
    let kind = string(command, "kind")?;
    if !matches!(kind, "restoreArtwork" | "restoreArtworks") {
        return Err(invalid("Invalid artwork restore command"));
    }
    let operation_id = string(command, "operationId")?;
    if operation_id.is_empty() || operation_id.len() > 200 {
        return Err(invalid("A stable operation ID is required"));
    }
    c.writer()?;
    c.owner.check()?;
    if let Some((_, Some(receipt))) = c.operation_receipt(principal, command)? {
        return Ok(Prepared::Complete(receipt));
    }
    let items = if kind == "restoreArtworks" {
        batch::prepare(c, command)?
    } else {
        vec![batch::Selection {
            id: command["id"].clone(),
            artwork: Some(Artwork::capture(c, command)?),
            code: None,
        }]
    };
    Ok(Prepared::Verify(Publication {
        command: command.clone(),
        principal: principal.into(),
        items,
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
    let batch = pending.publication.command["kind"] == "restoreArtworks";
    let mut seen = BTreeSet::new();
    let sources = pending
        .publication
        .items
        .iter()
        .filter_map(|item| item.artwork.as_ref())
        .flat_map(|artwork| &artwork.references)
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
                let mut verified = Verification::default();
                for (path, metadata) in sources {
                    identity.check_paths()?;
                    let result = verified_media::verify(&identity, &path, &metadata);
                    // Identity/cancellation failures remain global even when a
                    // particular file failed. SQL failures never enter this path.
                    identity.check_paths()?;
                    match result {
                        Ok(proof) => {
                            verified.files.insert(proof.hash().into(), proof);
                        }
                        Err(error) if batch && error.code != "CANCELLED" => {
                            verified
                                .failed
                                .insert(string(&metadata, "sha256")?.into(), error.code);
                        }
                        Err(error) => return Err(error),
                    }
                }
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
    fn commit(
        &self,
        c: &mut Context,
        identity: &Identity,
        verified: &Verification,
    ) -> Result<Value> {
        if self.command["kind"] == "restoreArtworks" {
            return batch::commit(self, c, identity, verified);
        }
        let artwork = self.items[0].artwork.as_ref().unwrap();
        c.transaction(|c| {
            identity.check(c)?;
            let (operation, previous) = c.start_operation(&self.principal, &self.command)?;
            if let Some(receipt) = previous { return Ok(receipt); }
            artwork.check_before(c)?;
            if artwork.references.iter().map(|reference| &reference.hash).collect::<BTreeSet<_>>().len() != verified.files.len() {
                return Err(conflict("MEDIA_INVALID", "Artwork media verification is incomplete"));
            }
            artwork.check_files(c, verified)?;
            let revision = c.next_revision()?;
            if artwork.deleted_at.is_some() {
                let mut memberships = apply::Memberships::default();
                apply::restore(c, &artwork.key, revision, &mut memberships)?;
                memberships.flush(c, revision)?;
            }
            let mut receipt = json!({"operationId":self.command["operationId"],"kind":"restoreArtwork","revision":revision});
            if let Some(row) = records::artwork(c, &artwork.key)? {
                receipt["changed"] = json!(row["revision"] == revision);
                receipt["artwork"] = row;
            }
            c.commit_operation(&operation, &receipt)?;
            // Verify the expected post-restore state before COMMIT too. Restore
            // intentionally transfers trash references into the artwork namespace.
            artwork.check_after(c, revision)?;
            identity.check(c)?;
            artwork.check_files(c, verified)?;
            Ok(receipt)
        })
    }
}

pub(super) fn finish(c: &mut Context, id: String, verified: Result<Verification>) {
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
