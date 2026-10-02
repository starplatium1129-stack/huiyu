use super::*;
use crate::resources::{
    digest,
    manifest::{Entry, Manifest},
    policy, resolve, state,
};
use std::{path::Path, sync::Arc};
mod integrity;

fn directory() -> tempfile::TempDir {
    // Windows can expose an 8.3 alias in TEMP. Fixture roots use the physical
    // long name while production path/link checks retain their strict contract.
    let parent = fs::absolute(&std::env::temp_dir().canonicalize().unwrap()).unwrap();
    tempfile::tempdir_in(parent).unwrap()
}

fn write(root: &Path, path: &str, bytes: &[u8]) {
    let file = root.join(path);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, bytes).unwrap();
}
fn entry(path: &str, bytes: &[u8]) -> Entry {
    Entry {
        path: path.into(),
        bytes: bytes.len() as u64,
        sha256: digest(bytes),
    }
}
fn fixture(root: &Path, id: &str, ids: &[&str]) -> Options {
    let app = root.join("installation/gateway");
    std::fs::create_dir_all(&app).unwrap();
    let package = root.join(id);
    let asset = format!("asset-{id}").into_bytes();
    let assets = Manifest {
        entries: vec![entry("assets/characters/popular-alpha.png", &asset)],
    };
    let pack_raw = serde_json::to_vec(&assets.value()).unwrap();
    write(&package, "pack/manifest.json", &pack_raw);
    write(&package, "pack/assets/characters/popular-alpha.png", &asset);
    let mut display = Vec::new();
    let mut showcase = Vec::new();
    for name in ids {
        let image = format!("images/{name}.jpg");
        let thumb = format!("thumbs/{name}.jpg");
        let bytes = format!("neutral-sample-{id}-{name}").into_bytes();
        write(&package, &format!("showcase/{image}"), &bytes);
        write(&package, &format!("showcase/{thumb}"), &bytes);
        showcase.push(entry(&image, &bytes));
        showcase.push(entry(&thumb, &bytes));
        display.push(json!({"id":name,"title":format!("Neutral {id} {name}"),"rating":"All","image":image,"thumb":thumb}));
    }
    let display_raw =
        serde_json::to_vec_pretty(&json!({"version":23,"entries":display,"source":"fixture"}))
            .unwrap();
    write(&package, "showcase/manifest.json", &display_raw);
    showcase.push(entry("manifest.json", &display_raw));
    let showcase = Manifest { entries: showcase };
    let mut files = vec![entry("pack/manifest.json", &pack_raw)];
    files.extend(assets.entries.iter().map(|file| Entry {
        path: format!("pack/{}", file.path),
        ..file.clone()
    }));
    files.extend(showcase.entries.iter().map(|file| Entry {
        path: format!("showcase/{}", file.path),
        ..file.clone()
    }));
    let release = json!({"schemaVersion":1,"kind":"huiyu-offline-release","releaseId":id,"appVersion":"1.7.2",
        "resourcePack":{"path":"pack","packageIdentity":policy::package_identity(&pack_raw,None),"targetIdentity":assets.identity()},
        "showcase":{"path":"showcase","contentIdentity":showcase.identity(),"entries":showcase.entries},"files":files});
    let raw = serde_json::to_vec_pretty(&release).unwrap();
    write(&package, "release.json", &raw);
    Options {
        package,
        expected: digest(raw),
        app,
        runtime: root.join("profile/gateway"),
        apply: false,
        cancel_stdin: false,
    }
}
#[test]
fn helper_pipe_cancels_on_request_or_disconnect() {
    for input in [&b"cancel\n"[..], &b""[..]] {
        let cancel = CancellationToken::new();
        cancel_on_input(input, &cancel);
        assert!(cancel.is_cancelled());
    }
}
fn apply(options: &Options) -> Value {
    execute(
        &Options {
            apply: true,
            ..options.clone()
        },
        &CancellationToken::new(),
    )
    .unwrap()
}
fn show(options: &Options) -> PathBuf {
    let paths = paths::Paths::new(options).unwrap();
    paths
        .current_root(&paths.pointer().unwrap())
        .unwrap()
        .unwrap()
}
fn manifest(root: &Path) -> Value {
    fs::json(&root.join("manifest.json"), false, false)
        .unwrap()
        .unwrap()
}

