use super::{Error, Result, transaction::Transaction};
use serde_json::json;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;
pub(super) fn check(cancel: &CancellationToken, started: Instant) -> Result<()> {
    if cancel.is_cancelled() {
        Err(Error::new(499, "ABORT_ERR", "维护保存已取消"))
    } else if started.elapsed() > Duration::from_secs(120) {
        Err(Error::new(504, "MAINTENANCE_TIMEOUT", "维护保存超时"))
    } else {
        Ok(())
    }
}
pub(super) fn rollback_error(transaction: &mut Transaction, mut error: Error) -> Error {
    let rollback = transaction.rollback();
    let restored = rollback.is_ok();
    error.extra.as_object_mut().unwrap().extend(json!({"rolledBack":restored,"dataIntegrity":if restored{"restored"}else{"INCONSISTENT"},"recoveryRequired":!restored,"transactionId":transaction.nonce}).as_object().unwrap().clone());
    if let Err(rollback) = rollback {
        error.status = axum::http::StatusCode::INTERNAL_SERVER_ERROR;
        error.extra["recovery"] = format!(
            "维护事务尚未完整结束，请先使用恢复工具核验。{}",
            rollback.message
        )
        .into();
    }
    error
}
