use super::{Error, Result, validation};
use axum::body::Bytes;
use serde_json::Value;
use std::sync::{Arc, LazyLock};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

static WORKERS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(2)));

async fn acquire(cancel: &CancellationToken) -> Result<OwnedSemaphorePermit> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(cancelled()),
        permit = WORKERS.clone().acquire_owned() => permit.map_err(|_| cancelled()),
    }
}

pub(super) async fn parse(bytes: Bytes, cancel: &CancellationToken) -> Result<Value> {
    let scope = cancel.child_token();
    let _guard = scope.clone().drop_guard();
    let permit = acquire(&scope).await?;
    // The job owns its byte buffer and permit even if its awaiting request is
    // cancelled. Persona I/O does not hold a CPU worker slot between stages.
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        if scope.is_cancelled() {
            return Err(cancelled());
        }
        let body =
            serde_json::from_slice(&bytes).map_err(|_| Error::invalid("请求 JSON 格式错误"))?;
        drop(bytes);
        if scope.is_cancelled() {
            return Err(cancelled());
        }
        Ok(body)
    })
    .await
    .map_err(|_| Error::stream("REQUEST_DECODE_FAILED", "聊天请求解析未完成"))?
}

pub(super) async fn validate(
    body: Value,
    persona: Option<String>,
    direct: bool,
    cancel: &CancellationToken,
) -> Result<validation::Input> {
    let scope = cancel.child_token();
    let _guard = scope.clone().drop_guard();
    let permit = acquire(&scope).await?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        if scope.is_cancelled() {
            return Err(cancelled());
        }
        let mut input = validation::chat(&body, persona.as_deref())?;
        drop(body);
        if scope.is_cancelled() {
            return Err(cancelled());
        }
        input.tools &= direct;
        Ok(input)
    })
    .await
    .map_err(|_| Error::stream("REQUEST_DECODE_FAILED", "聊天请求校验未完成"))?
}

pub(super) async fn encode(body: Value, cancel: &CancellationToken) -> Result<Vec<u8>> {
    let scope = cancel.child_token();
    let _guard = scope.clone().drop_guard();
    let permit = acquire(&scope).await?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        if scope.is_cancelled() {
            return Err(cancelled());
        }
        let bytes = serde_json::to_vec(&body)
            .map_err(|_| Error::stream("UPSTREAM_ENCODE_FAILED", "聊天请求编码未完成"))?;
        drop(body);
        if scope.is_cancelled() {
            return Err(cancelled());
        }
        Ok(bytes)
    })
    .await
    .map_err(|_| Error::stream("UPSTREAM_ENCODE_FAILED", "聊天请求编码未完成"))?
}

fn cancelled() -> Error {
    Error::stream("ABORTED", "聊天已停止")
}
