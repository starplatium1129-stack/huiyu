use super::*;
use axum::http::HeaderValue;

/// Only immutable inputs named by the authenticated principal's Qwen recipe.
/// No caller supplied path, filename or media alias is accepted.
pub(super) async fn read(
    state: &AppState,
    storage: &Storage,
    session: &Session,
    method: &Method,
    id: &str,
    index: &str,
) -> Result<Response> {
    let task = get(state, storage, session, id, false).await?;
    if task["kind"] != "qwen"
        || task["provider"] != "native"
        || task["input"]["family"] != "qwen-image"
    {
        return Err(ApiError::new(
            404,
            "TASK_INPUT_MISSING",
            "Qwen input is unavailable",
        ));
    }
    let index: usize = index
        .parse()
        .ok()
        .filter(|index| *index <= 3)
        .ok_or_else(|| ApiError::invalid("Invalid Qwen input index"))?;
    let name = if index == 0 {
        task["input"]["initImage"].as_str()
    } else {
        task["input"]["referenceImages"][index - 1].as_str()
    }
    .ok_or_else(|| ApiError::new(404, "TASK_INPUT_MISSING", "Qwen input is unavailable"))?;
    let reference = request(
        state,
        storage,
        session,
        json!({"kind":"task.input.get","taskId":id,"name":name}),
    )
    .await?;
    let alias = reference["alias"]
        .as_str()
        .filter(|alias| {
            task["inputMediaRefs"]
                .as_array()
                .is_some_and(|refs| refs.iter().any(|value| value == alias))
        })
        .ok_or_else(|| {
            ApiError::new(
                404,
                "TASK_INPUT_MISSING",
                "Protected Qwen input is unavailable",
            )
        })?;
    let source = tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(30), storage.open_media(alias)) =>
            result.map_err(|_| ApiError::new(504, "TASK_TIMEOUT", "Input verification timed out"))??,
        _ = state.shutdown.cancelled() => return Err(ApiError::new(503, "DESKTOP_DRAINING", "Desktop is draining")),
    };
    let media = &source.media;
    if reference["sha256"] != media.sha256
        || reference["bytes"] != media.total_bytes
        || reference["mime"] != media.mime
        || media.total_bytes > 16 * 1024 * 1024
        || !matches!(
            media.mime.as_str(),
            "image/png" | "image/jpeg" | "image/webp"
        )
    {
        return Err(invalid_record());
    }
    let mime = media.mime.clone();
    let mut response =
        crate::workspace_http::download_opened(state, storage, method, alias, source)?;
    response.headers_mut().insert(
        "content-type",
        HeaderValue::from_str(&mime).map_err(|_| invalid_record())?,
    );
    Ok(response)
}