#[test]
fn approval_and_preview_are_read_only_and_verify_every_declared_byte() {
    let temp = directory();
    let options = fixture(temp.path(), "release_a", &["sc1000"]);
    let result = execute(&options, &CancellationToken::new()).unwrap();
    assert_eq!(result["apply"], false);
    assert!(!options.runtime.parent().unwrap().exists());
    let wrong = Options {
        expected: "0".repeat(64),
        apply: true,
        ..options.clone()
    };
    assert_eq!(
        execute(&wrong, &CancellationToken::new()).unwrap_err().code,
        "PACKAGE_UNAPPROVED"
    );
    assert!(!options.runtime.exists());
    write(&options.package, "showcase/images/sc1000.jpg", b"changed");
    assert_eq!(
        execute(&options, &CancellationToken::new())
            .unwrap_err()
            .code,
        "CONTENT_INVALID"
    );
    assert!(!options.runtime.exists());
}
#[test]
fn invalid_paths_inventory_domains_and_destination_links_are_rejected() {
    let temp = directory();
    let options = fixture(temp.path(), "release_a", &["sc1000"]);
    let file = options.package.join("release.json");
    let mut release: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    release["files"][0]["path"] = "pack/../escape.png".into();
    let raw = serde_json::to_vec(&release).unwrap();
    std::fs::write(&file, &raw).unwrap();
    let options = Options {
        expected: digest(raw),
        ..options
    };
    assert_eq!(
        execute(&options, &CancellationToken::new())
            .unwrap_err()
            .code,
        "UNSAFE_PATH"
    );
    let overlap = Options {
        runtime: options.app.join("runtime"),
        ..options.clone()
    };
    assert_eq!(
        paths::Paths::new(&overlap).err().unwrap().code,
        "PROTECTED_ROOT"
    );
    let options = fixture(temp.path(), "release_b", &["sc1000"]);
    write(&options.package, "showcase/unused.jpg", b"undeclared");
    assert_eq!(
        execute(&options, &CancellationToken::new())
            .unwrap_err()
            .code,
        "UNLISTED_FILE"
    );
    let options = fixture(temp.path(), "release_c", &["sc1000"]);
    let mut release: Value =
        serde_json::from_slice(&std::fs::read(options.package.join("release.json")).unwrap())
            .unwrap();
    release["files"].as_array_mut().unwrap().pop();
    let raw = serde_json::to_vec(&release).unwrap();
    write(&options.package, "release.json", &raw);
    assert_eq!(
        execute(
            &Options {
                expected: digest(raw),
                ..options
            },
            &CancellationToken::new()
        )
        .unwrap_err()
        .code,
        "MANIFEST_INVALID"
    );
}
#[test]
fn historical_display_defaults_are_normalized_only_at_the_read_boundary() {
    let original =
        json!({"entries":[{"id":"sc1000","rating":"All"},{"id":"pc_alpha_study","rating":"R18"}]});
    let normalized = release::display(&original).unwrap();
    assert_eq!(normalized["sc1000"]["image"], "images/sc1000.jpg");
    assert_eq!(
        normalized["pc_alpha_study"]["thumb"],
        "thumbs/pc_alpha_study.jpg"
    );
    assert!(original["entries"][0].get("image").is_none());
    assert!(release::display(&json!({"entries":[{"id":"sc1000","rating":"unknown"}]})).is_err());
    assert!(
        release::display(
            &json!({"entries":[{"id":"sc1000","rating":"All","image":"images/../private.jpg"}]})
        )
        .is_err()
    );
}
#[test]
fn installed_resources_and_showcase_work_after_offline_medium_is_removed() {
    let temp = directory();
    let options = fixture(temp.path(), "release_a", &["sc1000"]);
    let original = std::fs::read(options.package.join("showcase/manifest.json")).unwrap();
    let result = apply(&options);
    assert_eq!(result["action"], "installed");
    assert_eq!(
        std::fs::read(show(&options).join("manifest.json")).unwrap(),
        original
    );
    let paths = paths::Paths::new(&options).unwrap();
    let context = config::load(&options.gateway(), &paths.policy, CancellationToken::new())
        .unwrap()
        .ctx;
    assert!(options.package.starts_with(temp.path()));
    std::fs::remove_dir_all(&options.package).unwrap();
    let snapshot = resolve::snapshot(&context, &CancellationToken::new())
        .unwrap()
        .unwrap();
    assert_eq!(
        std::fs::read(snapshot.root.join("assets/characters/popular-alpha.png")).unwrap(),
        b"asset-release_a"
    );
    assert!(
        paths
            .current_root(&paths.pointer().unwrap())
            .unwrap()
            .is_some()
    );
    let service =
        crate::resources::Service::new(&options.gateway(), CancellationToken::new()).unwrap();
    let status = service.status(true);
    assert_eq!(status["mounted"], true);
    assert_eq!(status["managementEnabled"], false);
    assert!(!paths.pending.exists());
}
#[test]
fn upgrades_preserve_changed_samples_deletions_home_uploads_and_old_approvals() {
    let temp = directory();
    let first = fixture(temp.path(), "release_a", &["sc1000", "sc1001"]);
    apply(&first);
    let old = show(&first);
    let mut local = manifest(&old);
    local["entries"][0]["title"] = "My edited sample".into();
    local["entries"].as_array_mut().unwrap().remove(1);
    fs::write_json(&old.join("manifest.json"), &local).unwrap();
    write(&old, "images/sc1000.jpg", b"user-original");
    write(&old, "thumbs/sc1000.jpg", b"user-thumbnail");
    write(&old, "home/nene.jpg", b"user-home");
    fs::write_json(&old.join("home-hero.json"),&json!({"version":2,"entries":{"nene":{"source":"upload","image":"home/nene.jpg","updatedAt":"fixture"}}})).unwrap();
    let second = fixture(temp.path(), "release_b", &["sc1000", "sc1001", "sc1002"]);
    let result = apply(&second);
    assert_eq!(result["showcase"]["preservedLocalEntries"], 3);
    let current = show(&second);
    assert_ne!(old, current);
    let value = manifest(&current);
    assert_eq!(value["entries"][0]["title"], "My edited sample");
    assert!(
        value["entries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|entry| entry["id"] != "sc1001")
    );
    assert!(
        value["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["id"] == "sc1002")
    );
    assert_eq!(
        std::fs::read(current.join("images/sc1000.jpg")).unwrap(),
        b"user-original"
    );
    assert_eq!(
        std::fs::read(current.join("home/nene.jpg")).unwrap(),
        b"user-home"
    );
    assert_eq!(
        std::fs::read(current.join("images/sc1002.jpg")).unwrap(),
        b"neutral-sample-release_b-sc1002"
    );
    let policy = fs::json(&paths::Paths::new(&second).unwrap().policy, false, false)
        .unwrap()
        .unwrap();
    assert!(policy["policy"]["releases"].get("release_a").is_some());
    assert_eq!(apply(&second)["action"], "already-installed");
    assert_eq!(
        std::fs::read(old.join("images/sc1000.jpg")).unwrap(),
        b"user-original"
    );
}
#[test]
fn interrupted_copy_keeps_old_policy_and_pointers_and_same_command_recovers() {
    let temp = directory();
    let first = fixture(temp.path(), "release_a", &["sc1000"]);
    apply(&first);
    let old_root = show(&first);
    let second = fixture(temp.path(), "release_b", &["sc1000", "sc1001"]);
    let paths = paths::Paths::new(&second).unwrap();
    let old_policy = std::fs::read(&paths.policy).unwrap();
    let old_showcase = paths.pointer().unwrap();
    let ctx = config::load(&first.gateway(), &paths.policy, CancellationToken::new())
        .unwrap()
        .ctx;
    let old_resources = state::read(&ctx).unwrap();
    let release = release::load(&second, &CancellationToken::new()).unwrap();
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    let progress = Arc::new(move |event: Value| {
        if event["phase"] == "prepared" {
            trigger.cancel();
        }
    });
    let error =
        install::apply_with_progress(&second, &paths, &release, &cancel, progress).unwrap_err();
    assert_eq!(error.code, "CANCELLED");
    assert_eq!(std::fs::read(&paths.policy).unwrap(), old_policy);
    assert_eq!(paths.pointer().unwrap(), old_showcase);
    assert_eq!(state::read(&ctx).unwrap(), old_resources);
    assert!(paths.pending.exists());
    assert_eq!(
        gateway_guard(&second.gateway()).err().unwrap().code,
        "PENDING_TRANSACTION"
    );
    // Recovery uses the verified prepared target, even if an old sample is lost.
    std::fs::remove_file(old_root.join("images/sc1000.jpg")).unwrap();
    let result = apply(&second);
    assert_eq!(result["action"], "recovered");
    assert!(!paths.pending.exists());
    assert_ne!(paths.pointer().unwrap(), old_showcase);
    assert!(!old_root.join("images/sc1000.jpg").exists());
    assert!(show(&second).join("images/sc1000.jpg").is_file());
    assert_eq!(
        std::fs::read(show(&second).join("images/sc1001.jpg")).unwrap(),
        b"neutral-sample-release_b-sc1001"
    );
}
#[test]
fn runtime_lease_rejects_live_gateway_without_changing_installation() {
    let temp = directory();
    let options = fixture(temp.path(), "release_a", &["sc1000"]);
    let guard = gateway_guard(&options.gateway()).unwrap();
    assert_eq!(
        execute(
            &Options {
                apply: true,
                ..options.clone()
            },
            &CancellationToken::new()
        )
        .unwrap_err()
        .code,
        "BUSY"
    );
    assert!(!paths::Paths::new(&options).unwrap().policy.exists());
    drop(guard);
    assert_eq!(apply(&options)["action"], "installed");
}

#[tokio::test]
async fn local_routes_use_installed_files_and_forwarded_requests_remain_closed() {
    use axum::{
        body::{Body, to_bytes},
        extract::ConnectInfo,
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;
    let temp = directory();
    let options = fixture(temp.path(), "release_a", &["sc1000"]);
    apply(&options);
    let config = Arc::new(options.gateway());
    let shutdown = CancellationToken::new();
    let mut state = crate::AppState::new(
        config.clone(),
        Arc::new(crate::host::HostAuthority::new(None, None, None)),
        shutdown.clone(),
    );
    state.resources = Some(Arc::new(
        crate::resources::Service::new(&config, shutdown.clone()).unwrap(),
    ));
    state.maintenance = Some(Arc::new(crate::maintenance::MaintenanceService::new(
        &config,
    )));
    state.remote = Some(Arc::new(crate::remote_content::RemoteAccess::new(
        &config, shutdown,
    )));
    let app = crate::router(state);
    for (url, bytes) in [
        (
            "/assets/characters/popular-alpha.png",
            b"asset-release_a".as_slice(),
        ),
        (
            "/scene-showcase/images/sc1000.jpg",
            b"neutral-sample-release_a-sc1000".as_slice(),
        ),
        (
            "/scene-showcase/thumbs/sc1000.jpg",
            b"neutral-sample-release_a-sc1000".as_slice(),
        ),
    ] {
        let request = Request::builder()
            .uri(url)
            .header("host", "127.0.0.1:3210")
            .extension(ConnectInfo(
                "127.0.0.1:1234".parse::<std::net::SocketAddr>().unwrap(),
            ))
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            to_bytes(response.into_body(), 1024).await.unwrap().as_ref(),
            bytes
        );
        let request = Request::builder()
            .uri(url)
            .header("host", "127.0.0.1:3210")
            .header("x-forwarded-for", "203.0.113.9")
            .extension(ConnectInfo(
                "127.0.0.1:1234".parse::<std::net::SocketAddr>().unwrap(),
            ))
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            app.clone().oneshot(request).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
    }
    let request = Request::builder()
        .uri("/scene-showcase/.offline-seed.json")
        .header("host", "127.0.0.1:3210")
        .extension(ConnectInfo(
            "127.0.0.1:1234".parse::<std::net::SocketAddr>().unwrap(),
        ))
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        app.oneshot(request).await.unwrap().status(),
        StatusCode::NOT_FOUND
    );
}
