use serde_json::{Map, Value};

fn directory(value: Value) -> Option<Value> {
    let mut row = match value {
        Value::Array(rows) => {
            return Some(Value::Array(
                rows.into_iter().filter_map(directory).collect(),
            ));
        }
        Value::Object(row) => row,
        _ => return None,
    };
    let id = row.get("id")?.as_str()?;
    if !matches!(
        row.get("rating").and_then(Value::as_str),
        Some("All" | "R15" | "R18")
    ) || id
        .trim_matches(|ch: char| ch.is_whitespace() || ch == '\u{feff}')
        .is_empty()
    {
        return None;
    }
    let mut output = Map::new();
    for key in ["id", "rating"] {
        output.insert(key.into(), row.remove(key).unwrap());
    }
    for key in ["mature", "isNsfw", "nsfw"] {
        if row.get(key).is_some_and(Value::is_boolean) {
            output.insert(key.into(), row.remove(key).unwrap());
        }
    }
    for key in [
        "name",
        "nameZh",
        "title",
        "titleZh",
        "franchise",
        "category",
        "character",
        "char",
        "type",
    ] {
        if row.get(key).is_some_and(Value::is_string) {
            output.insert(key.into(), row.remove(key).unwrap());
        }
    }
    Some(Value::Object(output))
}
pub(super) fn project(name: &str, mut value: Value) -> Value {
    let project_rows = |value: Value| {
        if value.is_array() {
            directory(value).unwrap()
        } else {
            Value::Array(Vec::new())
        }
    };
    let field = match name {
        "popular-characters.json" => Some("characters"),
        "manifest.json" => Some("entries"),
        _ => None,
    };
    if let Some(field) = field {
        let rows = value.get_mut(field).map(Value::take).unwrap_or(Value::Null);
        let mut output = Map::new();
        output.insert(field.into(), project_rows(rows));
        Value::Object(output)
    } else {
        project_rows(value)
    }
}
