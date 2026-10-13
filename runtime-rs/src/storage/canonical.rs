use super::*;
use sha2::{Digest, Sha256};
use std::io::{self, BufWriter, Write};

pub(super) fn digest(bytes: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(bytes.as_ref()))
}

// ECMAScript enumerates array-index keys numerically even after lexicographic insertion.
// Non-index keys use UTF-16 order; Rust's Unicode scalar ordering differs for astral text.
fn index(key: &str) -> Option<u32> {
    let number: u32 = key.parse().ok()?;
    (number != u32::MAX && number.to_string() == key).then_some(number)
}
fn write(value: &Value, canonical: bool, output: &mut impl Write) {
    match value {
        Value::Number(n) => {
            output
                .write_all(ryu_js::Buffer::new().format(n.as_f64().unwrap()).as_bytes())
                .unwrap();
        }
        Value::Array(items) => {
            output.write_all(b"[").unwrap();
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    output.write_all(b",").unwrap();
                }
                write(item, canonical, output);
            }
            output.write_all(b"]").unwrap();
        }
        Value::Object(object) => {
            let mut keys: Vec<_> = object.keys().collect();
            keys.sort_by(|a, b| match (index(a), index(b)) {
                (Some(a), Some(b)) => a.cmp(&b),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                _ if canonical => a.encode_utf16().cmp(b.encode_utf16()),
                _ => std::cmp::Ordering::Equal,
            });
            output.write_all(b"{").unwrap();
            for (i, key) in keys.into_iter().enumerate() {
                if i > 0 {
                    output.write_all(b",").unwrap();
                }
                serde_json::to_writer(&mut *output, key).unwrap();
                output.write_all(b":").unwrap();
                write(&object[key], canonical, output);
            }
            output.write_all(b"}").unwrap();
        }
        _ => serde_json::to_writer(output, value).unwrap(),
    }
}
pub(crate) fn stringify(value: &Value) -> String {
    let mut out = Vec::new();
    write(value, false, &mut out);
    String::from_utf8(out).expect("JSON writer only emits UTF-8")
}
pub fn fingerprint(value: &Value) -> String {
    // Preserve the exact canonical byte stream without retaining a second
    // encoded copy of large drafts, chat histories or artwork recipes.
    let mut out = BufWriter::with_capacity(8 * 1024, HashWriter(Sha256::new()));
    write(value, true, &mut out);
    out.flush().expect("Hash writer is infallible");
    hex::encode(out.into_inner().unwrap().0.finalize())
}
#[derive(Debug)]
struct HashWriter(Sha256);
impl Write for HashWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
pub(super) fn entity_key(id: &Value) -> Result<String> {
    match id {
        Value::String(id) if !js_trim(id).is_empty() => Ok(js_trim(id).into()),
        Value::Number(id) => Ok(ryu_js::Buffer::new().format(id.as_f64().unwrap()).into()),
        _ => Err(invalid(
            "A stable string or finite numeric entity ID is required",
        )),
    }
}
fn js_trim(value: &str) -> &str {
    value.trim_matches(|c|matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'))
}
