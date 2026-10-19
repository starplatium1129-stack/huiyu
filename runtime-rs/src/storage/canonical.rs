use super::*;
use sha2::{Digest, Sha256};
use std::io::{BufWriter, Write};

pub(super) fn digest(bytes: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(bytes.as_ref()))
}

// ECMAScript enumerates array-index keys numerically even after lexicographic insertion.
// Non-index keys use UTF-16 order; Rust's Unicode scalar ordering differs for astral text.
fn index(key: &str) -> Option<u32> {
    if key == "0" {
        return Some(0);
    }
    if !key.as_bytes().first().is_some_and(|c| matches!(c, b'1'..=b'9')) {
        return None;
    }
    let number: u32 = key.parse().ok()?;
    (number != u32::MAX).then_some(number)
}
fn write_object<'a>(
    entries: impl IntoIterator<Item = (&'a String, &'a Value)>,
    canonical: bool,
    output: &mut impl Write,
) {
    output.write_all(b"{").unwrap();
    for (i, (key, value)) in entries.into_iter().enumerate() {
        if i > 0 {
            output.write_all(b",").unwrap();
        }
        serde_json::to_writer(&mut *output, key).unwrap();
        output.write_all(b":").unwrap();
        write(value, canonical, output);
    }
    output.write_all(b"}").unwrap();
}
fn write_sorted_object<'a>(
    entries: impl IntoIterator<Item = (&'a String, &'a Value)>,
    canonical: bool,
    output: &mut impl Write,
) {
    let mut entries: Vec<_> = entries.into_iter().collect();
    entries.sort_by(|(a, _), (b, _)| match (index(a), index(b)) {
        (Some(a), Some(b)) => a.cmp(&b),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        _ if canonical => a.encode_utf16().cmp(b.encode_utf16()),
        _ => std::cmp::Ordering::Equal,
    });
    write_object(entries, canonical, output);
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
            // preserve_order already retains insertion order. Ordinary records
            // without array-index keys need neither a key buffer nor a sort.
            if !canonical && !object.keys().any(|key| index(key).is_some()) {
                write_object(object, canonical, output);
                return;
            }
            write_sorted_object(object, canonical, output);
        }
        _ => serde_json::to_writer(output, value).unwrap(),
    }
}
pub(crate) fn stringify(value: &Value) -> String {
    let mut out = Vec::new();
    write(value, false, &mut out);
    String::from_utf8(out).expect("JSON writer only emits UTF-8")
}
pub(crate) fn stringify_object<'a>(
    entries: impl IntoIterator<Item = (&'a String, &'a Value)>,
) -> String {
    let mut out = Vec::new();
    write_sorted_object(entries, false, &mut out);
    String::from_utf8(out).expect("JSON writer only emits UTF-8")
}
// Match stringify's JS numbers and index-key ordering without encoding either tree.
pub(crate) fn stringify_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => left.as_f64().unwrap() == right.as_f64().unwrap(),
        (Value::Array(left), Value::Array(right)) => {
            left.len() == right.len()
                && left.iter().zip(right).all(|(left, right)| stringify_equal(left, right))
        }
        (Value::Object(left), Value::Object(right)) => {
            left.len() == right.len()
                && left.keys().filter(|key| index(key).is_none())
                    .eq(right.keys().filter(|key| index(key).is_none()))
                && left.iter().all(|(key, left)| {
                    right.get(key).is_some_and(|right| stringify_equal(left, right))
                })
        }
        _ => left == right,
    }
}
pub fn fingerprint(value: &Value) -> String {
    // Preserve the exact canonical byte stream without retaining a second
    // encoded copy of large drafts, chat histories or artwork recipes.
    let mut out = BufWriter::with_capacity(8 * 1024, Sha256::new());
    write(value, true, &mut out);
    out.flush().expect("Hash writer is infallible");
    hex::encode(out.into_inner().unwrap().finalize())
}
pub(super) fn fingerprint_object<'a>(
    entries: impl IntoIterator<Item = (&'a String, &'a Value)>,
) -> String {
    let mut out = BufWriter::with_capacity(8 * 1024, Sha256::new());
    write_sorted_object(entries, true, &mut out);
    out.flush().expect("Hash writer is infallible");
    hex::encode(out.into_inner().unwrap().finalize())
}
// Root fields keep the caller's order; nested values use stringify's encoding.
pub(crate) fn digest_object<'a>(
    entries: impl IntoIterator<Item = (&'a String, &'a Value)>,
) -> String {
    let mut out = BufWriter::with_capacity(8 * 1024, Sha256::new());
    write_object(entries, false, &mut out);
    out.flush().expect("Hash writer is infallible");
    hex::encode(out.into_inner().unwrap().finalize())
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
