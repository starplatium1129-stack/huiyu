mod network;
use super::*;
use crate::{AppState, config::Config, host::HostAuthority};
use lifecycle::Operation;
use manifest::{Entry, Manifest};
use std::{io::Write, path::Path, sync::Arc};
use tokio_util::sync::CancellationToken;
fn config(root: &Path) -> Config {
    Config {
        app_root: root.join("app"),
        runtime_root: root.join("runtime"),
        ai_workspace_root: root.join("AI"),
        sd_host: "http://127.0.0.1:1".into(),
        sd_auth: None,
        comfy_host: "http://127.0.0.1:1".into(),
        bind: "127.0.0.1:3210".parse().unwrap(),
        token: String::new(),
        desktop_secret: None,
        source_profile_id: None,
        workspace_pointer: None,
        workspace_candidate: None,
        config_root: None,
        gateway_origin: "http://127.0.0.1:3210".into(),
        workspace_root: None,
        workspace_id: None,
        create_workspace: false,
    }
}
fn write(file: &Path, bytes: &[u8]) {
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
fn pack(
    root: &Path,
    resources: &[(&str, &[u8])],
    delta: Option<&Value>,
    target: &Manifest,
) -> Value {
    let manifest = Manifest {
        entries: resources
            .iter()
            .map(|(path, bytes)| entry(path, bytes))
            .collect(),
    };
    let raw = serde_json::to_vec(&manifest.value()).unwrap();
    let delta_raw = delta.map(|value| serde_json::to_vec(value).unwrap());
    write(&root.join("manifest.json"), &raw);
    if let Some(delta) = &delta_raw {
        write(&root.join("delta.json"), delta);
    }
    for (path, bytes) in resources {
        write(&root.join(path), bytes);
    }
    json!({"approved":true,"packageIdentity":policy::package_identity(&raw,delta_raw.as_deref()),"targetIdentity":target.identity(),"kind":if delta.is_some(){"delta"}else{"full"},"sourceId":"source","path":root.file_name().unwrap().to_string_lossy()})
}
fn delta(base: &Manifest, pack: &Manifest, target: &Manifest) -> Value {
    json!({"schemaVersion":1,"kind":"resource-pack-delta","baseManifest":{"path":"base.json","contentIdentity":base.identity(),"entryCount":base.entries.len(),"totalBytes":base.bytes()},"newManifest":{"path":"next.json","contentIdentity":target.identity(),"entryCount":target.entries.len(),"totalBytes":target.bytes()},"totals":{"added":1,"removed":1,"changed":1,"unchanged":1},"removed":[base.entries[2]],"candidate":{"files":pack.entries.len(),"bytes":pack.bytes(),"zeroAssets":false}})
}
fn oracle(input: Value) -> Value {
    use std::process::{Command, Stdio};
    let mut command = Command::new("node");
    command
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/resources/tests/oracle.cjs"
        ))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(serde_json::to_string(&input).unwrap().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
fn fixture() -> (tempfile::TempDir, Config, PathBuf, config::Context, Value) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let gateway = config(root);
    std::fs::create_dir_all(&gateway.app_root).unwrap();
    let user = root.join("user");
    std::fs::create_dir(&user).unwrap();
    let source = root.join("source");
    let base = Manifest {
        entries: vec![
            entry("assets/a.png", b"A"),
            entry("assets/keep.txt", b"K"),
            entry("assets/remove.bin", b"R"),
        ],
    };
    let changed = Manifest {
        entries: vec![entry("assets/a.png", b"B"), entry("assets/new.png", b"N")],
    };
    let target = Manifest {
        entries: vec![
            changed.entries[0].clone(),
            base.entries[1].clone(),
            changed.entries[1].clone(),
        ],
    };
    let delta = delta(&base, &changed, &target);
    let release_a = pack(
        &source.join("A"),
        &[
            ("assets/a.png", b"A"),
            ("assets/keep.txt", b"K"),
            ("assets/remove.bin", b"R"),
        ],
        None,
        &base,
    );
    let release_b = pack(
        &source.join("B"),
        &[("assets/a.png", b"B"), ("assets/new.png", b"N")],
        Some(&delta),
        &target,
    );
    let full = Manifest {
        entries: vec![entry("assets/a.png", b"C")],
    };
    let release_c = pack(&source.join("C"), &[("assets/a.png", b"C")], None, &full);
    let policy = json!({"sources":{"source":{"approved":true,"kind":"offline","root":source}},"releases":{"A":release_a,"B":release_b,"C":release_c}});
    let file = root.join("resource-policy.json");
    write(
        &file,
        &serde_json::to_vec(
            &json!({"userDataRoot":user,"protectedRoots":[gateway.app_root],"policy":policy}),
        )
        .unwrap(),
    );
    let ctx = config::load(&gateway, &file, CancellationToken::new())
        .unwrap()
        .ctx;
    (directory, gateway, file, ctx, policy)
}
fn operation(ctx: &config::Context) -> Operation {
    Operation {
        ctx: ctx.clone(),
        cancel: CancellationToken::new(),
        progress: Arc::new(|_| {}),
    }
}
#[test]
fn approved_full_delta_rollback_and_prepared_recovery_interoperate_with_node() {
    let (directory, gateway, _file, ctx, policy) = fixture();
    assert!(!ctx.store.exists());
    assert!(
        resolve::snapshot(&ctx, &CancellationToken::new())
            .unwrap()
            .is_none()
    );
    assert!(!ctx.store.exists());
    let op = operation(&ctx);
    let a = lifecycle::run(&op, "import", "A").unwrap();
    let b = lifecycle::run(&op, "import", "B").unwrap();
    assert_eq!(b["state"]["sequence"], 2);
    let root = state::version_root(&ctx, &b["state"]["current"]).unwrap();
    assert_eq!(std::fs::read(root.join("assets/a.png")).unwrap(), b"B");
    assert!(!root.join("assets/remove.bin").exists());
    assert_eq!(std::fs::read(root.join("assets/keep.txt")).unwrap(), b"K");
    let rollback = lifecycle::run(&op, "rollback", "").unwrap();
    assert_eq!(rollback["state"]["current"], a["state"]["current"]);
    let node_user = directory.path().join("node-user");
    std::fs::create_dir(&node_user).unwrap();
    assert_eq!(
        oracle(
            json!({"workflow":true,"userDataRoot":node_user,"appRoot":gateway.app_root,"policy":policy})
        ),
        rollback["state"]
    );
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    let interrupted = Operation {
        ctx: ctx.clone(),
        cancel,
        progress: Arc::new(move |event| {
            if event["phase"] == "prepared" {
                trigger.cancel();
            }
        }),
    };
    assert_eq!(
        lifecycle::run(&interrupted, "import", "C")
            .unwrap_err()
            .code,
        "CANCELLED"
    );
    assert_eq!(state::read(&ctx).unwrap(), rollback["state"]);
    assert_eq!(
        resolve::snapshot(&ctx, &CancellationToken::new())
            .unwrap_err()
            .code,
        "PENDING_TRANSACTION"
    );
    let source = directory.path().join("source/C");
    let hidden = directory.path().join("source-hidden-C");
    assert!(source.starts_with(directory.path()) && hidden.starts_with(directory.path()));
    std::fs::rename(source, hidden).unwrap();
    let recovered = lifecycle::run(&op, "recover", "").unwrap();
    assert_eq!(recovered["state"]["current"]["releaseId"], "C");
    assert!(!ctx.store.join("pending.json").exists());
    let snapshot = resolve::snapshot(&ctx, &CancellationToken::new())
        .unwrap()
        .unwrap();
    assert_eq!(snapshot.entries.len(), 1);
    write(&snapshot.root.join("assets/a.png"), b"X");
    assert_eq!(
        resolve::snapshot(&ctx, &CancellationToken::new())
            .unwrap_err()
            .code,
        "CONTENT_INVALID"
    );
}
#[test]
fn resource_manifest_and_delta_contract_match_original_pure_node() {
    let base = Manifest {
        entries: vec![
            entry("assets/a.png", b"A"),
            entry("assets/keep.txt", b"K"),
            entry("assets/remove.bin", b"R"),
        ],
    };
    let changed = Manifest {
        entries: vec![entry("assets/a.png", b"B"), entry("assets/new.png", b"N")],
    };
    let target = Manifest {
        entries: vec![
            changed.entries[0].clone(),
            base.entries[1].clone(),
            changed.entries[1].clone(),
        ],
    };
    let delta = delta(&base, &changed, &target);
    let mut forms = vec![
        base.value(),
        json!({"schemaVersion":1,"entries":[],"unverified":[{}]}),
    ];
    for path in [
        "assets/../outside.png",
        "assets/x.js",
        "assets/CON.png",
        "assets/%2e%2e/x.png",
    ] {
        forms.push(
            json!({"schemaVersion":1,"entries":[{"path":path,"bytes":0,"sha256":digest([])}]}),
        );
    }
    let result = oracle(
        json!({"base":base.value(),"baseManifest":base.value(),"packManifest":changed.value(),"delta":delta,"forms":forms}),
    );
    assert_eq!(result["identity"], base.identity());
    assert_eq!(result["delta"], true);
    assert_eq!(
        result["target"],
        super::delta::reconstruct(&base, &changed, &delta)
            .unwrap()
            .value()
    );
    for (index, value) in forms.iter().enumerate() {
        let actual = match Manifest::parse(value) {
            Ok(value) => json!({"value":value.value()}),
            Err(error) => json!({"code":error.code}),
        };
        assert_eq!(actual, result["forms"][index]);
    }
    let mut tampered = delta;
    tampered["totals"]["unchanged"] = 2.into();
    assert!(super::delta::reconstruct(&base, &changed, &tampered).is_err());
}
