use super::*;
use axum::http::HeaderValue;

pub(super) async fn read(
    state: &AppState,
    storage: &Storage,
    session: &Session,
    method: &Method,
    id: &str,
    index: &str,
) -> Result<Response> {
    let index: u64 = index
        .parse()
        .map_err(|_| ApiError::new(404, "TASK_RESULT_MISSING", "Result is unavailable"))?;
    let result = tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(30),
            storage.task_result_reference(id, index, &session.principal_id)) =>
            result.map_err(|_| ApiError::new(504, "TASK_TIMEOUT", "Task read timed out"))??,
        _ = state.shutdown.cancelled() => return Err(ApiError::new(503, "DESKTOP_DRAINING", "Desktop is draining")),
    };
    if result.principal_id != session.principal_id || result.workspace_id != session.workspace_id {
        return Err(invalid_record());
    }
    let reference = result
        .reference
        .ok_or_else(|| ApiError::new(404, "TASK_RESULT_MISSING", "Result is unavailable"))?;
    // The alias is obtained exclusively from this principal's task, never from
    // an HTTP media parameter. Storage verifies the immutable object's bytes.
    let source = tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(30), storage.open_media(&reference.alias)) =>
            result.map_err(|_| ApiError::new(504, "TASK_TIMEOUT", "Task media verification timed out"))??,
        _ = state.shutdown.cancelled() => return Err(ApiError::new(503, "DESKTOP_DRAINING", "Desktop is draining")),
    };
    let media = &source.media;
    if reference.sha256 != media.sha256
        || reference.bytes != media.total_bytes
        || reference.mime != media.mime
    {
        return Err(invalid_record());
    }
    let mime = media.mime.clone();
    let mut response =
        crate::workspace_http::download_opened(state, storage, method, &reference.alias, source)?;
    response.headers_mut().insert(
        "content-type",
        HeaderValue::from_str(&mime).map_err(|_| invalid_record())?,
    );
    Ok(response)
}
