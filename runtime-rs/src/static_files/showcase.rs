use axum::{
    body::{Body, Bytes},
    http::HeaderValue,
    response::{IntoResponse, Response},
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{LazyLock, RwLock},
    time::SystemTime,
};

#[derive(Clone, PartialEq)]
struct Stamp {
    length: u64,
    modified: Option<SystemTime>,
}
fn stamp(metadata: &fs::Metadata) -> Stamp {
    Stamp {
        length: metadata.len(),
        modified: metadata.modified().ok(),
    }
}
struct ImageSize {
    stamp: Option<Stamp>,
    dimensions: Option<(u32, u32)>,
}
struct Catalogue {
    root: PathBuf,
    stamp: Stamp,
    value: Value,
    images: HashMap<PathBuf, ImageSize>,
    encoded: HashMap<&'static str, EncodedCatalogue>,
}
pub(super) enum View {
    Full,
    Cards,
    Index,
    Stories,
    Details(Vec<String>),
}
impl View {
    fn name(&self) -> &'static str {
        match self {
            Self::Full => "geometry", Self::Cards => "cards", Self::Index => "index",
            Self::Stories => "stories", Self::Details(_) => "details",
        }
    }
    fn cacheable(&self) -> bool { !matches!(self, Self::Details(_)) }
}
struct EncodedCatalogue {
    bytes: Bytes,
    gzip: Option<Bytes>,
    tag: String,
}
impl EncodedCatalogue {
    fn body(&self, gzip: bool) -> (Bytes, String) {
        let bytes = if gzip { self.gzip.as_ref().unwrap_or(&self.bytes) } else { &self.bytes };
        (bytes.clone(), self.tag.clone())
    }
}
static CACHE: LazyLock<RwLock<Option<Catalogue>>> = LazyLock::new(|| RwLock::new(None));

fn header_dimensions(path: PathBuf) -> Option<(u32, u32)> {
    let mut file = fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    (&mut file).take(8 * 1024).read_to_end(&mut bytes).ok()?;
    let decode = |bytes: &[u8]| {
        image::ImageReader::new(io::Cursor::new(bytes))
            .with_guessed_format()
            .ok()?
            .into_dimensions()
            .ok()
    };
    if let Some(size) = decode(&bytes) {
        return Some(size);
    }
    file.take(504 * 1024).read_to_end(&mut bytes).ok()?;
    decode(&bytes)
}

// Resolve image geometry on catalogue changes or an explicit refresh. Ordinary
// revalidation must not stat every original and thumbnail before returning 304.
fn image_state(root: &Path, path: &Path) -> (Option<PathBuf>, Option<Stamp>) {
    let resolved = fs::canonicalize(path)
        .ok()
        .filter(|path| path.starts_with(root));
    let metadata = resolved
        .as_ref()
        .and_then(|path| fs::metadata(path).ok())
        .filter(|metadata| metadata.is_file());
    (resolved, metadata.as_ref().map(stamp))
}
fn dimensions(
    root: &Path,
    relative: &str,
    images: &mut HashMap<PathBuf, ImageSize>,
    changed: &mut bool,
) -> Option<(u32, u32)> {
    if !relative.starts_with("thumbs/") && !relative.starts_with("images/") {
        return None;
    }
    if !super::extra::SHOWCASE.is_match(&format!("/{relative}")) {
        return None;
    }
    let path = root.join(relative);
    let (resolved, current) = image_state(root, &path);
    if let Some(previous) = images
        .get(&path)
        .filter(|previous| previous.stamp == current)
    {
        return previous.dimensions;
    }
    *changed = true;
    let size = resolved
        .and_then(header_dimensions)
        .filter(|(width, height)| *width > 0 && *height > 0);
    images.insert(
        path,
        ImageSize {
            stamp: current,
            dimensions: size,
        },
    );
    size
}

