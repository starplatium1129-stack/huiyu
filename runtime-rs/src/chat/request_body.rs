use super::{Error, Result, validation};
use axum::body::Bytes;
use serde_json::Value;
use std::sync::{Arc, LazyLock};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

static WORKERS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(2)));
// Bound retained request bodies independently of the short-lived CPU workers.
// Keep the existing Ollama queue capacity while admitting uploads before read.
static PAYLOADS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(16)));
pub(super) type Admission = Arc<OwnedSemaphorePermit>;

pub(super) async fn admit(cancel: &CancellationToken) -> Result<Admission> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(cancelled()),
        permit = PAYLOADS.clone().acquire_owned() => permit.map(Arc::new).map_err(|_| cancelled()),
    }
}

pub(super) async fn acquire(cancel: &CancellationToken) -> Result<OwnedSemaphorePermit> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(cancelled()),
        permit = WORKERS.clone().acquire_owned() => permit.map_err(|_| cancelled()),
    }
}

pub(super) async fn parse(
    bytes: Bytes,
    admission: &Admission,
    cancel: &CancellationToken,
) -> Result<Value> {
    let input = (bytes, admission.clone());
    let scope = cancel.child_token();
    let _guard = scope.clone().drop_guard();
    let permit = acquire(&scope).await?;
    // The job owns its byte buffer and permit even if its awaiting request is
    // cancelled. Persona I/O does not hold a CPU worker slot between stages.
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let input = input;
        if scope.is_cancelled() {
            return Err(cancelled());
        }
        let body =
            serde_json::from_slice(&input.0).map_err(|_| Error::invalid("请求 JSON 格式错误"))?;
        let (bytes, admission) = input;
        drop(bytes);
        let output = (body, admission);
        if scope.is_cancelled() {
            return Err(cancelled());
        }
        // An unpolled or detached job result must retain its payload slot too.
        Ok(output)
    })
    .await
    .map_err(|_| Error::stream("REQUEST_DECODE_FAILED", "聊天请求解析未完成"))?
    .map(|(body, _admission)| body)
}

pub(super) async fn validate(
    body: Value,
    persona: Option<String>,
    direct: bool,
    admission: &Admission,
    cancel: &CancellationToken,
) -> Result<validation::Input> {
    let source = (body, admission.clone());
    let scope = cancel.child_token();
    let _guard = scope.clone().drop_guard();
    let permit = acquire(&scope).await?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let mut source = source;
        if scope.is_cancelled() {
            return Err(cancelled());
        }
        if !direct && let Some(fields) = source.0.as_object_mut() {
            fields.insert("companionTools".into(), Value::Bool(false));
            fields.insert("webSearch".into(), Value::Bool(false));
        }
        let input = validation::chat(&mut source.0, persona.as_deref())?;
        let (body, admission) = source;
        drop(body);
        let output = (input, admission);
        if scope.is_cancelled() {
            return Err(cancelled());
        }
        Ok(output)
    })
    .await
    .map_err(|_| Error::stream("REQUEST_DECODE_FAILED", "聊天请求校验未完成"))?
    .map(|(input, _admission)| input)
}

pub(super) async fn encode(
    body: Value,
    admission: Option<&Admission>,
    cancel: &CancellationToken,
) -> Result<Bytes> {
    let source = (body, admission.cloned());
    let scope = cancel.child_token();
    let _guard = scope.clone().drop_guard();
    let permit = acquire(&scope).await?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let source = source;
        if scope.is_cancelled() {
            return Err(cancelled());
        }
        let bytes = serde_json::to_vec(&source.0)
            .map_err(|_| Error::stream("UPSTREAM_ENCODE_FAILED", "聊天请求编码未完成"))?;
        let (body, admission) = source;
        drop(body);
        let bytes = match admission {
            Some(admission) => Bytes::from_owner(EncodedBody {
                bytes,
                _admission: admission,
            }),
            None => Bytes::from(bytes),
        };
        if scope.is_cancelled() {
            return Err(cancelled());
        }
        Ok(bytes)
    })
    .await
    .map_err(|_| Error::stream("UPSTREAM_ENCODE_FAILED", "聊天请求编码未完成"))?
}

struct EncodedBody {
    bytes: Vec<u8>,
    // Retain the slot through reqwest body clones and HTTP frames, including
    // cancellation or early upstream headers. SSE responses do not own it.
    _admission: Admission,
}
impl AsRef<[u8]> for EncodedBody {
    fn as_ref(&self) -> &[u8] {
        &self.bytes
    }
}

fn cancelled() -> Error {
    Error::stream("ABORTED", "聊天已停止")
}
