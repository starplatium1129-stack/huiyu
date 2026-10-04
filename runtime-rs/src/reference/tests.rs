use super::*;
use std::fs;

fn write(path: &FsPath, value: &Value) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
}

#[test]
fn source_shards_are_authoritative_and_read_only() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path();
    write(
        &root.join("data/references/manifest.json"),
        &json!({"version":1,"standards":{"perspectives":[]},"characterIds":["nene"],"viewOrder":["nene"]}),
    );
    let profile = json!({"characterId":"nene","outfits":[{"outfitId":"one","references":[{"pending":true}]}]});
    write(
        &root.join("data/references/nene.json"),
        &json!({"standard":{"id":"nene","outfits":[]},"view":profile}),
    );
    write(
        &root.join("data/character-reference-view.json"),
        &json!({"nene":{"stale":true}}),
    );
    let mut reader = Reader::new(root.into(), None);
    assert_eq!(reader.read(Some("nene")).unwrap(), Some(profile.clone()));
    assert_eq!(reader.read(Some("unknown")).unwrap(), None);
    assert_eq!(reader.read(None).unwrap(), Some(json!({"nene":profile})));
    assert_eq!(
        io::json(&root.join("data/character-reference-view.json")).unwrap(),
        json!({"nene":{"stale":true}})
    );
    let mut unavailable = Reader::new(root.into(), Some(root.join("missing-explicit-library")));
    assert_eq!(
        unavailable.read(Some("nene")).unwrap_err().code,
        "REFERENCE_RELEASE_INVALID"
    );
}

fn published_fixture(root: &FsPath) -> PathBuf {
    let directory = root.join("published");
    fs::create_dir_all(directory.join("nene/outfit")).unwrap();
    let image = b"isolated integrity fixture";
    fs::write(directory.join("nene/outfit/front.png"), image).unwrap();
    let view = json!({"nene":{"characterId":"nene","outfits":[{"references":[{"url":"/character-references/nene/outfit/front.png","pending":false}]}]}});
    write(&root.join("data/character-reference-view.json"), &view);
    write(
        &root.join("data/character-reference-standards.json"),
        &json!({"characters":[]}),
    );
    write(&directory.join("character-reference-view.json"), &view);
    let mut manifest = json!({"schemaVersion":1,"kind":"reference-release",
        "files":[{"path":"nene/outfit/front.png","bytes":image.len(),"sha256":io::digest(image)}],
        "viewSha256":io::digest(io::bytes(&directory.join("character-reference-view.json")).unwrap()),
        "sourceStandardsSha256":io::digest(io::bytes(&root.join("data/character-reference-standards.json")).unwrap()),
        "sourceViewSha256":io::digest(io::bytes(&root.join("data/character-reference-view.json")).unwrap()),
        "candidateManifestSha256":"fixture","reviewSha256":"fixture","baseIdentity":"fixture","approvals":[]});
    manifest["identity"] = release::seal(&manifest).into();
    write(&directory.join("reference-release.json"), &manifest);
    directory
}

#[test]
fn published_profiles_revoke_without_legacy_fallback() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path();
    let directory = published_fixture(root);
    let mut reader = Reader::new(root.into(), Some(directory.clone()));
    assert!(reader.read(Some("nene")).unwrap().is_some());
    assert!(reader.read(None).unwrap().is_some());
    match reader.asset("nene/outfit/front.png").unwrap() {
        assets::Asset::Published(bytes, _) => assert_eq!(bytes, b"isolated integrity fixture"),
        _ => panic!("sealed reference did not resolve its published image"),
    }
    fs::write(directory.join("reference-release.json"), b"{}").unwrap();
    assert_eq!(
        reader.read(Some("nene")).unwrap_err().code,
        "REFERENCE_RELEASE_INVALID"
    );
    assert_eq!(
        reader.read(None).unwrap_err().code,
        "REFERENCE_RELEASE_INVALID"
    );
    let directory = published_fixture(root);
    let mut reader = Reader::new(root.into(), Some(directory.clone()));
    fs::write(directory.join("nene/outfit/front.png"), b"changed").unwrap();
    assert_eq!(
        reader.asset("nene/outfit/front.png").unwrap_err().code,
        "REFERENCE_RELEASE_INVALID"
    );
    assert_eq!(
        reader.read(Some("nene")).unwrap_err().code,
        "REFERENCE_RELEASE_INVALID"
    );
    let mut changed = Reader::new(root.into(), Some(directory));
    assert_eq!(
        changed.read(Some("nene")).unwrap_err().code,
        "REFERENCE_RELEASE_INVALID"
    );
}

