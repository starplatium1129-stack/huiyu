use axum::http::HeaderMap;
use std::{
    path::{Path, PathBuf},
    time::SystemTime,
};

pub(crate) fn content_type(path: &str) -> Option<&'static str> {
    match path.rsplit_once('.')?.1.to_ascii_lowercase().as_str() {
        "js" => Some("application/javascript; charset=utf-8"),
        "css" => Some("text/css; charset=utf-8"),
        "html" => Some("text/html; charset=utf-8"),
        "json" | "map" => Some("application/json; charset=utf-8"),
        "svg" => Some("image/svg+xml; charset=utf-8"),
        "txt" => Some("text/plain; charset=utf-8"),
        _ => None,
    }
}
pub(crate) fn quality(header: &str, encoding: &str) -> f32 {
    let mut wildcard = None;
    let mut exact = None;
    for item in header.split(',') {
        let mut fields = item.trim().split(';');
        let name = fields.next().unwrap_or("").trim();
        let q = fields
            .find_map(|field| field.trim().strip_prefix("q="))
            .map(|q| {
                q.parse::<f32>()
                    .ok()
                    .filter(|q| q.is_finite() && (0.0..=1.0).contains(q))
                    .unwrap_or(0.0)
            })
            .unwrap_or(1.0);
        if name.eq_ignore_ascii_case(encoding) {
            exact = Some(q);
        } else if name == "*" {
            wildcard = Some(q);
        }
    }
    exact.or(wildcard).unwrap_or(0.0)
}

/// Use the already confined and inspected source. Sidecars get their own
/// confinement check because a valid source does not authorize its siblings.
pub(crate) async fn select(
    root: &Path,
    source: &Path,
    modified: SystemTime,
    headers: &HeaderMap,
) -> Option<(PathBuf, &'static str)> {
    let encoding = headers.get("accept-encoding")?.to_str().ok()?;
    let mut candidates = [
        ("br", ".br", quality(encoding, "br")),
        ("gzip", ".gz", quality(encoding, "gzip")),
    ];
    if candidates[1].2 > candidates[0].2 {
        candidates.swap(0, 1);
    }
    for (name, suffix, score) in candidates {
        if score == 0.0 {
            break;
        }
        let mut sibling = source.as_os_str().to_os_string();
        sibling.push(suffix);
        let Ok(file) = tokio::fs::canonicalize(sibling).await else {
            continue;
        };
        if file.starts_with(root)
            && tokio::fs::metadata(&file).await.is_ok_and(|meta| {
                meta.is_file() && meta.modified().is_ok_and(|time| time >= modified)
            })
        {
            return Some((file, name));
        }
    }
    None
}
