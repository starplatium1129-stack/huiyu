use base64::{Engine, engine::general_purpose::STANDARD};
use huiyu_runtime::storage::Storage;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::io::Cursor;
#[cfg(windows)]
use std::time::Instant;

async fn request(storage: &Storage, command: Value) -> Value {
    storage
        .request(command, "desktop:thumbnail-fixture")
        .await
        .unwrap()
}

async fn fixture(width: u32, height: u32) -> (tempfile::TempDir, Storage) {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(
        directory.path().join("workspace"),
        "thumbnail-fixture".into(),
        true,
    )
    .await
    .unwrap();
    let pixels = image::RgbImage::from_fn(width, height, |x, y| {
        image::Rgb([(x % 251) as u8, (y % 241) as u8, ((x + y) % 239) as u8])
    });
    let mut output = Cursor::new(Vec::new());
    pixels
        .write_to(&mut output, image::ImageFormat::Png)
        .unwrap();
    let bytes = output.into_inner();
    request(&storage, json!({"kind":"prepareSave","operationId":"save","artwork":{"id":1},
        "media":{"alias":"original","sha256":hex::encode(Sha256::digest(&bytes)),"bytes":bytes.len(),"mime":"image/png"}})).await;
    for (index, chunk) in bytes.chunks(1024 * 1024).enumerate() {
        request(&storage, json!({"kind":"uploadChunk","operationId":"save","offset":index * 1024 * 1024,"data":STANDARD.encode(chunk)})).await;
    }
    request(&storage, json!({"kind":"commitSave","operationId":"save"})).await;
    (directory, storage)
}

async fn thumbnails(storage: &Storage, count: usize) -> Vec<Value> {
    futures_util::future::join_all(
        (0..count).map(|_| request(storage, json!({"kind":"readThumbnail","alias":"original"}))),
    )
    .await
}

#[tokio::test]
async fn concurrent_thumbnails_keep_identical_bytes_and_reuse_published_cache() {
    let (directory, storage) = fixture(96, 128).await;
    let original = storage.media("original").await.unwrap();
    let bytes = std::fs::read(&original.path).unwrap();
    let revision = request(&storage, json!({"kind":"status"})).await["revision"].clone();
    let values = thumbnails(&storage, 8).await;
    let first = values[0].as_str().unwrap();
    assert!(first.starts_with("data:image/jpeg;base64,"));
    assert!(values.iter().all(|value| value == &values[0]));
    assert_eq!(thumbnails(&storage, 2).await, vec![values[0].clone(); 2]);
    let (_large_directory, large) = fixture(1120, 700).await;
    let resized = thumbnails(&large, 1).await;
    let jpeg = STANDARD
        .decode(resized[0].as_str().unwrap().split_once(',').unwrap().1)
        .unwrap();
    let resized = image::load_from_memory(&jpeg).unwrap();
    assert_eq!((resized.width(), resized.height()), (560, 350));
    large.close().await.unwrap();
    let jpeg = STANDARD.decode(first.split_once(',').unwrap().1).unwrap();
    let image = image::load_from_memory(&jpeg).unwrap();
    assert_eq!((image.width(), image.height()), (96, 128));
    let root = directory.path().join("workspace");
    let cache = ["thumbnails-rust-v1", "thumbnails-rust-vips-v1"]
        .into_iter()
        .map(|version| root.join(format!("cache/{version}/{}.jpg", original.sha256)))
        .find(|cache| cache.is_file())
        .unwrap();
    let old = std::time::UNIX_EPOCH + std::time::Duration::from_secs(3_600);
    std::fs::OpenOptions::new()
        .write(true)
        .open(&cache)
        .unwrap()
        .set_modified(old)
        .unwrap();
    let cached_time = std::fs::metadata(&cache).unwrap().modified().unwrap();
    storage.close().await.unwrap();
    let reopened = Storage::open(root, "thumbnail-fixture".into(), false)
        .await
        .unwrap();
    assert_eq!(thumbnails(&reopened, 1).await[0], values[0]);
    assert_eq!(
        std::fs::metadata(&cache).unwrap().modified().unwrap(),
        cached_time
    );
    std::fs::remove_file(&cache).unwrap();
    assert_eq!(thumbnails(&reopened, 1).await[0], values[0]);
    assert!(cache.is_file());
    assert!(
        request(&reopened, json!({"kind":"readThumbnail","alias":"missing"}))
            .await
            .is_null()
    );
    assert_eq!(
        request(&reopened, json!({"kind":"status"})).await["revision"],
        revision
    );
    assert_eq!(std::fs::read(&original.path).unwrap(), bytes);
    let mut changed = bytes.clone();
    changed[0] ^= 1;
    std::fs::write(&original.path, changed).unwrap();
    assert_eq!(
        reopened
            .request(
                json!({"kind":"readThumbnail","alias":"original"}),
                "desktop:thumbnail-fixture"
            )
            .await
            .unwrap_err()
            .code,
        "MEDIA_INVALID"
    );
    reopened.close().await.unwrap();
}

