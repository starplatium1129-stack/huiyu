use super::{Error, Result};
use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub(super) fn canonical(value: &Value) -> String {
    match value {
        Value::Array(values) => format!(
            "[{}]",
            values.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        crate::storage::stringify(&Value::String(key.clone())),
                        canonical(&values[key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        other => crate::storage::stringify(other),
    }
}
pub(super) fn digest(value: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(value.as_ref()))
}
pub(super) fn equal(left: &Value, right: &Value) -> bool {
    canonical(left) == canonical(right)
}
pub(super) fn seal(mut value: Value, key: &[u8]) -> Value {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts arbitrary keys");
    mac.update(canonical(&value).as_bytes());
    value["hmacSha256"] = hex::encode(mac.finalize().into_bytes()).into();
    value
}
pub(super) fn unseal(mut value: Value, key: &[u8]) -> Result<Value> {
    let body = value
        .as_object_mut()
        .ok_or_else(|| Error::journal("签名记录格式无效"))?;
    let signature = body
        .remove("hmacSha256")
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or_else(|| Error::journal("签名记录格式无效"))?;
    if signature.len() != 64
        || !signature
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(Error::journal("元数据签名不匹配，拒绝篡改或损坏记录"));
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts arbitrary keys");
    mac.update(canonical(&value).as_bytes());
    mac.verify_slice(&hex::decode(signature).map_err(|_| Error::journal("签名格式无效"))?)
        .map_err(|_| Error::journal("元数据签名不匹配，拒绝篡改或损坏记录"))?;
    Ok(value)
}
pub(super) fn timestamp() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(millis)
        .expect("Current UTC timestamp is representable")
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
