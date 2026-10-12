/// All privileged pages must stay on the current authenticated gateway origin.
pub fn same_gateway_origin(expected: &str, url: &tauri::Url) -> bool {
    let Ok(gateway) = tauri::Url::parse(expected) else { return false; };
    gateway.scheme() == "http" && gateway.host_str() == Some("127.0.0.1")
        && gateway.username().is_empty() && gateway.password().is_none()
        && url.username().is_empty() && url.password().is_none()
        && url.origin() == gateway.origin()
}

/// Pure form of the host's existing registered source policy, shared by native
/// credential authorization and the global IPC guard through main_shared.
pub fn registered_desktop_origin(expected: &str, bundled: bool, url: &tauri::Url) -> bool {
    (bundled && crate::ui_entry::native_origin(url)) || same_gateway_origin(expected, url)
}
