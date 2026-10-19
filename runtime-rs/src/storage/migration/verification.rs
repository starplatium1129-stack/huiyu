use super::*;
use crate::storage::verified_media::{Identity, Stamp};
use std::{collections::BTreeSet, sync::Arc};
mod file;

pub(in crate::storage) struct Outcome {
    proofs: Vec<Option<Stamp>>,
    blockers: Vec<String>,
}

pub(in crate::storage) struct Pending {
    id: String,
    migration_id: String,
    principal: String,
    envelope: Arc<Value>,
    revision: i64,
    hashes: BTreeSet<String>,
    identity: Identity,
    reply: oneshot::Sender<Result<Value>>,
    _permit: OwnedSemaphorePermit,
}
impl Pending {
    pub(in crate::storage) fn protects(&self, hash: &str) -> bool {
        self.hashes.contains(hash)
    }
    pub(in crate::storage) fn cancel(&self) {
        self.identity.cancel.store(true, Ordering::Relaxed);
    }
    fn check_session(&self, c: &Context) -> Result<()> {
        let current = session(c, &self.migration_id, &self.principal)?;
        if current.state != "importing"
            || current.revision != self.revision
            || &current.envelope != self.envelope.as_ref()
        {
            return Err(conflict(
                "MIGRATION_CONFLICT",
                "Migration source or state changed during verification",
            ));
        }
        Ok(())
    }
    fn check_files(&self, c: &Context, outcome: &Outcome) -> Result<()> {
        let media = self.envelope["media"].as_array().unwrap();
        if media.len() != outcome.proofs.len() {
            return Err(conflict(
                "MEDIA_INVALID",
                "Migration media verification is incomplete",
            ));
        }
        for (media, proof) in media.iter().zip(&outcome.proofs) {
            c.check_cancel()?;
            let Some(proof) = proof else { continue };
            let path = media::object_path(&c.root, string(media, "sha256")?)?;
            if !proof.matches(&path, media) {
                return Err(conflict(
                    "MEDIA_INVALID",
                    "Migration media metadata changed",
                ));
            }
            proof.check(&c.root)?;
        }
        Ok(())
    }
    fn commit(&self, c: &mut Context, outcome: &Outcome) -> Result<Value> {
        self.identity.check(c)?;
        self.check_files(c, outcome)?;
        c.transaction(|c| {
            self.identity.check(c)?;
            self.check_session(c)?;
            let mut blockers = Vec::new();
            let records = records::read(c, &self.migration_id)?;
            if records.len() != self.envelope["records"].as_array().unwrap().len() {
                blockers.push("incomplete-records".into());
            }
            blockers.extend(outcome.blockers.iter().cloned());
            blockers.extend(records::validate(&records, &self.envelope)?);
            for (media, proof) in self.envelope["media"].as_array().unwrap().iter().zip(&outcome.proofs) {
                c.check_cancel()?;
                if proof.is_some() {
                    c.db.prepare_cached(
                        "UPDATE migration_media SET complete=1 WHERE migration_id=? AND alias=?",
                    )?.execute(params![self.migration_id, string(media, "alias")?])?;
                }
            }
            c.db.execute(
                "UPDATE migration_sessions SET report=? WHERE migration_id=?",
                params![stringify(&json!(blockers)), self.migration_id],
            )?;
            if blockers.is_empty() {
                if outcome.proofs.iter().any(Option::is_none) {
                    return Err(conflict("MEDIA_INVALID", "Migration media verification is incomplete"));
                }
                let revision = c.next_revision()?;
                for media in self.envelope["media"].as_array().unwrap() {
                    c.check_cancel()?;
                    let hash = string(media, "sha256")?;
                    c.db.prepare_cached("INSERT OR IGNORE INTO media_objects VALUES(?,?,?)")?
                        .execute(params![hash, media["bytes"].as_i64(), string(media, "mime")?])?;
                    c.db.prepare_cached("INSERT INTO media_aliases VALUES(?,?)")?
                        .execute(params![string(media, "alias")?, hash])?;
                    c.db.prepare_cached("INSERT OR IGNORE INTO media_refs VALUES('migration',?,?)")?
                        .execute(params![self.migration_id, hash])?;
                }
                records::publish(c, &records, &self.envelope, revision)?;
                c.db.execute(
                    "UPDATE migration_sessions SET state='verified',revision=? WHERE migration_id=?",
                    params![revision, self.migration_id],
                )?;
            }
            // Keep writer admission until both version checks and SQL COMMIT
            // finish. A cancelled or changed file cannot authorize activation.
            self.identity.check(c)?;
            self.check_files(c, outcome)?;
            Ok(())
        })?;
        status(c, &self.migration_id, &self.principal)
    }
}

