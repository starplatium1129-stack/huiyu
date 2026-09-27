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

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn isolated_credential_targets_preserve_production_and_separate_profiles() {
        use std::path::Path;
        let endpoint = "https://credential-fixture.invalid/v1/";
        let production = target_for_profile(endpoint, None).unwrap();
        let expected: Vec<u16> = "Huiyu/ChatApi/https://credential-fixture.invalid/v1".encode_utf16().chain(Some(0)).collect();
        assert_eq!(production, expected, "production target bytes must remain unchanged");
        let profile = Path::new(r"C:\fixtures\profile-one");
        let isolated = target_for_profile(endpoint, Some(profile)).unwrap();
        assert_ne!(isolated, production);
        assert_eq!(isolated, target_for_profile(endpoint, Some(profile)).unwrap());
        assert_ne!(isolated, target_for_profile(endpoint, Some(Path::new(r"C:\fixtures\profile-two"))).unwrap());
        assert!(target_for_profile(endpoint, Some(Path::new("relative-profile"))).is_err());
        let text = String::from_utf16(&isolated[..isolated.len() - 1]).unwrap();
        assert!(text.starts_with("Huiyu/Test/ChatApi/"));
        assert!(!text.contains("fixtures"), "target stores only a hash of the isolated profile path");
    }

    #[test]
    fn credential_source_boundaries_match_registered_desktop_sources() {
        use crate::main_shared::registered_desktop_origin;
        let expected = "http://127.0.0.1:4312";
        for label in ["atelier", "companion", "companion-chat"] { assert!(credential_window(label)); }
        assert!(!credential_window("preview"));
        assert!(!credential_window(""));
        for source in ["http://tauri.localhost/", "https://tauri.localhost/index.html#/companion"] {
            let actual = source.parse().unwrap();
            assert!(registered_desktop_origin(expected, true, &actual));
            assert!(!registered_desktop_origin(expected, false, &actual));
        }
        assert!(registered_desktop_origin(expected, false, &"http://127.0.0.1:4312/chat".parse().unwrap()));
        for source in ["http://localhost:4312/", "http://127.0.0.1:3000/", "http://tauri.localhost:4312/", "https://tauri.localhost.example/", "https://example.test/"] {
            assert!(!registered_desktop_origin(expected, true, &source.parse().unwrap()));
        }
    }

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