fn encode_cards(value: &Value, view: &View) -> io::Result<Bytes> {
    let card_fields = [
        "id", "title", "story", "category", "char", "rating", "attempt", "type",
        "artistId", "displayName", "image", "thumb", "width", "height",
        "thumbWidth", "thumbHeight", "meta",
    ];
    let fields: &[&str] = match view {
        View::Index => &[
            "id", "title", "category", "char", "rating", "attempt", "type", "artistId", "displayName",
            "image", "thumb", "width", "height", "thumbWidth", "thumbHeight",
        ],
        View::Stories => &["id", "story"],
        View::Details(_) => &["id", "title", "story", "category", "meta", "char", "type", "rating"],
        _ => &card_fields,
    };
    let rows: Vec<_> = value["entries"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|row| match view {
            View::Details(ids) => row["id"].as_str().is_some_and(|id| ids.iter().any(|item| item == id)),
            View::Stories => row["story"].as_str().is_some_and(|story| !story.is_empty()),
            _ => true,
        })
        .map(|row| {
            let Some(row) = row.as_object() else {
                return BTreeMap::new();
            };
            let mut card: BTreeMap<_, _> = fields.iter()
                .filter_map(|key| row.get(*key).map(|value| (*key, value)))
                .collect();
            if let Some(id) = row.get("id").and_then(Value::as_str) {
                for (kind, directory) in [("image", "images"), ("thumb", "thumbs")] {
                    if row.get(kind).and_then(Value::as_str)
                        .is_some_and(|path| path == format!("{directory}/{id}.jpg"))
                    {
                        card.remove(kind);
                    }
                }
            }
            // The browser supplies empty captions when the field is absent.
            card.retain(|key, value| !matches!(*key, "story" | "category") || value.as_str() != Some(""));
            card
        })
        .collect();
    #[derive(serde::Serialize)]
    struct Cards<T> { entries: T }
    serde_json::to_vec(&Cards { entries: rows })
        .map(Bytes::from)
        .map_err(io::Error::other)
}

fn encode(value: &Value, view: &View) -> io::Result<EncodedCatalogue> {
    let full = matches!(view, View::Full);
    let bytes = if full {
        Bytes::from(serde_json::to_vec(value).map_err(io::Error::other)?)
    } else {
        encode_cards(value, view)?
    };
    let tag = format!("showcase-{}-1-{}", view.name(), hex::encode(Sha256::digest(&bytes)));
    let gzip = if full {
        None
    } else {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(&bytes)?;
        Some(Bytes::from(encoder.finish()?))
    };
    Ok(EncodedCatalogue { bytes, gzip, tag })
}

fn cached(cache: &Catalogue, view: &View, gzip: bool) -> io::Result<Option<(Bytes, String)>> {
    if !view.cacheable() { return Ok(Some(encode(&cache.value, view)?.body(gzip))); }
    Ok(cache.encoded.get(view.name()).map(|item| item.body(gzip)))
}

