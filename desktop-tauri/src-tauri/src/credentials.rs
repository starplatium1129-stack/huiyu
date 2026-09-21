use tauri::{State, WebviewWindow};
use crate::state::AppState;

fn authorize(window: &WebviewWindow, state: &AppState) -> Result<(), String> {
    let expected = state.gateway_url.lock().map_err(|_| "Gateway unavailable")?.clone();
    let expected = tauri::Url::parse(&expected).map_err(|_| "Gateway unavailable")?;
    let actual = window.url().map_err(|_| "Window unavailable")?;
    if expected.scheme() != "http" || expected.host_str() != Some("127.0.0.1")
        || actual.origin() != expected.origin() {
        return Err("Untrusted credential request".into());
    }
    Ok(())
}

fn target(endpoint: &str) -> Result<Vec<u16>, String> {
    let url = tauri::Url::parse(endpoint).map_err(|_| "Invalid API endpoint")?;
    if !["http", "https"].contains(&url.scheme()) || endpoint.len() > 500
        || !url.username().is_empty() || url.password().is_some() {
        return Err("Invalid API endpoint".into());
    }
    Ok(format!("Huiyu/ChatApi/{}", endpoint.trim_end_matches('/')).encode_utf16().chain(Some(0)).collect())
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
pub fn chat_credential_read(window: WebviewWindow, state: State<'_, AppState>, endpoint: String) -> Result<Option<String>, String> {
    authorize(&window, &state)?;
    read(&target(&endpoint)?)
}

#[tauri::command]
pub fn chat_credential_write(window: WebviewWindow, state: State<'_, AppState>, endpoint: String, secret: String) -> Result<(), String> {
    authorize(&window, &state)?;
    if secret.len() > 1000 { return Err("Credential exceeds limit".into()); }
    write(&mut target(&endpoint)?, &secret)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn isolated_credential_round_trip_and_clear() {
        // A unique test-only namespace: never read or replace a user API key.
        let id = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let mut name: Vec<u16> = format!("Huiyu/Test/{}/{id}", std::process::id()).encode_utf16().chain(Some(0)).collect();
        struct Cleanup(Vec<u16>);
        impl Drop for Cleanup { fn drop(&mut self) { let _ = write(&mut self.0, ""); } }
        let _cleanup = Cleanup(name.clone());
        assert_eq!(read(&name).unwrap(), None);
        write(&mut name, "neutral-credential-fixture").unwrap();
        assert_eq!(read(&name).unwrap().as_deref(), Some("neutral-credential-fixture"));
        write(&mut name, "").unwrap();
        assert_eq!(read(&name).unwrap(), None);
    }

    #[test]
    fn credential_target_rejects_non_api_and_embedded_passwords() {
        assert!(target("file:///private").is_err());
        assert!(target("https://user:password@example.test").is_err());
        assert_eq!(target("https://example.test/v1/").unwrap(), target("https://example.test/v1").unwrap());
    }
}
