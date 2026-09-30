use super::*;
use axum::{
    Router,
    body::{Body, Bytes},
    extract::ConnectInfo,
    http::{HeaderMap, Request, StatusCode},
};
use http_body_util::BodyExt;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{LazyLock, Mutex},
};
use tower::ServiceExt;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Reads {
    passes: u64,
    bytes: u64,
    collected: u64,
}
// Only explicitly watched, unique fixture paths are counted. These hooks and
// counters are compiled solely into tests, never the runtime binary.
static READS: LazyLock<Mutex<HashMap<PathBuf, Reads>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static CANCEL_AFTER: LazyLock<Mutex<HashMap<PathBuf, (u64, CancellationToken)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
type PauseChannels = (
    tokio::sync::oneshot::Sender<()>,
    std::sync::mpsc::Receiver<()>,
);
static PAUSES: LazyLock<Mutex<HashMap<PathBuf, PauseChannels>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
pub(crate) fn checkpoint(path: &Path, bytes: u64) {
    let pause = PAUSES.lock().unwrap().remove(path);
    if let Some((entered, release)) = pause {
        let _ = entered.send(());
        release
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
    }
    if let Some((limit, token)) = CANCEL_AFTER.lock().unwrap().get(path)
        && bytes >= *limit
    {
        token.cancel();
    }
}
struct Pause(PathBuf, std::sync::mpsc::Sender<()>);
impl Pause {
    fn new(path: &Path) -> (Self, tokio::sync::oneshot::Receiver<()>) {
        let (entered, observed) = tokio::sync::oneshot::channel();
        let (release, waiting) = std::sync::mpsc::channel();
        assert!(
            PAUSES
                .lock()
                .unwrap()
                .insert(path.into(), (entered, waiting))
                .is_none()
        );
        (Self(path.into(), release), observed)
    }
}
impl Drop for Pause {
    fn drop(&mut self) {
        PAUSES.lock().unwrap().remove(&self.0);
        let _ = self.1.send(());
    }
}
pub(crate) fn observe(path: &Path, bytes: u64, collected: bool) {
    if let Some(reads) = READS.lock().unwrap().get_mut(path) {
        reads.passes += 1;
        reads.bytes += bytes;
        if collected {
            reads.collected += bytes;
        }
    }
}
struct Watch(Vec<PathBuf>);
impl Watch {
    fn new(paths: &[PathBuf]) -> Self {
        let mut reads = READS.lock().unwrap();
        for path in paths {
            assert!(reads.insert(path.clone(), Reads::default()).is_none());
        }
        Self(paths.to_vec())
    }
    fn take(&self, path: &Path) -> Reads {
        std::mem::take(READS.lock().unwrap().get_mut(path).unwrap())
    }
}
impl Drop for Watch {
    fn drop(&mut self) {
        let mut reads = READS.lock().unwrap();
        for path in &self.0 {
            reads.remove(path);
        }
    }
}
struct CancelAfter(PathBuf);
impl CancelAfter {
    fn new(path: &Path, bytes: u64, token: &CancellationToken) -> Self {
        CANCEL_AFTER
            .lock()
            .unwrap()
            .insert(path.into(), (bytes, token.clone()));
        Self(path.into())
    }
}
impl Drop for CancelAfter {
    fn drop(&mut self) {
        CANCEL_AFTER.lock().unwrap().remove(&self.0);
    }
}

