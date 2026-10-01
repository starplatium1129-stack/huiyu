use super::*;
use crate::processes::liveness;
use std::sync::LazyLock;

// Only Python's standard library runs here; no model, CUDA, production input,
// installed ComfyUI process, or user configuration is touched.
const FIXTURE: &str = r#"
import argparse, json, os, pathlib, sys, time
p = argparse.ArgumentParser()
for key in ['model-dir', 'deps-dir', 'torch-site-packages']:
    p.add_argument('--' + key)
args = p.parse_args()
root = pathlib.Path(args.model_dir).parent
mode = lambda: (root / 'mode').read_text()
with (root / 'loads').open('a') as f:
    f.write('load\n')
(root / 'pid').write_text(str(os.getpid()))
ready = dict(kind='ready', ok=True, engine='pixai', model='pixai-tagger-v1.0', meta={'device':'cuda'})
if mode() == 'startup-failure':
    ready.update(ok=False, code='PIXAI_GPU_UNAVAILABLE', error='No fixture GPU')
print(json.dumps(ready), flush=True)
if not ready['ok']:
    sys.exit(1)
for line in sys.stdin:
    req = json.loads(line)
    assert pathlib.Path(req['imagePath']).read_bytes() == b'fixture image'
    assert pathlib.Path(req['imagePath']).parent == root / 'private-input'
    (root / 'started').write_text(req['imagePath'])
    action = mode()
    if action == 'slow':
        time.sleep(120)
    if action == 'eof':
        sys.exit(0)
    if action == 'oversize':
        print('x' * (256 * 1024 + 1), flush=True)
        continue
    if action == 'bad-json':
        print('{unfinished', flush=True)
        continue
    if action == 'failure':
        print(json.dumps({'requestId':req['requestId'], 'ok':False, 'code':'INVALID_IMAGE', 'error':'图片无效'}, ensure_ascii=False), flush=True)
        continue
    result = dict(requestId=req['requestId'], ok=True, engine='pixai', model='pixai-tagger-v1.0', tags=['1girl'], scores={'1girl':0.9}, characterTags=['fixture_character'], rating={'general':0.9,'sensitive':0.1,'questionable':0.1,'explicit':0.01}, meta={})
    if action == 'wrong-id':
        result['requestId'] = 'some-other-request'
    if action == 'invalid-score':
        result['scores']['1girl'] = 2.0
    if action == 'missing-field':
        del result['rating']
    print(json.dumps(result), flush=True)
"#;

static PYTHON: LazyLock<PathBuf> = LazyLock::new(|| {
    let executable = std::env::var_os("AICS_TEST_PYTHON").unwrap_or_else(|| "python".into());
    let output = std::process::Command::new(executable)
        .args(["-c", "import sys; print(sys.executable)"])
        .output()
        .expect("PixAI subprocess fixture requires an installed Python interpreter");
    assert!(output.status.success());
    PathBuf::from(String::from_utf8(output.stdout).unwrap().trim())
});

struct Fixture {
    root: tempfile::TempDir,
    settings: Settings,
}
impl Fixture {
    fn new(mode: &str) -> Self {
        let root = tempfile::tempdir().unwrap();
        let settings = Settings {
            python: PYTHON.clone(),
            model_dir: root.path().join("model"),
            deps_dir: root.path().join("deps"),
            torch_site_packages: root.path().join("torch-site-packages"),
            script: root.path().join("fixture.py"),
            temp_root: root.path().join("private-input"),
        };
        for path in [&settings.model_dir, &settings.temp_root] {
            std::fs::create_dir_all(path).unwrap();
        }
        for path in [
            settings.deps_dir.join("timm"),
            settings.torch_site_packages.join("torch"),
        ] {
            std::fs::create_dir_all(&path).unwrap();
            std::fs::write(path.join("__init__.py"), "").unwrap();
        }
        for file in protocol::MODEL_FILES {
            std::fs::write(settings.model_dir.join(file), "fixture").unwrap();
        }
        std::fs::write(&settings.script, FIXTURE).unwrap();
        std::fs::write(root.path().join("mode"), mode).unwrap();
        Self { root, settings }
    }
    fn set_mode(&self, mode: &str) {
        std::fs::write(self.root.path().join("mode"), mode).unwrap();
        let _ = std::fs::remove_file(self.root.path().join("started"));
    }
    fn pid(&self) -> u64 {
        std::fs::read_to_string(self.root.path().join("pid"))
            .unwrap()
            .parse()
            .unwrap()
    }
    fn inputs_clean(&self) {
        assert_eq!(
            std::fs::read_dir(&self.settings.temp_root).unwrap().count(),
            0
        );
    }
    async fn started(&self) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !self.root.path().join("started").is_file() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }
}

async fn run(client: &Client) -> Result<Value> {
    client
        .run(
            Arc::new(b"fixture image".to_vec()),
            0.17,
            CancellationToken::new(),
        )
        .await
}

