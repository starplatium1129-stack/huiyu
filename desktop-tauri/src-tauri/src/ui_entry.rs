use tauri::{AppHandle, Manager, WebviewUrl};
pub fn can_enable_bundled() -> bool {
    option_env!("AICS_BUNDLED_UI_VERIFIED") == Some("1") || isolated_profile().is_some()
}
pub fn isolated_hidden() -> bool { isolated_profile().is_some() && std::env::args().any(|arg| arg == "--hidden") }

/// A verified activation enables the new origin on the following application
/// launch. Existing windows keep the legacy origin until their export completes.
pub fn bundled(app: &AppHandle) -> bool {
    let Some(state) = app.try_state::<crate::state::AppState>() else { return false; };
    let file = state.paths.config_root.join("workspace-active.json");
    let Ok(bytes) = std::fs::read(file) else { return false; };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else { return false; };
    value["formatVersion"] == 1 && value["bundledUi"] == true
        && ["workspaceId", "migrationId", "backupId", "restoreCandidateId"].iter().all(|key| value[*key].as_str().is_some_and(|id| !id.is_empty()))
        && value["domains"].as_array().is_some_and(|domains|
            ["artwork", "settings", "chat", "draft"].iter().all(|domain| domains.iter().any(|entry| entry == domain)))
}

pub fn source(app: &AppHandle, gateway: &str, pathname: &str) -> Result<WebviewUrl, String> {
    if bundled(app) { return Ok(WebviewUrl::App(format!("index.html#{pathname}").into())); }
    format!("{}{pathname}", gateway.trim_end_matches('/')).parse::<tauri::Url>()
        .map(WebviewUrl::External).map_err(|_| "Invalid gateway URL".into())
}

pub fn native_origin(url: &tauri::Url) -> bool {
    matches!(url.origin().ascii_serialization().as_str(), "http://tauri.localhost" | "https://tauri.localhost" | "tauri://localhost")
}

/// Native acceptance can target an isolated directory without touching the real
/// profile. This is host process configuration, never a renderer argument.
pub fn isolated_profile() -> Option<std::path::PathBuf> {
    std::env::var_os("AICS_DESKTOP_WEBVIEW_DATA_DIR").map(std::path::PathBuf::from).filter(|path| path.is_absolute())
}
