use super::{Error, Result};
use axum::body::Bytes;
use serde_json::Value;
use std::sync::{Arc, LazyLock};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

static DECODERS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(2)));

pub(super) async fn parse(
    bytes: Bytes,
    slot: OwnedSemaphorePermit,
    cancel: &CancellationToken,
) -> Result<(Value, OwnedSemaphorePermit)> {
    let input = (bytes, slot);
    let scope = cancel.child_token();
    let _cancel_on_drop = scope.clone().drop_guard();
    let permit = tokio::select! {
        biased;
        _ = scope.cancelled() => return Err(cancelled()),
        permit = DECODERS.clone().acquire_owned() => permit.map_err(|_| cancelled())?,
    };
    // A dropped HTTP request cancels publication, but the actual decoder retains
    // its bytes and slot until parsing and destruction have completed.
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let input = input;
        if scope.is_cancelled() {
            return Err(cancelled());
        }
        let body =
            serde_json::from_slice(&input.0).map_err(|_| Error::invalid("请求 JSON 格式错误"))?;
        if scope.is_cancelled() {
            return Err(cancelled());
        }
        let (bytes, slot) = input;
        drop(bytes);
        // The original eight-request admission follows the parsed tree into the
        // write lock/transaction, or its destruction after request cancellation.
        Ok((body, slot))
    })
    .await
    .map_err(|_| Error::new(503, "MAINTENANCE_UNAVAILABLE", "维护读取暂不可用"))?
}

fn cancelled() -> Error {
    Error::new(499, "ABORT_ERR", "维护保存已取消")
}
