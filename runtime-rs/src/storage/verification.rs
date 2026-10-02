use super::{Media, Storage, invalid, media, schema, string, unavailable};
use crate::error::{ApiError, Result};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs::File,
    path::PathBuf,
    sync::{Arc, Mutex, Weak},
};
use tokio::sync::{Mutex as AsyncMutex, Semaphore};
use tokio_util::sync::CancellationToken;

const WORKERS: u32 = 2;
const CHECKERS: u32 = 4;
pub(super) struct Verifier {
    workers: Arc<Semaphore>,
    checks: Arc<Semaphore>,
    paths: Mutex<HashMap<PathBuf, Weak<AsyncMutex<()>>>>,
    cache: Mutex<HashMap<PathBuf, media::FileIdentity>>,
    closed: CancellationToken,
    #[cfg(test)]
    pause: Mutex<Option<Pause>>,
    #[cfg(test)]
    hashes: std::sync::atomic::AtomicUsize,
}
impl Verifier {
    pub fn new() -> Self {
        Self {
            workers: Arc::new(Semaphore::new(WORKERS as usize)),
            checks: Arc::new(Semaphore::new(CHECKERS as usize)),
            paths: Mutex::new(HashMap::new()),
            cache: Mutex::new(HashMap::new()),
            closed: CancellationToken::new(),
            #[cfg(test)]
            pause: Mutex::new(None),
            #[cfg(test)]
            hashes: std::sync::atomic::AtomicUsize::new(0),
        }
    }
    pub async fn verify(
        self: &Arc<Self>,
        root: Arc<PathBuf>,
        source: Media,
        owner: tokio::sync::mpsc::Sender<super::Work>,
    ) -> Result<Media> {
        let lock = {
            let mut paths = self.paths.lock().unwrap();
            paths.retain(|_, value| value.strong_count() > 0);
            match paths.get(&source.path).and_then(Weak::upgrade) {
                Some(lock) => lock,
                None => {
                    let lock = Arc::new(AsyncMutex::new(()));
                    paths.insert(source.path.clone(), Arc::downgrade(&lock));
                    lock
                }
            }
        };
        let guard = tokio::select! { biased;
            _ = self.closed.cancelled() => return Err(unavailable()),
            guard = lock.lock_owned() => guard,
        };
        let cancelled = self.closed.child_token();
        let _cancel = cancelled.clone().drop_guard();
        let known = self.cache.lock().unwrap().contains_key(&source.path);
        let (source, guard, owner, cached) = if known {
            let permit = tokio::select! { biased;
                _ = self.closed.cancelled() => return Err(unavailable()),
                permit = self.checks.clone().acquire_owned() => permit.map_err(|_| unavailable())?,
            };
            let (verifier, checking_cancel, root) = (self.clone(), cancelled.clone(), root.clone());
            tokio::task::spawn_blocking(move || {
                // Warm gallery and Range reads only need a bounded identity check;
                // they must not queue behind full hashes of unrelated cold media.
                let _permit = permit;
                check(&checking_cancel)?;
                schema::safe(
                    &root,
                    source
                        .path
                        .strip_prefix(root.as_path())
                        .map_err(|_| invalid("Media path escapes workspace"))?,
                )?;
                let file = File::open(&source.path)?;
                #[cfg(test)]
                verifier.paused();
                let before = media::FileIdentity::of(&file)?;
                let cached = verifier.cache.lock().unwrap().get(&source.path) == Some(&before);
                check(&checking_cancel)?;
                // Do not retain an opened file while awaiting a hash slot when
                // identity changed; cold read handles remain bounded by WORKERS.
                Ok::<_, ApiError>((source, guard, owner, cached))
            })
            .await
            .map_err(|_| unavailable())??
        } else {
            (source, guard, owner, false)
        };
        if cached {
            return Ok(source);
        }
        let permit = tokio::select! { biased;
            _ = self.closed.cancelled() => return Err(unavailable()),
            permit = self.workers.clone().acquire_owned() => permit.map_err(|_| unavailable())?,
        };
        let verifier = self.clone();
        tokio::task::spawn_blocking(move || {
            // Retain the path lock and workspace owner across both stages and
            // until a detached hash exits. Close drains both admission pools.
            let (_permit, _guard, _owner) = (permit, guard, owner);
            check(&cancelled)?;
            schema::safe(
                &root,
                source
                    .path
                    .strip_prefix(root.as_path())
                    .map_err(|_| invalid("Media path escapes workspace"))?,
            )?;
            let mut file = File::open(&source.path)?;
            let before = media::FileIdentity::of(&file)?;
            #[cfg(test)]
            {
                verifier.paused();
                verifier
                    .hashes
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
            let (bytes, hash, mime) = media::hash_opened(&mut file, || check(&cancelled))?;
            if bytes != source.total_bytes
                || hash != source.sha256
                || mime.as_deref() != Some(&source.mime)
                || media::FileIdentity::of(&file)? != before
                || media::FileIdentity::of(&File::open(&source.path)?)? != before
            {
                return Err(ApiError::new(
                    409,
                    "MEDIA_INVALID",
                    "Media digest, type or file identity changed",
                ));
            }
            check(&cancelled)?;
            let mut cache = verifier.cache.lock().unwrap();
            if cache.len() >= 256
                && let Some(key) = cache.keys().next().cloned()
            {
                cache.remove(&key);
            }
            cache.insert(source.path.clone(), before);
            Ok(source)
        })
        .await
        .map_err(|_| unavailable())?
    }
    pub async fn close(&self) {
        self.closed.cancel();
        // Pending async waiters observe cancellation; detached metadata checks
        // and hashes retain their respective permits until filesystem work ends.
        let _drained = tokio::join!(
            self.checks.acquire_many(CHECKERS),
            self.workers.acquire_many(WORKERS),
        );
    }
    #[cfg(test)]
    fn paused(&self) {
        let pause = self.pause.lock().unwrap().take();
        if let Some(pause) = pause {
            let _ = pause.entered.send(());
            let _ = pause.resume.recv();
        }
    }
}

fn check(cancelled: &CancellationToken) -> Result<()> {
    if cancelled.is_cancelled() {
        Err(unavailable())
    } else {
        Ok(())
    }
}

pub(super) async fn read(storage: &Storage, command: &Value) -> Result<Value> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let source = storage.media(string(command, "alias")?).await?;
    let offset = command
        .get("offset")
        .map(Value::as_u64)
        .unwrap_or(Some(0))
        .filter(|v| *v <= source.total_bytes)
        .ok_or_else(|| invalid("Invalid media read range"))?;
    let length = command
        .get("length")
        .map(Value::as_u64)
        .unwrap_or(Some(media::CHUNK as u64))
        .filter(|v| *v >= 1 && *v <= media::CHUNK as u64)
        .ok_or_else(|| invalid("Invalid media read range"))?;
    let mut data = vec![0; length.min(source.total_bytes - offset) as usize];
    let mut file = tokio::fs::File::open(&source.path).await?;
    file.seek(std::io::SeekFrom::Start(offset)).await?;
    file.read_exact(&mut data).await?;
    Ok(
        json!({"data":STANDARD.encode(data),"mime":source.mime,"totalBytes":source.total_bytes,"sha256":source.sha256,"offset":offset}),
    )
}

#[cfg(test)]
struct Pause {
    entered: tokio::sync::oneshot::Sender<()>,
    resume: std::sync::mpsc::Receiver<()>,
}
#[cfg(test)]
mod tests;
