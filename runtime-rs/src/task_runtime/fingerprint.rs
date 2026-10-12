use crate::error::{ApiError, Result};
use icu_collator::{Collator, CollatorBorrowed, options::CollatorOptions};
use icu_locale::Locale;
use serde_json::Value;
use sha2::{Digest, Sha256};

/// The existing task ledger uses String.localeCompare, unlike workspace operation
/// hashes (UTF-16 key order). Keep the two codecs separate so retries never
/// silently acquire a different identity during the runtime migration.
pub struct Fingerprint {
    collator: CollatorBorrowed<'static>,
    pub locale: String,
}
impl Fingerprint {
    pub fn system() -> Result<Self> {
        Self::new(&crate::collation::system_locale())
    }
    pub fn new(locale: &str) -> Result<Self> {
        let parsed: Locale = locale.parse().map_err(|_| {
            ApiError::new(
                503,
                "TASK_FINGERPRINT_LOCALE",
                "Unsupported task fingerprint locale",
            )
        })?;
        let collator =
            Collator::try_new(parsed.into(), CollatorOptions::default()).map_err(|_| {
                ApiError::new(
                    503,
                    "TASK_FINGERPRINT_LOCALE",
                    "Task fingerprint collation unavailable",
                )
            })?;
        Ok(Self {
            collator,
            locale: locale.into(),
        })
    }
    pub fn hash(&self, value: &Value) -> String {
        let mut bytes = Vec::new();
        self.write(value, &mut bytes);
        hex::encode(Sha256::digest(bytes))
    }
    fn write(&self, value: &Value, out: &mut Vec<u8>) {
        match value {
            Value::Object(map) => {
                let mut pairs: Vec<_> = map.iter().collect();
                pairs.sort_by(|(a, _), (b, _)| self.collator.compare(a, b));
                out.push(b'{');
                for (index, (key, value)) in pairs.into_iter().enumerate() {
                    if index > 0 {
                        out.push(b',');
                    }
                    serde_json::to_writer(&mut *out, key).unwrap();
                    out.push(b':');
                    self.write(value, out);
                }
                out.push(b'}');
            }
            Value::Array(values) => {
                out.push(b'[');
                for (index, value) in values.iter().enumerate() {
                    if index > 0 {
                        out.push(b',');
                    }
                    self.write(value, out);
                }
                out.push(b']');
            }
            Value::Number(number) => {
                out.extend_from_slice(
                    ryu_js::Buffer::new()
                        .format(number.as_f64().unwrap())
                        .as_bytes(),
                );
            }
            _ => serde_json::to_writer(out, value).unwrap(),
        }
    }
}
