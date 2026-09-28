mod planner;
mod store;
#[cfg(test)]
mod tests;
mod validate;

use super::{Error, Options, Result, fs, transaction::Transaction};
pub use planner::plan;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
};
pub(crate) use store::load_popular;
pub use store::{Prepared, aggregate_is_current, load, prepare};
pub use validate::{changed, collection};

fn js(value: &Value) -> String {
    crate::storage::stringify(value)
}
fn same(left: &Value, right: &Value) -> bool {
    js(left) == js(right)
}
fn quoted(value: Option<&Value>) -> String {
    value.map(js).unwrap_or_else(|| "undefined".into())
}
fn failure(problems: Vec<String>) -> Error {
    let mut error = Error::new(
        400,
        "BLUEPRINT_CHANGE_PLAN",
        format!("蓝图变更规划失败: {}", problems.join("；")),
    );
    error.extra = json!({"problems":problems}).into();
    error
}
fn reserved(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    matches!(name.as_str(), "con" | "prn" | "aux" | "nul")
        || ((name.starts_with("com") || name.starts_with("lpt"))
            && name.len() == 4
            && matches!(name.as_bytes()[3], b'1'..=b'9'))
}
fn safe_name(name: &str) -> bool {
    name.ends_with(".json")
        && name
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        && !name.eq_ignore_ascii_case("manifest.json")
        && !reserved(name.split('.').next().unwrap_or(""))
}
pub fn franchise_slug(franchise: &str) -> String {
    let mut output = String::new();
    let mut separator = false;
    for c in franchise.to_lowercase().chars() {
        if c == '\'' {
            continue;
        }
        if c.is_ascii_alphanumeric() {
            if separator && !output.is_empty() {
                output.push('-');
            }
            output.push(c);
            separator = false;
        } else {
            separator = true;
        }
    }
    if output.is_empty() {
        "unknown".into()
    } else {
        output
    }
}
/// Pretty-print the already ECMAScript-serialized JSON without changing number
/// spelling or numeric property enumeration. Persisted products match Node bytes.
pub fn json_text(value: &Value) -> String {
    let compact = js(value);
    let mut output = String::new();
    let mut characters = compact.chars().peekable();
    let (mut depth, mut quoted, mut escaped, mut previous) = (0usize, false, false, '\0');
    while let Some(c) = characters.next() {
        if quoted {
            output.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                quoted = false;
            }
            previous = c;
            continue;
        }
        match c {
            '"' => {
                quoted = true;
                output.push(c);
            }
            '{' | '[' => {
                output.push(c);
                depth += 1;
                if !matches!(characters.peek(), Some('}' | ']')) {
                    output.push('\n');
                    output.push_str(&"  ".repeat(depth));
                }
            }
            '}' | ']' => {
                depth -= 1;
                if !matches!(previous, '{' | '[') {
                    output.push('\n');
                    output.push_str(&"  ".repeat(depth));
                }
                output.push(c);
            }
            ',' => {
                output.push_str(",\n");
                output.push_str(&"  ".repeat(depth));
            }
            ':' => output.push_str(": "),
            _ => output.push(c),
        }
        previous = c;
    }
    output.push('\n');
    output
}
