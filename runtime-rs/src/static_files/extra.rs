use super::*;
use std::{path::PathBuf, sync::LazyLock};
static SHOWCASE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?i)^/(?:manifest\.json|00-cover\.jpg|README\.txt|home/(?:nene|natsume)\.jpg|(?:images|thumbs)/(?:sc\d{3}|artist_[a-z0-9_-]+|pc_[a-z0-9_-]+|lora_[a-z0-9_-]+)\.(?:jpg|png|webp)|sheets/[a-z0-9_-]+/[a-z0-9_.-]+\.jpg)$").unwrap()
});

pub(super) fn location(state: &AppState, path: &str) -> Option<(PathBuf, String)> {
    let root = &state.config.app_root;
    if let Some(relative) = path.strip_prefix("/docs/") {
        return Some((
            root.join("docs"),
            if relative.is_empty() {
                "index.html".into()
            } else {
                relative.into()
            },
        ));
    }
    if let Some(relative) = path.strip_prefix("/tools/") {
        return (relative != "control-server.js")
            .then(|| (state.config.tools_root(), relative.into()));
    }
    if let Some(relative) = path.strip_prefix("/css/") {
        return Some((root.join("css"), relative.into()));
    }
    if let Some(relative) = path.strip_prefix("/src/assets/css/") {
        return ["design-system.css", "light-theme.css"]
            .contains(&relative)
            .then(|| (root.join("src/assets/css"), relative.into()));
    }
    if let Some(relative) = path.strip_prefix("/scene-showcase") {
        if relative.contains(['\\', '%', '?', '#'])
            || relative.contains("..")
            || !SHOWCASE.is_match(relative)
        {
            return None;
        }
        return state
            .maintenance
            .as_ref()?
            .showcase_root()
            .map(|base| (base, relative[1..].into()));
    }
    None
}
pub(super) async fn redirect(
    state: &AppState,
    path: &str,
    query: Option<&str>,
) -> Option<Response> {
    if path == "/docs" {
        let location = format!(
            "/docs/{}",
            query.map(|q| format!("?{q}")).unwrap_or_default()
        );
        return Some((StatusCode::MOVED_PERMANENTLY, [("location", location)]).into_response());
    }
    if !path.starts_with("/docs/") {
        return None;
    }
    let bytes = tokio::fs::read(state.config.app_root.join("docs/redirects.json"))
        .await
        .ok()?;
    let map: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let target = map[path].as_str()?;
    if !target.starts_with("/docs/") || target.contains(['\\', '\r', '\n']) {
        return None;
    }
    let target = format!(
        "{target}{}",
        query.map(|q| format!("?{q}")).unwrap_or_default()
    );
    Some(
        (
            StatusCode::PERMANENT_REDIRECT,
            [
                ("location", target),
                ("cache-control", "private, no-cache".into()),
            ],
        )
            .into_response(),
    )
}
