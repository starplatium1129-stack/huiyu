use crate::{
    error::{ApiError, Result},
    storage::stringify,
};
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
        Self::from_system_locale(sys_locale::get_locale().as_deref())
    }
    fn from_system_locale(locale: Option<&str>) -> Result<Self> {
        let locale = locale.unwrap_or("en-US");
        // sys-locale strips the encoding from C.UTF-8. Match Node/V8's
        // Isolate::DefaultLocale mapping of the ICU C/POSIX fallback to en-US;
        // persisted ledger locales still pass through the strict parser below.
        // https://github.com/nodejs/node/blob/v24.18.0/deps/v8/src/execution/isolate.cc#L6711
        let locale = if ["C", "POSIX", "en-US-POSIX"]
            .iter()
            .any(|fallback| locale.eq_ignore_ascii_case(fallback))
        {
            "en-US"
        } else {
            locale
        };
        Self::new(locale)
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
        let mut bytes = String::new();
        self.write(value, &mut bytes);
        hex::encode(Sha256::digest(bytes.as_bytes()))
    }
    fn write(&self, value: &Value, out: &mut String) {
        match value {
            Value::Object(map) => {
                let mut pairs: Vec<_> = map.iter().collect();
                pairs.sort_by(|(a, _), (b, _)| self.collator.compare(a, b));
                out.push('{');
                for (index, (key, value)) in pairs.into_iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    out.push_str(&stringify(&Value::String(key.clone())));
                    out.push(':');
                    self.write(value, out);
                }
                out.push('}');
            }
            Value::Array(values) => {
                out.push('[');
                for (index, value) in values.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    self.write(value, out);
                }
                out.push(']');
            }
            _ => out.push_str(&stringify(value)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn posix_system_locale_uses_node_fallback_without_changing_ledger_locales() {
        let value = serde_json::json!({"ä": 1, "z": 2, "A": 3, "a": 4});
        let expected = Fingerprint::new("en-US").unwrap().hash(&value);
        for locale in [None, Some("C"), Some("POSIX"), Some("en-US-POSIX")] {
            let codec = Fingerprint::from_system_locale(locale).unwrap();
            assert_eq!(codec.locale, "en-US");
            assert_eq!(codec.hash(&value), expected);
        }
        assert_eq!(
            Fingerprint::new("en-US-posix").unwrap().locale,
            "en-US-posix"
        );
    }
    #[test]
    fn request_identities_match_node_icu_and_json_numbers() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/task-fingerprints.json"))
                .unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let codec = Fingerprint::new(case["locale"].as_str().unwrap()).unwrap();
            assert_eq!(codec.hash(&case["value"]), case["sha256"].as_str().unwrap());
        }
    }
}
