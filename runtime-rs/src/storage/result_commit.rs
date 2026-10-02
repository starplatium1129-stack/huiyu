use super::*;
use crate::file_identity;
use tasks::outputs::commit::{self, Output, Prepared};
use tokio::sync::OwnedSemaphorePermit;
mod file;
pub(super) use file::Verified;

pub(super) fn is_write(command: &Value) -> bool {
    matches!(
        command["kind"].as_str(),
        Some("task.result.prepare" | "task.result.chunk" | "task.result.commit")
    )
}

// One admitted result writer per workspace. This permit and protection live on
// the actor, even if the HTTP waiter disappears while the hash thread is running.
pub(super) struct Pending {
    id: String,
    output: Output,
    identity: Identity,
    reply: oneshot::Sender<Result<Value>>,
    _permit: Option<OwnedSemaphorePermit>,
}
impl Pending {
    pub fn key(&self) -> &str {
        &self.output.key
    }
    pub fn hash(&self) -> &str {
        self.output.media["sha256"].as_str().unwrap()
    }
    pub fn cancel(&self) {
        self.identity.cancel.store(true, Ordering::Relaxed);
    }
}

#[derive(Clone)]
struct Identity {
    root: PathBuf,
    workspace_id: String,
    epoch: String,
    root_id: file_identity::Identity,
    database_id: file_identity::Identity,
    owner_id: file_identity::Identity,
    cancel: Arc<AtomicBool>,
}
impl Identity {
    fn new(c: &Context) -> Result<Self> {
        Ok(Self {
            root: c.root.clone(),
            workspace_id: c.workspace_id.clone(),
            epoch: c.epoch.clone(),
            root_id: file_identity::path(&schema::safe(&c.root, "")?, true)?,
            database_id: file_identity::path(&schema::safe(&c.root, "huiyu.sqlite3")?, false)?,
            owner_id: file_identity::path(&schema::safe(&c.root, ".workspace-owner.json")?, false)?,
            cancel: c.cancel.clone(),
        })
    }
    fn cancelled(&self) -> Result<()> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(ApiError::new(
                499,
                "CANCELLED",
                "Result verification was cancelled",
            ));
        }
        Ok(())
    }
    fn check(&self, c: &Context) -> Result<()> {
        self.cancelled()?;
        c.writer()?;
        c.owner.check()?;
        let root = file_identity::path(&schema::safe(&self.root, "")?, true)?;
        if self.root != c.root
            || self.workspace_id != c.workspace_id
            || self.epoch != c.epoch
            || root.dev != self.root_id.dev
            || root.ino != self.root_id.ino
            || file_identity::path(&schema::safe(&self.root, "huiyu.sqlite3")?, false)?
                != self.database_id
            || file_identity::path(&schema::safe(&self.root, ".workspace-owner.json")?, false)?
                != self.owner_id
        {
            return Err(conflict(
                "WORKSPACE_IDENTITY",
                "Workspace changed during result verification",
            ));
        }
        Ok(())
    }
}

pub(super) fn start(
    c: &mut Context,
    command: &Value,
    principal: &str,
    reply: oneshot::Sender<Result<Value>>,
    permit: Option<OwnedSemaphorePermit>,
    sender: &mpsc::WeakSender<Work>,
) {
    let prepared = commit::prepare(c, principal, command);
    let output = match prepared {
        Ok(Prepared::Complete(value)) => {
            let _ = reply.send(Ok(value));
            return;
        }
        Ok(Prepared::Verify(output)) => output,
        Err(error) => {
            let _ = reply.send(Err(error));
            return;
        }
    };
    let identity = match Identity::new(c) {
        Ok(identity) => identity,
        Err(error) => {
            let _ = reply.send(Err(error));
            return;
        }
    };
    let pending = Pending {
        id: uuid::Uuid::new_v4().to_string(),
        output,
        identity,
        reply,
        _permit: permit,
    };
    let result = file::source(&pending).and_then(|path| spawn(&pending, path, sender));
    if let Err(error) = result {
        let _ = pending.reply.send(Err(error));
    } else {
        c.result_commit = Some(pending);
    }
}

fn spawn(pending: &Pending, path: PathBuf, sender: &mpsc::WeakSender<Work>) -> Result<()> {
    let sender = sender.upgrade().ok_or_else(unavailable)?;
    let id = pending.id.clone();
    let identity = pending.identity.clone();
    let media = pending.output.media.clone();
    #[cfg(test)]
    if tasks::media_tests::commit_validation::fail_start(&identity.root) {
        return Err(unavailable());
    }
    std::thread::Builder::new()
        .name("workspace-result-verify".into())
        .spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                file::verify(&identity, &path, &media)
            }))
            .unwrap_or_else(|_| Err(unavailable()));
            // The sender keeps the actor/owner alive until the blocking read has
            // exited and its completion can be consumed, including during Close.
            let _ = sender.blocking_send(Work::ResultVerified(id, result));
        })?;
    Ok(())
}

pub(super) fn finish(
    c: &mut Context,
    id: String,
    verified: Result<Verified>,
    sender: &mpsc::WeakSender<Work>,
) {
    if c.result_commit.as_ref().is_none_or(|job| job.id != id) {
        return;
    }
    let pending = c.result_commit.take().unwrap();
    c.cancel = pending.identity.cancel.clone();
    let result = (|| {
        pending.identity.check(c)?;
        pending.output.check(c)?;
        let verified = verified?;
        verified.check(&c.root)?;
        let destination = media::object_path(&c.root, pending.hash())?;
        if verified.path != destination {
            std::fs::create_dir_all(destination.parent().unwrap())?;
            pending.identity.check(c)?;
            verified.check(&c.root)?;
            match std::fs::hard_link(&verified.path, &destination) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.into()),
            }
            schema::sync_dir(destination.parent().unwrap())?;
            // hard_link changes native links and ChangeTime. Neither may be
            // ignored: a concurrent writer can also restore mtime. Hash the
            // final object again off-actor, including an AlreadyExists race.
            spawn(&pending, destination, sender)?;
            return Ok(None);
        }
        let value = pending.output.commit(c, |c| {
            pending.identity.check(c)?;
            verified.check(&c.root)
        })?;
        Ok(Some(value))
    })();
    match result {
        Ok(None) => c.result_commit = Some(pending),
        Ok(Some(value)) => {
            let _ = pending.reply.send(Ok(value));
        }
        Err(error) => {
            let _ = pending.reply.send(Err(error));
        }
    }
}