pub(in crate::storage) fn start(
    c: &mut Context,
    command: &Value,
    principal: &str,
    reply: oneshot::Sender<Result<Value>>,
    permit: OwnedSemaphorePermit,
    sender: &mpsc::WeakSender<Work>,
) {
    let prepared = (|| {
        c.check_cancel()?;
        if principal.is_empty() {
            return Err(ApiError::new(
                401,
                "UNAUTHORIZED",
                "Desktop principal is required",
            ));
        }
        if command["kind"] != "migration.verify" {
            return Err(invalid("Invalid migration verification command"));
        }
        let operation = string(command, "operationId")?;
        if operation.is_empty() || operation.len() > 200 {
            return Err(invalid("A stable operation ID is required"));
        }
        c.writer()?;
        c.owner.check()?;
        let id = string(command, "migrationId")?;
        let current = session(c, id, principal)?;
        if current.state != "importing" {
            return Ok(None);
        }
        let hashes = current.envelope["media"]
            .as_array()
            .unwrap()
            .iter()
            .map(|media| string(media, "sha256").map(str::to_owned))
            .collect::<Result<BTreeSet<_>>>()?;
        let identity = Identity::new(c)?;
        identity.check(c)?;
        Ok(Some((current, hashes, identity)))
    })();
    let (current, hashes, identity) = match prepared {
        Ok(Some(prepared)) => prepared,
        Ok(None) => {
            let result = string(command, "migrationId").and_then(|id| status(c, id, principal));
            let _ = reply.send(result);
            return;
        }
        Err(error) => {
            let _ = reply.send(Err(error));
            return;
        }
    };
    let pending = Pending {
        id: uuid::Uuid::new_v4().to_string(),
        migration_id: string(command, "migrationId").unwrap().into(),
        principal: principal.into(),
        envelope: Arc::new(current.envelope),
        revision: current.revision,
        hashes,
        identity,
        reply,
        _permit: permit,
    };
    match spawn(&pending, sender) {
        Ok(()) => c.migration_verification = Some(pending),
        Err(error) => {
            let _ = pending.reply.send(Err(error));
        }
    }
}

fn spawn(pending: &Pending, sender: &mpsc::WeakSender<Work>) -> Result<()> {
    let sender = sender.upgrade().ok_or_else(unavailable)?;
    let id = pending.id.clone();
    let migration_id = pending.migration_id.clone();
    let identity = pending.identity.clone();
    let envelope = pending.envelope.clone();
    std::thread::Builder::new()
        .name("workspace-migration-verify".into())
        .spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                file::run(&identity, &migration_id, envelope["media"].as_array().unwrap())
            }))
            .unwrap_or_else(|_| Err(unavailable()));
            // The sender retains the actor and owner until the actual filesystem
            // worker exits and its completion is queued, including during Close.
            let _ = sender.blocking_send(Work::MigrationVerified(id, result));
        })?;
    Ok(())
}

pub(in crate::storage) fn finish(c: &mut Context, id: String, outcome: Result<Outcome>) {
    if c.migration_verification
        .as_ref()
        .is_none_or(|pending| pending.id != id)
    {
        return;
    }
    let pending = c.migration_verification.take().unwrap();
    c.cancel = pending.identity.cancel.clone();
    let result = (|| pending.commit(c, &outcome?))();
    let _ = pending.reply.send(result);
}
