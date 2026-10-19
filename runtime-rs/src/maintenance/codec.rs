use super::{Error, Result};
use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{self, BufWriter, Write};

fn canonical(value: &Value, output: &mut impl Write) {
    match value {
        Value::Array(values) => {
            output.write_all(b"[").unwrap();
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.write_all(b",").unwrap();
                }
                canonical(value, output);
            }
            output.write_all(b"]").unwrap();
        }
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            output.write_all(b"{").unwrap();
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    output.write_all(b",").unwrap();
                }
                serde_json::to_writer(&mut *output, key).unwrap();
                output.write_all(b":").unwrap();
                canonical(&values[key], output);
            }
            output.write_all(b"}").unwrap();
        }
        Value::Number(value) => output.write_all(
            ryu_js::Buffer::new().format(value.as_f64().unwrap()).as_bytes(),
        ).unwrap(),
        other => serde_json::to_writer(output, other).unwrap(),
    }
}
struct MacWriter<'a>(&'a mut Hmac<Sha256>);
impl Write for MacWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> { Ok(()) }
}
fn canonical_mac(value: &Value, key: &[u8]) -> Hmac<Sha256> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts arbitrary keys");
    {
        let mut output = BufWriter::with_capacity(8 * 1024, MacWriter(&mut mac));
        canonical(value, &mut output);
        output.flush().expect("MAC writer is infallible");
    }
    mac
}
pub(super) fn digest(value: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(value.as_ref()))
}
pub(super) fn equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        // Canonical numbers use ECMAScript f64 rounding, including -0 == 0.
        (Value::Number(left), Value::Number(right)) => left.as_f64().unwrap() == right.as_f64().unwrap(),
        (Value::Array(left), Value::Array(right)) => {
            left.len() == right.len() && left.iter().zip(right).all(|(left, right)| equal(left, right))
        }
        (Value::Object(left), Value::Object(right)) => {
            left.len() == right.len()
                && left.iter().all(|(key, left)| right.get(key).is_some_and(|right| equal(left, right)))
        }
        _ => left == right,
    }
}
pub(super) fn seal(mut value: Value, key: &[u8]) -> Value {
    let mac = canonical_mac(&value, key);
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
    let mac = canonical_mac(&value, key);
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