fn read(root: PathBuf, refresh: bool, view: &View, gzip: bool) -> io::Result<(Bytes, String)> {
    {
        let canonical = fs::canonicalize(&root)?;
        let file = canonical.join("manifest.json");
        let current = stamp(&fs::metadata(&file)?);
        let lock = CACHE
            .read()
            .map_err(|_| io::Error::other("Showcase cache unavailable"))?;
        if let Some(cache) = lock
            .as_ref()
            .filter(|cache| !refresh && cache.root == canonical && cache.stamp == current)
            && let Some(body) = cached(cache, view, gzip)?
        {
            if stamp(&fs::metadata(&file)?) != current {
                return Err(io::Error::other("Showcase changed while reading"));
            }
            return Ok(body);
        }
    }
    // Drop the read guard before waiting for a writer, then recheck the files.
    let mut lock = CACHE
        .write()
        .map_err(|_| io::Error::other("Showcase cache unavailable"))?;
    let root = fs::canonicalize(root)?;
    let file = root.join("manifest.json");
    let current = stamp(&fs::metadata(&file)?);
    if let Some(cache) = lock
        .as_ref()
        .filter(|cache| !refresh && cache.root == root && cache.stamp == current)
        && let Some(body) = cached(cache, view, gzip)?
    {
        return Ok(body);
    }
    let previous = lock.take();
    let changed = previous
        .as_ref()
        .is_none_or(|cache| cache.root != root || cache.stamp != current);
    let mut cache = if changed {
        drop(previous);
        let mut bytes = Vec::new();
        fs::File::open(&file)?
            .take(32 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 32 * 1024 * 1024 {
            return Err(io::Error::other("Showcase manifest too large"));
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
        if !value.get("entries").is_some_and(Value::is_array) {
            return Err(io::Error::other("Invalid showcase manifest"));
        }
        Catalogue {
            root: root.clone(),
            stamp: current.clone(),
            value,
            images: HashMap::new(),
            encoded: HashMap::new(),
        }
    } else {
        previous.unwrap()
    };
    // Published cards already carry geometry. Only repair it on explicit refresh
    // or when serving the full maintenance manifest.
    let mut geometry_changed = false;
    if (matches!(view, View::Full) || refresh) && let Some(entries) = cache.value["entries"].as_array_mut() {
        for entry in entries {
            let Some(id) = entry["id"].as_str() else {
                continue;
            };
            let image = entry["image"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| format!("images/{id}.jpg"));
            let thumb = entry["thumb"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| format!("thumbs/{id}.jpg"));
            for (relative, width, height) in [
                (&image, "width", "height"),
                (&thumb, "thumbWidth", "thumbHeight"),
            ] {
                if let Some((w, h)) = dimensions(&root, relative, &mut cache.images, &mut geometry_changed) {
                    geometry_changed |= entry[width].as_u64() != Some(u64::from(w))
                        || entry[height].as_u64() != Some(u64::from(h));
                    entry[width] = w.into();
                    entry[height] = h.into();
                } else if let Some(row) = entry.as_object_mut() {
                    geometry_changed |= row.remove(width).is_some();
                    geometry_changed |= row.remove(height).is_some();
                }
            }
        }
    }
    if stamp(&fs::metadata(&file)?) != current {
        return Err(io::Error::other("Showcase changed while reading"));
    }
    if geometry_changed {
        cache.encoded.clear();
    }
    let encoded = encode(&cache.value, view)?;
    let result = encoded.body(gzip);
    if view.cacheable() {
        cache.encoded.insert(view.name(), encoded);
    }
    // Failed reads leave no partly updated catalogue for the shared fast path.
    *lock = Some(cache);
    Ok(result)
}

pub(super) async fn serve(
    root: PathBuf,
    head: bool,
    condition: Option<HeaderValue>,
    refresh: bool,
    view: View,
    gzip: bool,
) -> Response {
    let compressed = !matches!(view, View::Full);
    match tokio::task::spawn_blocking(move || read(root, refresh, &view, gzip)).await {
        Ok(Ok((bytes, tag))) => {
            let length = bytes.len();
            let mut response = (
                [
                    ("content-type", "application/json; charset=utf-8"),
                    ("cache-control", "private, no-cache"),
                    ("access-control-expose-headers", "ETag"),
                ],
                bytes,
            )
                .into_response();
            if head {
                *response.body_mut() = Body::empty();
            }
            if compressed {
                response.headers_mut().append("vary", HeaderValue::from_static("Accept-Encoding"));
            }
            if gzip {
                response.headers_mut().insert("content-encoding", HeaderValue::from_static("gzip"));
            }
            response
                .headers_mut()
                .insert("content-length", length.into());
            super::conditional(response, &tag, condition.as_ref())
        }
        _ => crate::error::ApiError::new(
            503,
            "SHOWCASE_UNAVAILABLE",
            "样张清单暂时无法读取，请重新读取",
        )
        .into_response(),
    }
}
