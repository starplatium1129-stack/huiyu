mod artifacts;
mod core;
mod popular;
mod references;
pub(crate) use core::profile_field_issues;
pub(crate) use popular::authored_field_issues;

use super::{Error, Result, fs};
use serde_json::{Value, json};
use std::{borrow::Cow, collections::HashSet, path::Path};

struct DataRoot<'a> {
    path: &'a Path,
    overrides: std::collections::HashMap<String, Value>,
}
impl std::ops::Deref for DataRoot<'_> {
    type Target = Path;
    fn deref(&self) -> &Path {
        self.path
    }
}
impl AsRef<Path> for DataRoot<'_> {
    fn as_ref(&self) -> &Path {
        self.path
    }
}
pub(crate) fn validate_with(
    root: &Path,
    overrides: std::collections::HashMap<String, Value>,
) -> Result<Value> {
    let mut issues = Vec::new();
    let source = DataRoot {
        path: root,
        overrides,
    };
    let root = &source;
    let data = match (
        read(root, "data/characters.json"),
        read(root, "data/loras.json"),
        read(root, "data/scenes.json"),
    ) {
        (Ok(characters), Ok(loras), Ok(scenes)) => Some((characters, loras, scenes)),
        results => {
            for result in [results.0, results.1, results.2] {
                if let Err(error) = result {
                    issues.push(error);
                }
            }
            None
        }
    };
    if let Some((characters, loras, scenes)) = &data {
        core::validate(root, characters, loras, scenes, &mut issues);
    }
    popular::validate(root, &mut issues);
    artifacts::validate(root, &mut issues);
    let reference = references::validate(root, &mut issues);
    if !issues.is_empty() {
        let mut error = Error::invalid("内容契约校验未通过");
        error.extra = json!({"stage":"validate-content-contracts","issues":issues}).into();
        return Err(error);
    }
    let (characters, loras, scenes) = data.unwrap();
    Ok(
        json!({"stage":"validate-content-contracts","characters":list(&characters).len(),"loras":list(&loras).len(),"scenes":list(&scenes).len(),"referenceAudit":reference}),
    )
}
fn read<'a>(root: &'a DataRoot<'_>, relative: &str) -> std::result::Result<Cow<'a, Value>, String> {
    if let Some(value) = root.overrides.get(relative) {
        return Ok(Cow::Borrowed(value));
    }
    std::fs::read(root.join(relative))
        .map_err(|e| format!("{relative} is missing or unreadable: {e}"))
        .and_then(|bytes| {
            serde_json::from_slice(&bytes)
                .map(Cow::Owned)
                .map_err(|e| format!("{relative} cannot be parsed: {e}"))
        })
}
fn list(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Object(_) => "[object Object]".into(),
        Value::Array(a) => a
            .iter()
            .map(|v| if v.is_null() { String::new() } else { text(v) })
            .collect::<Vec<_>>()
            .join(","),
        _ => value.to_string(),
    }
}
fn property(value: &Value, key: &str) -> String {
    value
        .get(key)
        .map(text)
        .unwrap_or_else(|| "undefined".into())
}
fn truthy(value: &Value) -> bool {
    crate::generation::truthy(value)
}
fn number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.,
        Some(Value::Bool(v)) => {
            if *v {
                1.
            } else {
                0.
            }
        }
        Some(Value::Number(v)) => v.as_f64().unwrap_or(f64::NAN),
        Some(value) => {
            let s = text(value);
            let s = s.trim();
            if s.is_empty() {
                0.
            } else {
                s.parse().unwrap_or(f64::NAN)
            }
        }
    }
}
fn key(value: Option<&Value>) -> String {
    value
        .map(crate::storage::stringify)
        .unwrap_or_else(|| "undefined".into())
}
