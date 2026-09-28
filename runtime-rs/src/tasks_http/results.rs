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
    let task = get(state, storage, session, id).await?;
    let reference = task["resultRefs"]
        .as_array()
        .and_then(|refs| {
            refs.iter()
                .find(|item| item["index"].as_u64() == Some(index))
        })
        .ok_or_else(|| ApiError::new(404, "TASK_RESULT_MISSING", "Result is unavailable"))?;
    let alias = reference["alias"].as_str().ok_or_else(invalid_record)?;
    // The alias is obtained exclusively from this principal's task, never from
    // an HTTP media parameter. Storage verifies the immutable object's bytes.
    let media = tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(30), storage.media(alias)) =>
            result.map_err(|_| ApiError::new(504, "TASK_TIMEOUT", "Task media verification timed out"))??,
        _ = state.shutdown.cancelled() => return Err(ApiError::new(503, "DESKTOP_DRAINING", "Desktop is draining")),
    };
    if reference["sha256"].as_str() != Some(&media.sha256)
        || reference["bytes"].as_u64() != Some(media.total_bytes)
        || reference["mime"].as_str() != Some(&media.mime)
    {
        return Err(invalid_record());
    }
    let mut response =
        crate::workspace_http::stream_media(state, method, &media, 0, media.total_bytes).await?;
    response.headers_mut().insert(
        "content-type",
        HeaderValue::from_str(&media.mime).map_err(|_| invalid_record())?,
    );
    Ok(response)
}
