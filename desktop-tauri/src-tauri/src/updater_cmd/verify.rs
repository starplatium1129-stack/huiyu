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

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{Ed25519KeyPair, KeyPair};

    const BYTES: &[u8] = b"small local update fixture";

    // Public, deterministic test-only seeds. No release credentials or package IO.
    fn fixture(comment: &str, seed: u8) -> (String, String) {
        let key = Ed25519KeyPair::from_seed_unchecked(&[seed; 32]).unwrap();
        // The algorithm is two bytes and the key ID is eight bytes.
        let mut public_key = b"Edtest-key".to_vec();
        public_key.extend_from_slice(key.public_key().as_ref());
        let signature = key.sign(BYTES);
        let mut signature_packet = public_key[..10].to_vec();
        signature_packet.extend_from_slice(signature.as_ref());
        let mut global_message = signature.as_ref().to_vec();
        global_message.extend_from_slice(comment.as_bytes());
        let global_signature = key.sign(&global_message);
        (
            STANDARD.encode(format!(
                "untrusted comment: test key\n{}\n",
                STANDARD.encode(public_key)
            )),
            STANDARD.encode(format!(
                "untrusted comment: test signature\n{}\ntrusted comment: {comment}\n{}\n",
                STANDARD.encode(signature_packet),
                STANDARD.encode(global_signature.as_ref())
            )),
        )
    }

    #[test]
    fn valid_signature_checks_semver_and_preserves_literal_fallback() {
        let (key, signature) = fixture("timestamp:1\tfile:fixture\tversion:v1.2.3", 7);
        assert!(verify(BYTES, &signature, &key, "1.2.3", true).is_ok());
        assert!(verify(BYTES, &signature, &key, "v1.2.3", false).is_ok());
        assert!(verify(BYTES, &signature, &key, "1.2.4", false).is_err());

        let (key, signature) = fixture("version:nightly", 7);
        assert!(verify(BYTES, &signature, &key, "nightly", true).is_ok());
        assert!(verify(BYTES, &signature, &key, "vnightly", true).is_err());
    }

    #[test]
    fn corrupted_or_incomplete_packages_and_wrong_keys_cannot_install() {
        let (key, signature) = fixture("version:1.2.3", 7);
        let (wrong_key, _) = fixture("version:1.2.3", 8);
        let mut modified = BYTES.to_vec();
        modified[0] ^= 1;
        for bytes in [modified.as_slice(), &BYTES[..BYTES.len() - 1], b""] {
            assert!(verify(bytes, &signature, &key, "1.2.3", false).is_err());
        }
        // Same key ID with a different public key must still fail cryptographically.
        assert!(verify(BYTES, &signature, &wrong_key, "1.2.3", false).is_err());
    }

    #[test]
    fn missing_signed_version_only_allowed_when_configured() {
        let (key, signature) = fixture("timestamp:1\tfile:fixture", 7);
        assert!(verify(BYTES, &signature, &key, "1.2.3", false).is_ok());
        assert!(verify(BYTES, &signature, &key, "1.2.3", true).is_err());
        // A substring inside another field is not a signed version field.
        let (key, signature) = fixture("file:version:1.2.3", 7);
        assert!(verify(BYTES, &signature, &key, "1.2.3", true).is_err());
    }

    #[test]
    fn forged_trusted_comment_fails_before_version_is_trusted() {
        let (key, signature) = fixture("version:1.2.3", 7);
        let forged = STANDARD.encode(
            decode_outer(&signature)
                .unwrap()
                .replace("version:1.2.3", "version:9.9.9"),
        );
        let error = verify(BYTES, &forged, &key, "9.9.9", true).unwrap_err();
        assert!(error.starts_with("更新包签名验证失败"));
    }

    #[test]
    fn malformed_outer_encoding_and_truncated_signature_fail_closed() {
        let (key, signature) = fixture("version:1.2.3", 7);
        let decoded = decode_outer(&signature).unwrap();
        let truncated = STANDARD.encode(decoded.lines().take(3).collect::<Vec<_>>().join("\n"));
        for invalid in ["!".to_string(), STANDARD.encode([0xff]), truncated] {
            assert!(verify(BYTES, &invalid, &key, "1.2.3", false).is_err());
            assert!(verify(BYTES, &signature, &invalid, "1.2.3", false).is_err());
        }
    }

    #[test]
    fn accepts_prehashed_minisign_fixture() {
        // Public fixture from minisign-verify 0.2.5's verify_prehashed test.
        let key = STANDARD.encode(concat!(
            "untrusted comment: public upstream test key\n",
            "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3"
        ));
        let signature = STANDARD.encode(concat!(
            "untrusted comment: signature from minisign secret key\n",
            "RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/",
            "z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\n",
            "trusted comment: timestamp:1556193335\tfile:test\n",
            "y/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg=="
        ));
        assert!(verify(b"test", &signature, &key, "1.2.3", false).is_ok());
        assert!(verify(b"Test", &signature, &key, "1.2.3", false).is_err());
    }
}
