mod store;

mod validate;

use super::{Error, Result, fs};
use serde_json::Value;
use std::{collections::HashSet, path::Path};
pub use store::load;
pub(crate) use store::load_popular;
pub(crate) use validate::validate_items;

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
/// Pretty-print the already ECMAScript-serialized JSON without changing number
/// spelling or numeric property enumeration. Persisted products match Node bytes.
pub fn json_text(value: &Value) -> String {
    let compact = crate::storage::stringify(value);
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
                    output.extend(std::iter::repeat_n(' ', depth * 2));
                }
            }
            '}' | ']' => {
                depth -= 1;
                if !matches!(previous, '{' | '[') {
                    output.push('\n');
                    output.extend(std::iter::repeat_n(' ', depth * 2));
                }
                output.push(c);
            }
            ',' => {
                output.push_str(",\n");
                output.extend(std::iter::repeat_n(' ', depth * 2));
            }
            ':' => output.push_str(": "),
            _ => output.push(c),
        }
        previous = c;
    }
    output.push('\n');
    output
}
