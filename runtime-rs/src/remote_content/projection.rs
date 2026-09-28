use serde_json::{Value, json};

fn directory(value: &Value) -> Option<Value> {
    if let Some(rows) = value.as_array() {
        return Some(Value::Array(rows.iter().filter_map(directory).collect()));
    }
    let row = value.as_object()?;
    let id = row.get("id")?.as_str()?;
    if value["rating"] != "All"
        || id
            .trim_matches(|ch: char| ch.is_whitespace() || ch == '\u{feff}')
            .is_empty()
        || ["mature", "isNsfw", "nsfw"]
            .iter()
            .any(|key| row.get(*key).is_some_and(|value| value != false))
    {
        return None;
    }
    let mut output = json!({"id":id,"rating":"All"});
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
        if value[key].is_string() {
            output[key] = value[key].clone();
        }
    }
    Some(output)
}
pub(super) fn project(name: &str, value: &Value) -> Value {
    let project_rows = |value: &Value| {
        if value.is_array() {
            directory(value).unwrap_or(json!([]))
        } else {
            json!([])
        }
    };
    match name {
        "popular-characters.json" => json!({"characters":project_rows(&value["characters"])}),
        "manifest.json" => json!({"entries":project_rows(&value["entries"])}),
        _ => project_rows(value),
    }
}
