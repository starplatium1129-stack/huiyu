use axum::{body::{Body, Bytes}, http::HeaderValue, response::{IntoResponse, Response}};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs, io::{self, Read}, path::{Path, PathBuf}, sync::{LazyLock, RwLock}, time::SystemTime};

#[derive(Clone, PartialEq)]
struct Stamp { length: u64, modified: Option<SystemTime> }
fn stamp(metadata: &fs::Metadata) -> Stamp {
    Stamp { length: metadata.len(), modified: metadata.modified().ok() }
}
struct ImageSize { stamp: Option<Stamp>, dimensions: Option<(u32, u32)> }
struct Catalogue {
    root: PathBuf, stamp: Stamp, value: Value,
    images: HashMap<PathBuf, ImageSize>, bytes: Bytes, tag: String,
}
static CACHE: LazyLock<RwLock<Option<Catalogue>>> = LazyLock::new(|| RwLock::new(None));

fn header_dimensions(path: PathBuf) -> Option<(u32, u32)> {
    let mut file = fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    (&mut file).take(8 * 1024).read_to_end(&mut bytes).ok()?;
    let decode = |bytes: &[u8]| image::ImageReader::new(io::Cursor::new(bytes))
        .with_guessed_format().ok()?.into_dimensions().ok();
    if let Some(size) = decode(&bytes) { return Some(size); }
    file.take(504 * 1024).read_to_end(&mut bytes).ok()?;
    decode(&bytes)
}

// Resolve image geometry on catalogue changes or an explicit refresh. Ordinary
// revalidation must not stat every original and thumbnail before returning 304.
fn image_state(root: &Path, path: &Path) -> (Option<PathBuf>, Option<Stamp>) {
    let resolved = fs::canonicalize(path).ok().filter(|path| path.starts_with(root));
    let metadata = resolved.as_ref().and_then(|path| fs::metadata(path).ok()).filter(|metadata| metadata.is_file());
    (resolved, metadata.as_ref().map(stamp))
}
fn dimensions(root: &Path, relative: &str, images: &mut HashMap<PathBuf, ImageSize>, changed: &mut bool) -> Option<(u32, u32)> {
    if !relative.starts_with("thumbs/") && !relative.starts_with("images/") { return None; }
    if !super::extra::SHOWCASE.is_match(&format!("/{relative}")) { return None; }
    let path = root.join(relative);
    let (resolved, current) = image_state(root, &path);
    if let Some(previous) = images.get(&path).filter(|previous| previous.stamp == current) { return previous.dimensions; }
    *changed = true;
    let size = resolved.and_then(header_dimensions).filter(|(width, height)| *width > 0 && *height > 0);
    images.insert(path, ImageSize { stamp: current, dimensions: size });
    size
}

fn read(root: PathBuf, refresh: bool) -> io::Result<(Bytes, String)> {
    {
        let canonical = fs::canonicalize(&root)?;
        let file = canonical.join("manifest.json");
        let current = stamp(&fs::metadata(&file)?);
        let lock = CACHE.read().map_err(|_| io::Error::other("Showcase cache unavailable"))?;
        if let Some(cache) = lock.as_ref().filter(|cache| !refresh && cache.root == canonical && cache.stamp == current) {
            if stamp(&fs::metadata(&file)?) != current { return Err(io::Error::other("Showcase changed while reading")); }
            return Ok((cache.bytes.clone(), cache.tag.clone()));
        }
    }
    // Drop the read guard before waiting for a writer, then recheck the files.
    let mut lock = CACHE.write().map_err(|_| io::Error::other("Showcase cache unavailable"))?;
    let root = fs::canonicalize(root)?;
    let file = root.join("manifest.json");
    let current = stamp(&fs::metadata(&file)?);
    if let Some(cache) = lock.as_ref().filter(|cache| !refresh && cache.root == root && cache.stamp == current) {
        return Ok((cache.bytes.clone(), cache.tag.clone()));
    }
    let previous = lock.take();
    let mut changed = previous.as_ref().is_none_or(|cache| cache.root != root || cache.stamp != current);
    let mut cache = if changed {
        drop(previous);
        let mut bytes = Vec::new();
        fs::File::open(&file)?.take(32 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > 32 * 1024 * 1024 { return Err(io::Error::other("Showcase manifest too large")); }
        let value: Value = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
        if !value.get("entries").is_some_and(Value::is_array) { return Err(io::Error::other("Invalid showcase manifest")); }
        Catalogue { root: root.clone(), stamp: current.clone(), value,
            images: HashMap::new(), bytes: Bytes::new(), tag: String::new() }
    } else { previous.unwrap() };
    if let Some(entries) = cache.value["entries"].as_array_mut() {
        for entry in entries {
            let Some(id) = entry["id"].as_str() else { continue; };
            let image = entry["image"].as_str().map(str::to_owned).unwrap_or_else(|| format!("images/{id}.jpg"));
            let thumb = entry["thumb"].as_str().map(str::to_owned).unwrap_or_else(|| format!("thumbs/{id}.jpg"));
            for (relative, width, height) in [(&image, "width", "height"), (&thumb, "thumbWidth", "thumbHeight")] {
                if let Some((w, h)) = dimensions(&root, relative, &mut cache.images, &mut changed) {
                    entry[width] = w.into(); entry[height] = h.into();
                } else if let Some(row) = entry.as_object_mut() {
                    row.remove(width); row.remove(height);
                }
            }
        }
    }
    if stamp(&fs::metadata(&file)?) != current { return Err(io::Error::other("Showcase changed while reading")); }
    if changed {
        let bytes = serde_json::to_vec(&cache.value).map_err(io::Error::other)?;
        cache.tag = format!("showcase-geometry-1-{}", hex::encode(Sha256::digest(&bytes)));
        cache.bytes = bytes.into();
    }
    let result = (cache.bytes.clone(), cache.tag.clone());
    // Failed reads leave no partly updated catalogue for the shared fast path.
    *lock = Some(cache);
    Ok(result)
}

pub(super) async fn serve(root: PathBuf, head: bool, condition: Option<HeaderValue>, refresh: bool) -> Response {
    match tokio::task::spawn_blocking(move || read(root, refresh)).await {
        Ok(Ok((bytes, tag))) => {
            let length = bytes.len();
            let mut response = ([("content-type", "application/json; charset=utf-8"), ("cache-control", "private, no-cache")], bytes).into_response();
            if head { *response.body_mut() = Body::empty(); }
            response.headers_mut().insert("content-length", length.into());
            super::conditional(response, &tag, condition.as_ref())
        }
        _ => crate::error::ApiError::new(503, "SHOWCASE_UNAVAILABLE", "样张清单暂时无法读取，请重新读取").into_response(),
    }
}