struct Fixture {
    _directory: tempfile::TempDir,
    app: Router,
    service: Arc<Service>,
    config_file: PathBuf,
    ctx: config::Context,
    root: PathBuf,
    entries: Vec<Entry>,
    texture: Vec<u8>,
    shutdown: CancellationToken,
}
impl Fixture {
    fn new() -> Self {
        let (directory, gateway, config_file, _, _) = fixture();
        let texture = (0..2 * 1024 * 1024)
            .map(|n| (n % 251) as u8)
            .collect::<Vec<_>>();
        let model =
            br#"{"Version":3,"FileReferences":{"Moc":"neutral.moc3","Textures":["texture.png"]}}"#;
        let moc = b"neutral fixture bytes; no model decoding or real asset";
        let resources = [
            (
                "assets/live2d/neutral/neutral.model3.json",
                model.as_slice(),
            ),
            ("assets/live2d/neutral/neutral.moc3", moc.as_slice()),
            ("assets/live2d/neutral/texture.png", texture.as_slice()),
        ];
        let manifest = Manifest {
            entries: resources
                .iter()
                .map(|(path, bytes)| entry(path, bytes))
                .collect(),
        };
        let source = directory.path().join("source");
        let release = pack(&source.join("neutral"), &resources, None, &manifest);
        write(
            &config_file,
            &serde_json::to_vec(&json!({
                "userDataRoot":directory.path().join("user"),
                "protectedRoots":[gateway.app_root],
                "policy":{"sources":{"source":{"approved":true,"kind":"offline","root":source}},
                    "releases":{"neutral":release}}
            }))
            .unwrap(),
        );
        let shutdown = CancellationToken::new();
        let ctx = config::load(&gateway, &config_file, shutdown.clone())
            .unwrap()
            .ctx;
        lifecycle::run(&operation(&ctx), "import", "neutral").unwrap();
        let root = ctx.store.join("versions").join(manifest.identity());
        let service = Arc::new(
            Service::configured(&gateway, Some(config_file.clone()), true, shutdown.clone())
                .unwrap(),
        );
        assert_eq!(service.status(false)["mounted"], true);
        let app = router(service.clone())
            .fallback(|| async { "bundled" })
            .layer(axum::middleware::from_fn_with_state(
                service.clone(),
                super::super::overlay,
            ))
            .with_state(AppState::new(
                Arc::new(gateway),
                Arc::new(HostAuthority::new(None, None, None)),
                shutdown.clone(),
            ));
        Self {
            _directory: directory,
            app,
            service,
            config_file,
            ctx,
            root,
            entries: manifest.entries,
            texture,
            shutdown,
        }
    }
    async fn request(
        &self,
        method: &str,
        etag: Option<&str>,
        no_cache: bool,
    ) -> (StatusCode, HeaderMap, Bytes) {
        let mut request = Request::builder()
            .method(method)
            .uri("/assets/live2d/neutral/texture.png")
            .header("host", "127.0.0.1:3210");
        if let Some(etag) = etag {
            request = request.header("if-none-match", etag);
        }
        if no_cache {
            request = request.header("cache-control", "no-cache");
        }
        let mut request = request.body(Body::empty()).unwrap();
        request.extensions_mut().insert(ConnectInfo(
            "127.0.0.1:1234".parse::<std::net::SocketAddr>().unwrap(),
        ));
        let response = self.app.clone().oneshot(request).await.unwrap();
        let (parts, body) = response.into_parts();
        (
            parts.status,
            parts.headers,
            body.collect().await.unwrap().to_bytes(),
        )
    }
    fn paths(&self) -> Vec<PathBuf> {
        self.entries
            .iter()
            .map(|entry| self.root.join(&entry.path))
            .collect()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live2d_get_head_and_304_verify_every_dependency_once_without_unused_bodies() {
    let fixture = Fixture::new();
    let paths = fixture.paths();
    let watch = Watch::new(&paths);
    let requested = &paths[2];
    let declared = &fixture.entries[2];
    // Measure the former requested-file algorithm on the same neutral file:
    // group verification followed by a separate buffered read and digest.
    assert!(fs::file_matches(requested, declared, &fixture.shutdown).unwrap());
    let old_body = fs::bytes(requested, declared.bytes, false).unwrap();
    assert_eq!(digest(&old_body), declared.sha256);
    assert_eq!(
        watch.take(requested),
        Reads {
            passes: 2,
            bytes: declared.bytes * 2,
            collected: declared.bytes,
        }
    );
    drop(old_body);

    let (status, headers, body) = fixture.request("GET", None, false).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.as_ref(), fixture.texture);
    assert_eq!(headers["content-length"], declared.bytes.to_string());
    let version = Manifest {
        entries: fixture.entries.clone(),
    }
    .identity();
    assert_eq!(headers["x-resource-version"], version);
    let etag = headers["etag"].to_str().unwrap();
    for (method, condition, no_cache, expected_status, collect) in [
        ("GET", None, false, StatusCode::OK, true),
        ("HEAD", None, false, StatusCode::OK, false),
        ("GET", Some(etag), false, StatusCode::NOT_MODIFIED, false),
        ("HEAD", Some(etag), false, StatusCode::NOT_MODIFIED, false),
        ("GET", Some(etag), true, StatusCode::OK, true),
    ] {
        // The first GET above is also checked; subsequent rows issue a request.
        if method != "GET" || condition.is_some() {
            let (status, headers, body) = fixture.request(method, condition, no_cache).await;
            assert_eq!(status, expected_status);
            assert_eq!(headers["etag"], etag);
            assert_eq!(headers["x-resource-version"], version);
            if collect {
                assert_eq!(body.as_ref(), fixture.texture);
            } else {
                assert!(body.is_empty());
            }
            if status == StatusCode::NOT_MODIFIED {
                // Axum adds the exact empty-body length for this response,
                // matching the original overlay's StatusCode response path.
                assert_eq!(headers["content-length"], "0");
            } else {
                assert_eq!(headers["content-length"], declared.bytes.to_string());
            }
        }
        for (index, path) in paths.iter().enumerate() {
            let bytes = fixture.entries[index].bytes;
            assert_eq!(
                watch.take(path),
                Reads {
                    passes: 1,
                    bytes,
                    collected: if index == 2 && collect { bytes } else { 0 },
                },
                "{method} {condition:?}: {}",
                path.display()
            );
        }
    }
    fixture.service.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live2d_bodyless_requests_reject_same_length_requested_or_dependency_changes() {
    for (method, matching, damaged) in [
        ("GET", false, 2),
        ("HEAD", false, 2),
        ("GET", true, 2),
        ("GET", false, 1),
        ("HEAD", false, 1),
        ("GET", true, 1),
    ] {
        let fixture = Fixture::new();
        let etag = format!("\"{}\"", fixture.entries[2].sha256);
        let path = fixture.root.join(&fixture.entries[damaged].path);
        let mut bytes = std::fs::read(&path).unwrap();
        bytes[0] ^= 1;
        write(&path, &bytes);
        let (_, headers, body) = fixture
            .request(method, matching.then_some(etag.as_str()), false)
            .await;
        if method == "GET" {
            assert_eq!(body.as_ref(), b"bundled");
        }
        assert!(!headers.contains_key("x-resource-version"));
        let status = fixture.service.status(false);
        assert_eq!(status["mounted"], false);
        assert_eq!(status["issue"]["code"], "CONTENT_INVALID");
        fixture.service.close().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live2d_bodyless_requests_still_revoke_changed_authorization_and_version() {
    for authorization in [true, false] {
        let fixture = Fixture::new();
        if authorization {
            let mut bytes = std::fs::read(&fixture.config_file).unwrap();
            bytes.push(b' ');
            write(&fixture.config_file, &bytes);
        } else {
            let mut state = state::read(&fixture.ctx).unwrap();
            state["sequence"] = (state["sequence"].as_u64().unwrap() + 1).into();
            fs::write_json(&fixture.ctx.store.join("current.json"), &state).unwrap();
        }
        let etag = format!("\"{}\"", fixture.entries[2].sha256);
        let (_, headers, _) = fixture.request("HEAD", Some(&etag), false).await;
        assert!(!headers.contains_key("x-resource-version"));
        fixture.service.close().await;
    }
}

#[test]
fn verified_resource_reads_keep_empty_length_hash_and_cancellation_checks() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("neutral.bin");
    let cancel = CancellationToken::new();
    for bytes in [b"".as_slice(), b"neutral fixture".as_slice()] {
        write(&path, bytes);
        let declared = entry("assets/neutral.bin", bytes);
        assert_eq!(
            fs::verified_bytes(&path, &declared, &cancel).unwrap(),
            bytes
        );
        assert!(fs::file_matches(&path, &declared, &cancel).unwrap());
        let mut wrong_length = declared.clone();
        wrong_length.bytes += 1;
        assert_eq!(
            fs::verified_bytes(&path, &wrong_length, &cancel)
                .unwrap_err()
                .code,
            "CONTENT_INVALID"
        );
        let mut wrong_hash = declared.clone();
        wrong_hash.sha256 = digest(b"other fixture");
        assert_eq!(
            fs::verified_bytes(&path, &wrong_hash, &cancel)
                .unwrap_err()
                .code,
            "CONTENT_INVALID"
        );
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        assert_eq!(
            fs::verified_bytes(&path, &declared, &cancelled)
                .unwrap_err()
                .code,
            "CANCELLED"
        );
        assert_eq!(
            fs::file_matches(&path, &declared, &cancelled)
                .unwrap_err()
                .code,
            "CANCELLED"
        );
    }
}

#[test]
fn both_verified_resource_paths_reject_hardlinks() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("neutral.bin");
    write(&path, b"neutral fixture");
    std::fs::hard_link(&path, directory.path().join("alias.bin")).unwrap();
    let declared = entry("assets/neutral.bin", b"neutral fixture");
    let cancel = CancellationToken::new();
    assert_eq!(
        fs::verified_bytes(&path, &declared, &cancel)
            .unwrap_err()
            .code,
        "UNSAFE_LINK"
    );
    assert_eq!(
        fs::file_matches(&path, &declared, &cancel)
            .unwrap_err()
            .code,
        "UNSAFE_LINK"
    );
}

#[test]
fn verified_body_and_hash_only_reads_cancel_between_chunks() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("neutral.bin");
    let bytes = vec![17; 1024 * 1024];
    write(&path, &bytes);
    let declared = entry("assets/neutral.bin", &bytes);
    for collect in [true, false] {
        let cancel = CancellationToken::new();
        let _checkpoint = CancelAfter::new(&path, 512 * 1024, &cancel);
        let error = if collect {
            fs::verified_bytes(&path, &declared, &cancel).unwrap_err()
        } else {
            fs::file_matches(&path, &declared, &cancel).unwrap_err()
        };
        assert!(cancel.is_cancelled());
        assert_eq!(error.code, "CANCELLED");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn same_identity_refresh_rejects_old_worker_publication_and_invalidation() {
    for damaged in [false, true] {
        let fixture = Arc::new(Fixture::new());
        let path = fixture.root.join(&fixture.entries[2].path);
        let (old_configuration, old_snapshot) = fixture.service.mount().unwrap();
        if damaged {
            let mut bytes = fixture.texture.clone();
            bytes[0] ^= 1;
            write(&path, &bytes);
        }
        let (pause, entered) = Pause::new(&path);
        let reading = fixture.clone();
        let worker = tokio::spawn(async move { reading.request("GET", None, false).await });
        tokio::time::timeout(std::time::Duration::from_secs(2), entered)
            .await
            .unwrap()
            .unwrap();
        // The old worker already hashed its first chunk; repair while paused
        // so the real refresh verifies the original, same-identity installation.
        if damaged {
            write(&path, &fixture.texture);
        }
        assert_eq!(fixture.service.status(true)["mounted"], true);
        let (configuration, snapshot) = fixture.service.mount().unwrap();
        assert_eq!(
            (&snapshot.identity, snapshot.sequence),
            (&old_snapshot.identity, old_snapshot.sequence)
        );
        assert!(!Arc::ptr_eq(&old_configuration, &configuration));
        assert!(!Arc::ptr_eq(&old_snapshot, &snapshot));
        drop(pause);
        let (_, headers, body) = worker.await.unwrap();
        assert_eq!(body.as_ref(), b"bundled");
        assert!(!headers.contains_key("x-resource-version"));
        let (_, current) = fixture.service.mount().unwrap();
        assert!(Arc::ptr_eq(&snapshot, &current));
        assert!(fixture.service.status(false)["issue"].is_null());
        assert_eq!(
            fixture.request("GET", None, false).await.2.as_ref(),
            fixture.texture
        );
        fixture.service.close().await;
    }
}