#[tokio::test]
async fn retains_one_load_and_deletes_each_private_input() {
    let fixture = Fixture::new("normal");
    let client = Client::new(fixture.settings.clone());
    let status = client.probe().await;
    assert_eq!(status["available"], true);
    assert_eq!(status["cached"], false);
    assert!(!fixture.root.path().join("loads").exists());
    assert_eq!(run(&client).await.unwrap()["tags"], json!(["1girl"]));
    let pid = fixture.pid();
    assert_eq!(
        run(&client).await.unwrap()["characterTags"],
        json!(["fixture_character"])
    );
    assert_eq!(fixture.pid(), pid);
    assert_eq!(
        std::fs::read_to_string(fixture.root.path().join("loads")).unwrap(),
        if cfg!(windows) { "load\r\n" } else { "load\n" }
    );
    assert_eq!(client.probe().await["gpuResident"], true);
    assert_eq!(liveness(pid), "alive");
    fixture.inputs_clean();
    client.close().await;
    assert_eq!(liveness(pid), "dead");
    assert_eq!(client.probe().await["cached"], false);
    assert_eq!(run(&client).await.unwrap_err().code, "INTERROGATE_CLOSED");
}

#[tokio::test]
async fn cancellation_and_abandoned_request_keep_admission_until_cleanup() {
    for abandon in [false, true] {
        let fixture = Fixture::new("slow");
        let client = Arc::new(Client::new(fixture.settings.clone()));
        let cancel = CancellationToken::new();
        let request = tokio::spawn({
            let client = client.clone();
            let cancel = cancel.clone();
            async move {
                client
                    .run(Arc::new(b"fixture image".to_vec()), 0.17, cancel)
                    .await
            }
        });
        fixture.started().await;
        let pid = fixture.pid();
        assert_eq!(run(&client).await.unwrap_err().code, "INTERROGATE_BUSY");
        assert_eq!(client.probe().await["busy"], true);
        if abandon {
            request.abort();
            assert!(request.await.unwrap_err().is_cancelled());
        } else {
            cancel.cancel();
            assert_eq!(request.await.unwrap().unwrap_err().code, "CANCELLED");
            assert_eq!(liveness(pid), "dead");
            fixture.inputs_clean();
        }
        client.close().await;
        assert_eq!(liveness(pid), "dead");
        fixture.inputs_clean();
    }
}

#[tokio::test]
async fn active_close_and_timeout_stop_worker_before_returning() {
    for close in [false, true] {
        let fixture = Fixture::new("normal");
        let mut client = Client::new(fixture.settings.clone());
        run(&client).await.unwrap();
        client.timeout = Duration::from_millis(250);
        let client = Arc::new(client);
        fixture.set_mode("slow");
        let request = tokio::spawn({
            let client = client.clone();
            async move { run(&client).await }
        });
        fixture.started().await;
        let pid = fixture.pid();
        if close {
            client.close().await;
        }
        let code = request.await.unwrap().unwrap_err().code;
        assert_eq!(
            code,
            if close {
                "INTERROGATE_CLOSED"
            } else {
                "INTERROGATE_TIMEOUT"
            }
        );
        assert_eq!(liveness(pid), "dead");
        fixture.inputs_clean();
        client.close().await;
    }
}

#[tokio::test]
async fn invalid_or_disconnected_protocol_never_returns_success_and_can_restart() {
    let fixture = Fixture::new("normal");
    let client = Client::new(fixture.settings.clone());
    for mode in [
        "wrong-id",
        "invalid-score",
        "missing-field",
        "bad-json",
        "oversize",
        "eof",
    ] {
        fixture.set_mode(mode);
        assert_eq!(
            run(&client).await.unwrap_err().code,
            "PIXAI_PROTOCOL_ERROR",
            "{mode}"
        );
        assert_eq!(liveness(fixture.pid()), "dead");
        assert_eq!(client.probe().await["cached"], false);
        fixture.inputs_clean();
    }
    fixture.set_mode("normal");
    run(&client).await.unwrap();
    client.close().await;
}

#[tokio::test]
async fn worker_failures_preserve_useful_error_instead_of_fallback() {
    let fixture = Fixture::new("startup-failure");
    let client = Client::new(fixture.settings.clone());
    assert_eq!(
        run(&client).await.unwrap_err().code,
        "PIXAI_GPU_UNAVAILABLE"
    );
    assert_eq!(liveness(fixture.pid()), "dead");
    fixture.set_mode("failure");
    let error = run(&client).await.unwrap_err();
    assert_eq!(error.code, "INVALID_IMAGE");
    assert_eq!(error.message, "图片无效");
    assert_eq!(error.status, axum::http::StatusCode::BAD_REQUEST);
    assert_eq!(liveness(fixture.pid()), "dead");
    fixture.inputs_clean();
    client.close().await;
}
