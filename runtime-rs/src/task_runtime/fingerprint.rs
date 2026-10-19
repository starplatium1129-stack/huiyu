use crate::error::{ApiError, Result};
use icu_collator::{Collator, CollatorBorrowed, options::CollatorOptions};
use icu_locale::Locale;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{BufWriter, Write};

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
        // Hash the same locale-ordered byte stream without retaining another
        // complete encoded recipe, context or batch in memory.
        let mut out = BufWriter::with_capacity(8 * 1024, Sha256::new());
        self.write(value, &mut out);
        out.flush().expect("Hash writer is infallible");
        hex::encode(out.into_inner().unwrap().finalize())
    }
    fn write(&self, value: &Value, out: &mut impl Write) {
        match value {
            Value::Object(map) => {
                let mut pairs: Vec<_> = map.iter().collect();
                pairs.sort_by(|(a, _), (b, _)| self.collator.compare(a, b));
                out.write_all(b"{").unwrap();
                for (index, (key, value)) in pairs.into_iter().enumerate() {
                    if index > 0 {
                        out.write_all(b",").unwrap();
                    }
                    serde_json::to_writer(&mut *out, key).unwrap();
                    out.write_all(b":").unwrap();
                    self.write(value, out);
                }
                out.write_all(b"}").unwrap();
            }
            Value::Array(values) => {
                out.write_all(b"[").unwrap();
                for (index, value) in values.iter().enumerate() {
                    if index > 0 {
                        out.write_all(b",").unwrap();
                    }
                    self.write(value, out);
                }
                out.write_all(b"]").unwrap();
            }
            Value::Number(number) => {
                out.write_all(
                    ryu_js::Buffer::new()
                        .format(number.as_f64().unwrap())
                        .as_bytes(),
                )
                .unwrap();
            }
            _ => serde_json::to_writer(out, value).unwrap(),
        }
    }
}
