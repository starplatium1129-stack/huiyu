use axum::{
    body::{Body, Bytes},
    http::{HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use image::{
    ImageDecoder, ImageReader,
    codecs::{jpeg::JpegEncoder, webp::WebPEncoder},
    imageops::FilterType,
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{File, Metadata},
    io::{Cursor, Read},
    num::NonZeroUsize,
    path::PathBuf,
    sync::{Arc, LazyLock, Mutex, Weak},
};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard, Semaphore};

const CACHE_BYTES: usize = 24 * 1024 * 1024;
const CACHE_ENTRIES: usize = 256;
const MAX_SOURCE_BYTES: usize = 32 * 1024 * 1024;

static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(|| {
    Mutex::new(Cache {
        entries: lru::LruCache::new(NonZeroUsize::new(CACHE_ENTRIES).unwrap()),
        bytes: 0,
    })
});
static FLIGHTS: LazyLock<Mutex<HashMap<String, Weak<AsyncMutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static DECODERS: Semaphore = Semaphore::const_new(2);

#[derive(Clone)]
pub(crate) struct Preview {
    pub(crate) bytes: Bytes,
    pub(crate) mime: &'static str,
    width: u32,
}

struct Cache {
    entries: lru::LruCache<String, Preview>,
    bytes: usize,
}

fn get(key: &str) -> Option<Preview> {
    CACHE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .entries
        .get(key)
        .cloned()
}

fn insert(key: String, preview: Preview) {
    if preview.bytes.len() > CACHE_BYTES {
        return;
    }
    let mut cache = CACHE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(old) = cache.entries.pop(&key) {
        cache.bytes -= old.bytes.len();
    }
    while cache.entries.len() >= CACHE_ENTRIES || cache.bytes + preview.bytes.len() > CACHE_BYTES {
        let Some((_, old)) = cache.entries.pop_lru() else {
            break;
        };
        cache.bytes -= old.bytes.len();
    }
    cache.bytes += preview.bytes.len();
    cache.entries.put(key, preview);
}

pub(crate) fn cached(key: String, make: impl FnOnce() -> Option<Preview>) -> Option<Preview> {
    if let Some(preview) = get(&key) {
        return Some(preview);
    }
    let preview = make()?;
    insert(key, preview.clone());
    Some(preview)
}

async fn flight(key: &str) -> OwnedMutexGuard<()> {
    let lock = {
        let mut flights = FLIGHTS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        flights.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = flights.get(key).and_then(Weak::upgrade) {
            lock
        } else {
            let lock = Arc::new(AsyncMutex::new(()));
            flights.insert(key.into(), Arc::downgrade(&lock));
            lock
        }
    };
    lock.lock_owned().await
}

pub(crate) fn resize(bytes: &[u8], max_width: u32, webp: bool) -> Option<Preview> {
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    let mut decoder = reader.into_decoder().ok()?;
    let (width, height) = decoder.dimensions();
    if width == 0
        || height == 0
        || width > 8192
        || height > 8192
        || u64::from(width) * u64::from(height) > 32 * 1024 * 1024
    {
        return None;
    }
    if decoder.icc_profile().ok()?.is_some() {
        return None;
    }
    let orientation = decoder.orientation().ok()?;
    let mut image = image::DynamicImage::from_decoder(decoder).ok()?;
    image.apply_orientation(orientation);
    if image.width() > max_width {
        let height = ((u64::from(image.height()) * u64::from(max_width)
            + u64::from(image.width()) / 2)
            / u64::from(image.width()))
        .max(1) as u32;
        image = image.resize_exact(max_width, height, FilterType::Triangle);
    }
    let mut encoded = Vec::new();
    let (width, height) = (image.width(), image.height());
    let alpha = image.color().has_alpha()
        && image
            .as_rgba8()
            .is_none_or(|rgba| rgba.pixels().any(|pixel| pixel[3] != u8::MAX));
    let mime = if webp || alpha {
        WebPEncoder::new_lossless(&mut encoded)
            .encode(
                &image.to_rgba8(),
                width,
                height,
                image::ExtendedColorType::Rgba8,
            )
            .ok()?;
        "image/webp"
    } else {
        JpegEncoder::new_with_quality(&mut encoded, 82)
            .encode_image(&image.to_rgb8())
            .ok()?;
        "image/jpeg"
    };
    Some(Preview {
        bytes: encoded.into(),
        mime,
        width,
    })
}

pub(super) async fn serve(
    file: PathBuf,
    metadata: Metadata,
    width: u32,
    head: bool,
    condition: Option<HeaderValue>,
    immutable: bool,
) -> Response {
    let cache = if immutable {
        "private, max-age=31536000, immutable"
    } else {
        "private, no-cache"
    };
    let length = metadata.len();
    let modified = metadata.modified().ok();
    let created = metadata.created().ok();
    let key = format!("showcase-v2/{file:?}/{length}/{modified:?}/{created:?}/{width}");
    let tag = hex::encode(Sha256::digest(key.as_bytes()));
    let etag = super::validator(&tag, "identity");
    if super::matches_condition(condition.as_ref(), &etag, false) {
        return super::conditional(
            (
                StatusCode::OK,
                [
                    ("cache-control", cache),
                    (
                        "access-control-expose-headers",
                        "ETag, X-Huiyu-Preview-Width",
                    ),
                ],
            )
                .into_response(),
            &tag,
            condition.as_ref(),
        );
    }

    let image = if let Some(image) = get(&key) {
        Some(image)
    } else {
        // Coalesce by source version and width before consuming a decoder.
        let flight = flight(&key).await;
        if let Some(image) = get(&key) {
            Some(image)
        } else {
            if length > MAX_SOURCE_BYTES as u64 {
                return StatusCode::NOT_FOUND.into_response();
            }
            let Ok(permit) = DECODERS.acquire().await else {
                return StatusCode::SERVICE_UNAVAILABLE.into_response();
            };
            tokio::task::spawn_blocking(move || {
                let (_permit, _flight) = (permit, flight);
                cached(key, || {
                    let mut input = File::open(&file).ok()?;
                    let stat = input.metadata().ok()?;
                    if stat.len() != length
                        || stat.modified().ok() != modified
                        || stat.created().ok() != created
                    {
                        return None;
                    }
                    let version = crate::file_identity::Version::of(&input).ok()?;
                    let mut bytes = Vec::with_capacity(length as usize);
                    (&mut input)
                        .take(MAX_SOURCE_BYTES as u64 + 1)
                        .read_to_end(&mut bytes)
                        .ok()?;
                    let current = File::open(file).ok()?;
                    if bytes.len() as u64 != length
                        || crate::file_identity::Version::of(&current).ok()? != version
                    {
                        return None;
                    }
                    resize(&bytes, width, false)
                })
            })
            .await
            .ok()
            .flatten()
        }
    };
    let Some(image) = image else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let length = image.bytes.len();
    let mut response = (
        [
            ("content-type", image.mime),
            ("cache-control", cache),
            (
                "access-control-expose-headers",
                "ETag, X-Huiyu-Preview-Width",
            ),
        ],
        image.bytes,
    )
        .into_response();
    response
        .headers_mut()
        .insert("x-huiyu-preview-width", image.width.into());
    if head {
        *response.body_mut() = Body::empty();
        response
            .headers_mut()
            .insert("content-length", length.into());
    }
    super::conditional(response, &tag, condition.as_ref())
}
