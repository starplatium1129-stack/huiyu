//! Signature adapter for the resumable updater download.
//!
//! Tauri updater 2.13.0 keeps verification private and `Update::install` does not
//! verify downloaded bytes. Mirror its `verify_signature`/`verify_signed_version`
//! semantics with the same locked libraries; never trust cache or HTTP validators
//! as authentication. Remove this adapter when upstream exposes public verification
//! for externally downloaded bytes, and recheck parity on updater upgrades.

use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use semver::Version;

pub(super) fn verify(
    bytes: &[u8],
    signature: &str,
    public_key: &str,
    version: &str,
    require_signed_version: bool,
) -> Result<(), String> {
    let public_key = PublicKey::decode(&decode_outer(public_key)?)
        .map_err(|error| format!("更新公钥无效：{error}"))?;
    let signature = Signature::decode(&decode_outer(signature)?)
        .map_err(|error| format!("更新签名无效：{error}"))?;
    // `true` matches upstream legacy signature support, not a verification bypass.
    // This verifies both the artifact and the global signature over trusted comment.
    public_key
        .verify(bytes, &signature, true)
        .map_err(|error| format!("更新包签名验证失败：{error}"))?;

    // Read signed metadata only after its global signature has been verified.
    let Some(signed_version) = signature
        .trusted_comment()
        .split('\t')
        .find_map(|field| field.strip_prefix("version:"))
    else {
        return if require_signed_version {
            Err("更新签名未包含已签署版本".into())
        } else {
            Ok(())
        };
    };
    let matches = match (
        Version::parse(signed_version.trim_start_matches('v')),
        Version::parse(version.trim_start_matches('v')),
    ) {
        (Ok(signed), Ok(announced)) => signed == announced,
        _ => signed_version == version,
    };
    if matches {
        Ok(())
    } else {
        Err(format!(
            "更新签署版本不匹配：签名为 {signed_version}，更新声明为 {version}"
        ))
    }
}

fn decode_outer(value: &str) -> Result<String, String> {
    let decoded = STANDARD
        .decode(value)
        .map_err(|error| format!("更新签名 Base64 无效：{error}"))?;
    String::from_utf8(decoded).map_err(|_| "更新签名不是有效 UTF-8".into())
}
