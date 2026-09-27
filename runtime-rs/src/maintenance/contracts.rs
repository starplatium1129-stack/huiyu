mod artifacts;
mod core;
mod popular;
mod references;
#[cfg(test)]
pub(in crate::maintenance) mod tests;

use super::{Error, Options, Result, fs};
use serde_json::{Value, json};
use std::{collections::HashSet, path::Path};

pub(super) fn validate(options: &Options) -> Result<Value> {
    let mut issues = Vec::new();
    let root = &options.root;
    let data = match (
        read(root, "data/characters.json"),
        read(root, "data/loras.json"),
        read(root, "data/scenes.json"),
    ) {
        (Ok(characters), Ok(loras), Ok(scenes)) => {
            Some(json!({"characters":characters,"loras":loras,"scenes":scenes}))
        }
        results => {
            for result in [results.0, results.1, results.2] {
                if let Err(error) = result {
                    issues.push(error);
                }
            }
            None
        }
    };
    if let Some(data) = &data {
        core::validate(root, data, &mut issues);
        core::shards(root, data, &mut issues);
    }
    popular::validate(root, &mut issues);
    artifacts::validate(root, &mut issues);
    let reference = references::validate(root, &mut issues);
    match super::scenes::sync_version(root) {
        Ok(version) => match std::fs::read_to_string(root.join("src/stores/sceneStore.ts")) {
            Ok(source) => {
                if !regex::Regex::new(r#"from\s+['"]virtual:data-version['"]"#)
                    .unwrap()
                    .is_match(&source)
                {
                    let version_re = regex::Regex::new(r"DATA_VERSION\s*=\s*(\d+)").unwrap();
                    match version_re.captures(&source).and_then(|m|m[1].parse::<u64>().ok()) {
                            Some(actual) if actual!=version=>issues.push(format!("DATA_VERSION mismatch: sceneStore.ts has {actual}, data content expects {version}")),
                            None=>issues.push("sceneStore.ts is missing DATA_VERSION or virtual:data-version".into()),
                            _=>{},
                        }
                }
            }
            Err(error) => issues.push(format!(
                "src/stores/sceneStore.ts is missing or unreadable: {error}"
            )),
        },
        Err(error) => issues.push(format!("DATA_VERSION 计算失败: {error}")),
    }
    if !issues.is_empty() {
        let mut error = Error::invalid("内容契约校验未通过");
        error.extra = json!({"stage":"validate-content-contracts","issues":issues}).into();
        return Err(error);
    }
    let data = data.unwrap();
    Ok(
        json!({"stage":"validate-content-contracts","characters":list(&data["characters"]).len(),"loras":list(&data["loras"]).len(),"scenes":list(&data["scenes"]).len(),"referenceAudit":reference}),
    )
}
fn read(root: &Path, relative: &str) -> std::result::Result<Value, String> {
    std::fs::read(root.join(relative))
        .map_err(|e| format!("{relative} is missing or unreadable: {e}"))
        .and_then(|bytes| {
            serde_json::from_slice(&bytes).map_err(|e| format!("{relative} cannot be parsed: {e}"))
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