#[test]
fn non_regular_and_linked_reference_files_are_rejected() {
    let fixture = tempfile::tempdir().unwrap();
    let original = fixture.path().join("original.json");
    let alias = fixture.path().join("alias.json");
    fs::write(&original, b"{}").unwrap();
    fs::hard_link(&original, &alias).unwrap();
    assert!(io::bytes(&alias).is_err());
    fs::remove_file(&alias).unwrap();
    assert_eq!(io::bytes(&original).unwrap(), b"{}");
    #[cfg(unix)]
    {
        use std::{ffi::CString, os::unix::ffi::OsStrExt, time::Duration};
        let fifo = fixture.path().join("profile.json");
        let name = CString::new(fifo.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let (done, waiting) = std::sync::mpsc::channel();
        let unblock = std::thread::spawn(move || {
            if matches!(
                waiting.recv_timeout(Duration::from_secs(2)),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            ) {
                // Bound the old blocking open without providing profile contents.
                let _writer = fs::OpenOptions::new().write(true).open(fifo).unwrap();
                true
            } else {
                false
            }
        });
        let result = io::bytes(&fixture.path().join("profile.json"));
        let _ = done.send(());
        let blocked = unblock.join().unwrap();
        assert!(result.is_err());
        assert!(
            !blocked,
            "non-regular reference must be rejected before opening"
        );
    }
}

#[test]
fn queued_reads_leave_blocking_pool_available_and_exit_on_shutdown() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap()
        .block_on(async {
            let fixture = tempfile::tempdir().unwrap();
            let root = fixture.path().to_owned();
            let readers = Arc::new(Mutex::new(Some(Reader::new(root.clone(), None))));
            let held = readers.clone().lock_owned().await;
            let shutdown = CancellationToken::new();
            let mut requests = (0..16)
                .map(|_| {
                    Box::pin(with_reader(
                        readers.clone(),
                        root.clone(),
                        root.clone(),
                        &shutdown,
                        |_| -> Result<()> { panic!("cancelled waiter must not read") },
                    ))
                })
                .collect::<Vec<_>>();
            for request in &mut requests {
                assert!(futures_util::poll!(request.as_mut()).is_pending());
            }
            // Even with only one blocking thread, unrelated filesystem work
            // remains available while reference requests wait for the reader.
            let probe = tokio::task::spawn_blocking(|| 17);
            assert_eq!(
                tokio::time::timeout(std::time::Duration::from_secs(1), probe)
                    .await
                    .unwrap()
                    .unwrap(),
                17
            );
            shutdown.cancel();
            for request in requests {
                assert_eq!(request.await.unwrap_err().code, "REFERENCE_UNAVAILABLE");
            }
            drop(held);
            assert!(readers.try_lock().is_ok());
        });
}

#[tokio::test]
async fn cancelled_running_read_keeps_exclusive_access_until_worker_finishes() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().to_owned();
    let readers = Arc::new(Mutex::new(Some(Reader::new(root.clone(), None))));
    let shutdown = CancellationToken::new();
    let (entered, started) = tokio::sync::oneshot::channel();
    let (release, resumed) = std::sync::mpsc::channel();
    let request = tokio::spawn({
        let (readers, root, shutdown) = (readers.clone(), root.clone(), shutdown.clone());
        async move {
            with_reader(readers, root.clone(), root, &shutdown, move |_| {
                entered.send(()).unwrap();
                resumed
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap();
                Ok(())
            })
            .await
        }
    });
    started.await.unwrap();
    request.abort();
    assert!(request.await.unwrap_err().is_cancelled());
    let followup = with_reader(readers.clone(), root.clone(), root, &shutdown, |_| Ok(23));
    tokio::pin!(followup);
    assert!(futures_util::poll!(&mut followup).is_pending());
    assert!(readers.try_lock().is_err());
    release.send(()).unwrap();
    assert_eq!(followup.await.unwrap(), 23);
}

#[test]
fn disconnected_request_skips_reader_initialization_while_blocking_job_is_queued() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap()
        .block_on(async {
            let fixture = tempfile::tempdir().unwrap();
            let root = fixture.path().to_owned();
            let readers = Arc::new(Mutex::new(None));
            let shutdown = CancellationToken::new();
            let (entered, started) = tokio::sync::oneshot::channel();
            let (release, resumed) = std::sync::mpsc::channel();
            let occupied = tokio::task::spawn_blocking(move || {
                entered.send(()).unwrap();
                resumed
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap();
            });
            started.await.unwrap();
            let mut request = Box::pin(with_reader(
                readers.clone(),
                root.clone(),
                root,
                &shutdown,
                |_| -> Result<()> { panic!("disconnected request must not read") },
            ));
            assert!(futures_util::poll!(request.as_mut()).is_pending());
            assert!(readers.try_lock().is_err());
            drop(request);
            release.send(()).unwrap();
            occupied.await.unwrap();
            let slot = tokio::time::timeout(std::time::Duration::from_secs(1), readers.lock())
                .await
                .unwrap();
            assert!(slot.is_none());
        });
}
