use super::*;
use std::collections::BTreeSet;

pub(super) const FIELDS: [&str; 6] = ["engine", "model", "outfit", "seed", "size", "reviewState"];
fn text<'a>(body: &'a Value, key: &str) -> &'a str {
    body[key].as_str().unwrap_or("").trim()
}
fn strings(body: &Value, key: &str) -> Vec<String> {
    body[key]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}
fn seed(value: &Value) -> String {
    if let Some(s) = value.as_str() {
        let s = s.trim();
        let digits = s.strip_prefix('-').unwrap_or(s);
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return String::new();
        }
        let digits = digits.trim_start_matches('0');
        return if digits.is_empty() {
            "0".into()
        } else {
            format!("{}{digits}", if s.starts_with('-') { "-" } else { "" })
        };
    }
    value
        .as_f64()
        .filter(|v| v.is_finite() && v.fract() == 0.0 && v.abs() <= 9_007_199_254_740_991.0)
        .map(|v| {
            if v == 0.0 {
                "0".into()
            } else {
                format!("{v:.0}")
            }
        })
        .unwrap_or_default()
}
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(n) => n.as_f64().is_some_and(|v| v != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
pub(super) fn facets(body: &Value) -> Value {
    let role = if text(body, "characterId").is_empty() {
        text(body, "character")
    } else {
        text(body, "characterId")
    };
    let characters: BTreeSet<String> = std::iter::once(role.to_owned())
        .chain(strings(body, "characterIds"))
        .filter(|s| !s.is_empty())
        .flat_map(|s| {
            if s == "triad" || s == "both" {
                vec!["nene".into(), "natsume".into()]
            } else {
                vec![s]
            }
        })
        .collect();
    let tags: BTreeSet<String> = ["collectionTags", "manual_tags", "tags"]
        .into_iter()
        .flat_map(|key| strings(body, key))
        .collect();
    let size = text(body, "size");
    static SIZE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let normalized_size = SIZE
        .get_or_init(|| regex::Regex::new(r"(?i)^(\d+)\s*[x×]\s*(\d+)$").unwrap())
        .captures(size)
        .and_then(|m| Some((m[1].parse::<u64>().ok()?, m[2].parse::<u64>().ok()?)))
        .filter(|(w, h)| *w > 0 && *h > 0)
        .map(|(w, h)| format!("{w}x{h}"))
        .unwrap_or_else(|| size.into());
    let one = |s: String| if s.is_empty() { vec![] } else { vec![s] };
    let model: BTreeSet<_> = [text(body, "checkpoint"), text(body, "model")]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect();
    let outfit = if !role.is_empty() && !text(body, "outfitId").is_empty() {
        serde_json::to_string(&[role, text(body, "outfitId")]).unwrap()
    } else {
        String::new()
    };
    json!({"characters":characters,"tags":tags,"favorite":truthy(&body["favorite"]),"generation":{
        "engine":one(text(body,"engine").into()),"model":model,"outfit":one(outfit),"seed":one(seed(&body["seed"])),"size":one(normalized_size),
        "reviewState":one(if ["candidate","preferred","rejected"].contains(&body["reviewState"].as_str().unwrap_or("")) { text(body,"reviewState").into() } else { String::new() })}})
}
pub(super) fn time(body: &Value) -> f64 {
    body["timestamp"]
        .as_f64()
        .filter(|n| n.is_finite())
        .or_else(|| {
            let s = body["timestamp"].as_str()?;
            chrono::DateTime::parse_from_rfc3339(s)
                .ok()
                .map(|d| d.timestamp_millis() as f64)
                .or_else(|| {
                    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
                        .ok()
                        .and_then(|d| d.and_hms_opt(0, 0, 0))
                        .map(|d| d.and_utc().timestamp_millis() as f64)
                })
        })
        .or_else(|| {
            body["id"]
                .as_f64()
                .or_else(|| body["id"].as_str()?.trim().parse::<f64>().ok())
                .filter(|n| n.is_finite())
        })
        .unwrap_or(0.0)
}
pub(super) fn initialize(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS artwork_gallery_index(id_key TEXT PRIMARY KEY, facets TEXT NOT NULL, time REAL NOT NULL);
        CREATE INDEX IF NOT EXISTS artwork_gallery_time ON artwork_gallery_index(time DESC,id_key);
        CREATE INDEX IF NOT EXISTS artwork_gallery_favorite ON artwork_gallery_index(json_extract(facets,'$.favorite'),time DESC,id_key);")?;
    let initialized = db
        .prepare("SELECT 1 FROM meta WHERE key='artworkGalleryIndexVersion' AND value='1'")?
        .exists([])?;
    if !initialized {
        db.execute_batch("DELETE FROM artwork_gallery_index; INSERT OR IGNORE INTO artwork_read_dirty SELECT id_key FROM artworks;
        INSERT OR REPLACE INTO meta VALUES('artworkGalleryIndexVersion','1');")?;
    }
    Ok(())
}
