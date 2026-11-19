use crate::error::{ApiError, Result};
use base64::{Engine, engine::general_purpose::STANDARD};

pub(super) fn seal(value: &str) -> Result<String> {
    transform(value.as_bytes(), true).map(|bytes| STANDARD.encode(bytes))
}

pub(super) fn open(value: &str) -> Result<String> {
    let encrypted = STANDARD.decode(value).map_err(|_| failure())?;
    String::from_utf8(transform(&encrypted, false)?).map_err(|_| failure())
}

fn failure() -> ApiError {
    ApiError::new(503, "CHANNEL_CREDENTIAL", "Windows 无法读写本机机器人凭据")
}

#[cfg(windows)]
fn transform(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
        },
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len().try_into().map_err(|_| failure())?,
        pbData: bytes.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };
    // DPAPI uses the current Windows account. The clear value is never written to disk.
    unsafe {
        let ok = if encrypt {
            CryptProtectData(
                &input,
                null(),
                null(),
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                null_mut(),
                null(),
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 || output.pbData.is_null() {
            return Err(failure());
        }
        let memory = std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize);
        let result = memory.to_vec();
        memory.fill(0);
        LocalFree(output.pbData.cast());
        Ok(result)
    }
}

#[cfg(not(windows))]
fn transform(_: &[u8], _: bool) -> Result<Vec<u8>> {
    Err(failure())
}
