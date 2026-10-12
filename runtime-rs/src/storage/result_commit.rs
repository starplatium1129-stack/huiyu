use super::*;
use crate::file_identity;
use tasks::outputs::commit::{self, Output};
use tokio::sync::OwnedSemaphorePermit;
mod file;
pub(super) use file::Verified;

pub(super) fn is_write(command: &Value) -> bool {
    matches!(
        command["kind"].as_str(),
        Some(
            "task.result.prepare"
                | "task.result.chunk"
                | "task.result.commit"
                | "task.input.prepare"
                | "task.input.chunk"
                | "task.input.commit"
                | "uploadChunk"
                | "uploadMediaChunk"
                | "commitSave"
                | "commitMedia"
                | "appendArtwork"
        )
    )
}

pub(super) fn is_commit(command: &Value) -> bool {
    matches!(
        command["kind"].as_str(),
        Some(
            "task.result.commit"
                | "task.input.commit"
                | "commitSave"
                | "commitMedia"
                | "appendArtwork"
        )
    )
}

enum Publication {
    Task(Output),
    Artwork(saves::commit::Publication),
}
enum Prepared {
    Complete(Value),
    Verify(Publication),
}
impl Publication {
    fn key(&self) -> &str {
        match self {
            Self::Task(output) => &output.key,
            Self::Artwork(output) => &output.key,
        }
    }
    fn media(&self) -> &Value {
        match self {
            Self::Task(output) => &output.media,
            Self::Artwork(output) => &output.media,
        }
    }
    fn check(&self, c: &mut Context) -> Result<()> {
        match self {
            Self::Task(output) => output.check(c).map(|_| ()),
            Self::Artwork(output) => output.check(c),
        }
    }
    fn commit(
        &self,
        c: &mut Context,
        check_file: impl Fn(&Context) -> Result<()>,
    ) -> Result<Value> {
        match self {
            Self::Task(output) => output.commit(c, check_file),
            Self::Artwork(output) => output.commit(c, check_file),
        }
    }
}

// One admitted media writer per workspace. Its permit and GC protection live
// on the actor until verification exits, even if the HTTP waiter disappears.
pub(super) struct Pending {
    id: String,
    output: Publication,
    identity: Identity,
    reply: oneshot::Sender<Result<Value>>,
    _permit: Option<OwnedSemaphorePermit>,
}
impl Pending {
    pub fn key(&self) -> &str {
        self.output.key()
    }
    pub fn hash(&self) -> &str {
        self.output.media()["sha256"].as_str().unwrap()
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
        if self.root != c.root || self.workspace_id != c.workspace_id || self.epoch != c.epoch {
            return Err(conflict(
                "WORKSPACE_IDENTITY",
                "Workspace changed during result verification",
            ));
        }
        self.check_paths()
    }
    fn check_paths(&self) -> Result<()> {
        self.cancelled()?;
        let root = file_identity::path(&schema::safe(&self.root, "")?, true)?;
        if root.dev != self.root_id.dev
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
    start_inner(c, command, principal, reply, permit, sender, None);
}

pub(super) fn start_file(
    c: &mut Context,
    command: &Value,
    source: std::fs::File,
    principal: &str,
    reply: oneshot::Sender<Result<Value>>,
    permit: OwnedSemaphorePermit,
    sender: &mpsc::WeakSender<Work>,
) {
    if !matches!(
        command["kind"].as_str(),
        Some("task.result.commit" | "task.input.commit")
    ) {
        let _ = reply.send(Err(invalid("Invalid internal task file command")));
        return;
    }
    start_inner(
        c,
        command,
        principal,
        reply,
        Some(permit),
        sender,
        Some(source),
    );
}

fn start_inner(
    c: &mut Context,
    command: &Value,
    principal: &str,
    reply: oneshot::Sender<Result<Value>>,
    permit: Option<OwnedSemaphorePermit>,
    sender: &mpsc::WeakSender<Work>,
    source: Option<std::fs::File>,
) {
    let prepared = if matches!(
        command["kind"].as_str(),
        Some("task.result.commit" | "task.input.commit")
    ) {
        commit::prepare(c, principal, command).map(|prepared| match prepared {
            commit::Prepared::Complete(value) => Prepared::Complete(value),
            commit::Prepared::Verify(output) => Prepared::Verify(Publication::Task(output)),
        })
    } else {
        saves::commit::prepare(c, principal, command).map(|prepared| match prepared {
            saves::commit::Prepared::Complete(value) => Prepared::Complete(value),
            saves::commit::Prepared::Verify(output) => {
                Prepared::Verify(Publication::Artwork(output))
            }
        })
    };
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
    let path = match file::source(&pending) {
        Ok(path) => path,
        Err(error) => {
            let _ = pending.reply.send(Err(error));
            return;
        }
    };
    // Keep only the latest committed proof (one file handle). The common
    // upload -> append sequence rechecks native identity/ChangeTime instead
    // of hashing the same unchanged object again on either thread.
    if let Some(verified) = c.media_verified.take()
        && verified.matches(&path, pending.output.media())
        && verified.check(&c.root).is_ok()
    {
        let id = pending.id.clone();
        c.result_commit = Some(pending);
        finish(c, id, Ok(verified), sender);
        return;
    }
    let result = spawn(&pending, path, sender, source);
    if let Err(error) = result {
        let _ = pending.reply.send(Err(error));
    } else {
        c.result_commit = Some(pending);
    }
}

fn spawn(
    pending: &Pending,
    path: PathBuf,
    sender: &mpsc::WeakSender<Work>,
    source: Option<std::fs::File>,
) -> Result<()> {
    let sender = sender.upgrade().ok_or_else(unavailable)?;
    let id = pending.id.clone();
    let identity = pending.identity.clone();
    let media = pending.output.media().clone();

    std::thread::Builder::new()
        .name("workspace-result-verify".into())
        .spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                if let Some(source) = source {
                    file::copy(&identity, &path, &media, source)?;
                }
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
            let created = match std::fs::hard_link(&verified.path, &destination) {
                Ok(()) => true,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => false,
                Err(error) => return Err(error.into()),
            };
            schema::sync_dir(destination.parent().unwrap())?;
            if created {
                // Persist the new object entry before removing its staging link.
                // Final hashing then captures the stable links/ChangeTime; an
                // existing unverified object never discards good staging bytes.
                media::cleanup(c, pending.key(), pending.output.media());
            }
            // hard_link changes native links and ChangeTime. Neither may be
            // ignored: a concurrent writer can also restore mtime. Hash the
            // final object again off-actor, including an AlreadyExists race.
            spawn(&pending, destination, sender, None)?;
            return Ok(None);
        }
        let value = pending.output.commit(c, |c| {
            pending.identity.check(c)?;
            verified.check(&c.root)
        })?;
        Ok(Some((value, verified)))
    })();
    match result {
        Ok(None) => c.result_commit = Some(pending),
        Ok(Some((value, verified))) => {
            // Existing-object retries may still remove a staging hard link at
            // commit. Keep the successful receipt, but never cache stale proof.
            if verified.check(&c.root).is_ok() {
                c.media_verified = Some(verified);
            }
            let _ = pending.reply.send(Ok(value));
        }
        Err(error) => {
            let _ = pending.reply.send(Err(error));
        }
    }
}