// Windows CPU time measures all native decoder threads, not only the async
// caller. This benchmark is opt-in and never asserts machine-specific timings.
#[cfg(windows)]
fn cpu_ms() -> f64 {
    #[repr(C)]
    #[derive(Default)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> *mut std::ffi::c_void;
        fn GetProcessTimes(
            process: *mut std::ffi::c_void,
            creation: *mut FileTime,
            exit: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
    }
    let (mut creation, mut exit, mut kernel, mut user) = (
        FileTime::default(),
        FileTime::default(),
        FileTime::default(),
        FileTime::default(),
    );
    assert_ne!(
        unsafe {
            GetProcessTimes(
                GetCurrentProcess(),
                &mut creation,
                &mut exit,
                &mut kernel,
                &mut user,
            )
        },
        0
    );
    let ticks = |value: FileTime| (u64::from(value.high) << 32) | u64::from(value.low);
    (ticks(kernel) + ticks(user)) as f64 / 10_000.0
}

#[cfg(windows)]
#[tokio::test]
#[ignore = "Explicit isolated thumbnail CPU benchmark; optionally select AICS_TEST_VIPS_DLL"]
async fn benchmark_thumbnail_work() {
    let (_directory, mut storage) = fixture(2048, 3072).await;
    let native = std::env::var_os("AICS_TEST_VIPS_DLL");
    if let Some(library) = &native {
        storage = storage.with_native_images(library.into());
    }
    let media = storage.media("original").await.unwrap();
    let version = if native.is_some() {
        "thumbnails-rust-vips-v1"
    } else {
        "thumbnails-rust-v1"
    };
    let cache = _directory
        .path()
        .join("workspace/cache")
        .join(version)
        .join(format!("{}.jpg", media.sha256));
    let expected = thumbnails(&storage, 1).await.remove(0);
    let mut samples = Vec::new();
    for _ in 0..7 {
        for (case, count, cold) in [
            ("cold-single", 1, true),
            ("cold-duplicate", 8, true),
            ("warm-duplicate", 8, false),
        ] {
            if cold {
                std::fs::remove_file(&cache).unwrap();
            }
            let cpu = cpu_ms();
            let started = Instant::now();
            let values = thumbnails(&storage, count).await;
            let wall = started.elapsed().as_secs_f64() * 1000.0;
            let cpu = cpu_ms() - cpu;
            assert!(values.iter().all(|value| value == &expected));
            samples.push(json!({"case":case,"requests":count,"wallMs":wall,"cpuMs":cpu}));
        }
    }
    println!(
        "THUMBNAIL_BENCHMARK {}",
        json!({"native":native.is_some(),"debugAssertions":cfg!(debug_assertions),
        "width":2048,"height":3072,"rounds":7,"outputSha256":hex::encode(Sha256::digest(expected.as_str().unwrap().as_bytes())),"samples":samples})
    );
    storage.close().await.unwrap();
}
