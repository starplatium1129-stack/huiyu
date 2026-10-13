use tauri::{Manager, WebviewWindow};

fn credential_window(label: &str) -> bool {
    matches!(label, "atelier" | "companion" | "companion-chat")
}
fn authorize(window: &WebviewWindow) -> Result<(), String> {
    let actual = window.url().map_err(|_| "Window unavailable")?;
    // Share the host's registered legacy/bundled source policy. Requiring the
    // bundled document to equal the sidecar's HTTP origin rejects every key.
    if !credential_window(window.label())
        || !crate::main_shared::is_gateway_origin(window.app_handle(), &actual) {
        return Err("Untrusted credential request".into());
    }
    Ok(())
}

fn target(endpoint: &str) -> Result<Vec<u16>, String> {
    target_for_profile(endpoint, crate::ui_entry::isolated_profile().as_deref())
}

fn target_for_profile(endpoint: &str, isolated_profile: Option<&std::path::Path>) -> Result<Vec<u16>, String> {
    let url = tauri::Url::parse(endpoint).map_err(|_| "Invalid API endpoint")?;
    if !["http", "https"].contains(&url.scheme()) || endpoint.len() > 500
        || !url.username().is_empty() || url.password().is_some() {
        return Err("Invalid API endpoint".into());
    }
    let prefix = match isolated_profile {
        Some(profile) => {
            if !profile.is_absolute() { return Err("Isolated credential profile must be absolute".into()); }
            // No filesystem/vault lookup: an explicit test profile must never
            // read or overwrite the production endpoint's global target.
            let digest = ring::digest::digest(&ring::digest::SHA256, profile.as_os_str().as_encoded_bytes());
            let hash: String = digest.as_ref().iter().map(|byte| format!("{byte:02x}")).collect();
            format!("Huiyu/Test/ChatApi/{hash}")
        }
        None => "Huiyu/ChatApi".into(),
    };
    Ok(format!("{prefix}/{}", endpoint.trim_end_matches('/')).encode_utf16().chain(Some(0)).collect())
}

#[cfg(windows)]
fn read(target: &[u16]) -> Result<Option<String>, String> {
    use windows_sys::Win32::{Foundation::{GetLastError, ERROR_NOT_FOUND}, Security::Credentials::*};
    let mut credential = std::ptr::null_mut();
    unsafe {
        if CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) == 0 {
            return if GetLastError() == ERROR_NOT_FOUND { Ok(None) } else { Err("Windows credential read failed".into()) };
        }
        let value = if (*credential).CredentialBlobSize == 0 { Ok(String::new()) } else {
            String::from_utf8(std::slice::from_raw_parts((*credential).CredentialBlob, (*credential).CredentialBlobSize as usize).to_vec())
        };
        CredFree(credential.cast());
        value.map(Some).map_err(|_| "Invalid saved credential".into())
    }
}

#[cfg(windows)]
fn write(target: &mut [u16], secret: &str) -> Result<(), String> {
    use windows_sys::Win32::{Foundation::{GetLastError, ERROR_NOT_FOUND}, Security::Credentials::*};
    unsafe {
        if secret.is_empty() {
            if CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) == 0 && GetLastError() != ERROR_NOT_FOUND {
                return Err("Windows credential deletion failed".into());
            }
        } else {
            let mut blob = secret.as_bytes().to_vec();
            let credential = CREDENTIALW {
                Type: CRED_TYPE_GENERIC, TargetName: target.as_mut_ptr(),
                CredentialBlobSize: blob.len() as u32, CredentialBlob: blob.as_mut_ptr(),
                Persist: CRED_PERSIST_LOCAL_MACHINE, ..std::mem::zeroed()
            };
            let result = CredWriteW(&credential, 0);
            blob.fill(0);
            if result == 0 { return Err("Windows credential write failed".into()); }
        }
    }
    if read(target)?.unwrap_or_default() != secret { return Err("Windows credential verification failed".into()); }
    Ok(())
}

#[cfg(not(windows))]
fn read(_: &[u16]) -> Result<Option<String>, String> { Err("Secure credentials require Windows".into()) }
#[cfg(not(windows))]
fn write(_: &mut [u16], _: &str) -> Result<(), String> { Err("Secure credentials require Windows".into()) }

#[tauri::command]
pub fn chat_credential_read(window: WebviewWindow, endpoint: String) -> Result<Option<String>, String> {
    authorize(&window)?;
    read(&target(&endpoint)?)
}

#[tauri::command]
pub fn chat_credential_write(window: WebviewWindow, endpoint: String, secret: String) -> Result<(), String> {
    authorize(&window)?;
    if secret.len() > 1000 { return Err("Credential exceeds limit".into()); }
    write(&mut target(&endpoint)?, &secret)
}
