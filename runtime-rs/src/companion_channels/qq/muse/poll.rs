use super::*;
use crate::companion_channels::media::IMAGE_LIMIT;
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path as RoutePath},
    http::{HeaderMap, header},
    routing::post,
};

pub(super) fn image_route() -> Router<AppState> {
    Router::new()
        .route("/replies/{request_key}/image", post(image_reply))
        .layer(DefaultBodyLimit::max(IMAGE_LIMIT))
}

async fn image_reply(
    State(app): State<AppState>,
    Channel(mailbox): Channel,
    RoutePath(key): RoutePath<String>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Result<Json<Value>> {
    let _admission = app.host.admit_owned()?;
    let entry = mailbox.entry(&key)?;
    let settings = mailbox.settings(&app).await?;
    if !settings.muse_for(entry.scope) || !allows(&settings, entry.destination()) {
        return Err(expired());
    }
    let mime = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    attachment::send(
        &app,
        &mailbox,
        &entry,
        attachment::Attachment::image(&mime, bytes)?,
        attachment::Selection::Exact,
    )
    .await?;
    Ok(Json(
        json!({"ok":true,"requestKey":entry.key,"status":"sent","kind":"image"}),
    ))
}
