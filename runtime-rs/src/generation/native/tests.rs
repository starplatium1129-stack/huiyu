use super::*;
use futures_util::future::BoxFuture;

#[derive(Default)]
struct Hooks(std::sync::Mutex<Vec<&'static str>>);
impl ExecutionHooks for Hooks {
    fn checkpoint(&self, _: Value) -> BoxFuture<'_, Result<()>> {
        Box::pin(async {
            self.0.lock().unwrap().push("checkpoint");
            Ok(())
        })
    }
    fn submitting(&self, provider: String, _: String) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            assert_eq!(provider, "native");
            self.0.lock().unwrap().push("submitting");
            Ok(())
        })
    }
    fn observed(&self, _: String, _: Value) -> BoxFuture<'_, Result<()>> {
        Box::pin(async {
            self.0.lock().unwrap().push("observed");
            Ok(())
        })
    }
    fn collect(&self, outputs: Vec<Output>) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            assert_eq!(outputs.len(), 1);
            self.0.lock().unwrap().push("collect");
            Ok(())
        })
    }
}
fn fixture(root: &std::path::Path, script: &str) -> (Arc<Service>, Plan) {
    let worker = root.join("worker.py");
    let body = script.replace("r=json.loads(sys.stdin.readline())", "r=request");
    let body = body
        .lines()
        .map(|line| format!("    {line}\n"))
        .collect::<String>();
    std::fs::write(&worker, format!("import json,sys\nfor line in sys.stdin:\n    request=json.loads(line)\n{body}    print(json.dumps({{'id':request['id'],'event':'ready'}}),flush=True)\n")).unwrap();
    let mut service = Service::for_images(
        Config {
            sd_host: "http://127.0.0.1:1".into(),
            sd_auth: None,
            comfy_host: "http://127.0.0.1:1".into(),
            ai_workspace_root: root.into(),
            runtime_root: root.join("runtime"),
        },
        LocalUpstream::new(),
        CancellationToken::new(),
    )
    .unwrap();
    // Inject the selected engine without process-global environment mutation.
    Arc::get_mut(&mut service.inner).unwrap().native_images = true;
    let plan = Plan {
        input: json!({"family":"anima","modelId":"anima-base-v1.0","prompt":"fixture","negative":"","width":1,"height":1,"steps":2,"cfg":4.5,"seed":1,"sampler":"euler","scheduler":"simple","teaCache":false,"inferenceEngine":"native"}),
        settings: Settings {
            engine: "native".into(),
            python: std::env::var_os("HUIYU_TEST_PYTHON")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "py" } else { "python3" })),
            worker,
            models_root: root.join("models"),
            loras_root: root.join("loras"),
            environment_overrides: vec![],
        },
        model_dir: root.into(),
        mask_model_dir: None,
        tea_cache_profile_path: None,
        init_image: None,
        mask_image: None,
        loras: vec![],
    };
    (Arc::new(service), plan)
}
async fn settled(service: &Service, id: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let state = service.get_job(id, "owner").await.unwrap();
            if terminal(state["status"].as_str().unwrap()) {
                return state;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("fixture worker must settle")
}
#[tokio::test]
async fn native_result_uses_jobs_hooks_and_owner_authorization_without_comfy() {
    let root = tempfile::tempdir().unwrap();
    let (service, mut plan) = fixture(
        root.path(),
        r#"import json,sys,zlib,struct
r=json.loads(sys.stdin.readline())
assert r['input']['teaCache'] is False
assert 'teaCacheThresh' not in r['input'] and r['teaCacheProfilePath'] is None
assert open(r['inputImagePath'],'rb').read()==b'accepted original'
assert r['input']['denoisingStrength']==0.8
assert open(r['maskImagePath'],'rb').read()==b'accepted mask'
assert r['input']['growMaskBy']==6
assert 'maskImage' not in r['input']
assert r['loras'][0]['strength']==0.75
assert r['loras'][0]['path'].endswith('catalog.safetensors')
assert 'initImage' not in r['input'] and 'loraId' not in r['input']
def chunk(t,d): return struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d))
png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>2I5B',1,1,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(b'\0\xff\0\0'))+chunk(b'IEND',b'')
open(r['outputPath'],'wb').write(png)
print(json.dumps({'id':r['id'],'event':'progress','step':1,'total':2}),flush=True)
print(json.dumps({'id':r['id'],'event':'result','outputPath':r['outputPath']}),flush=True)
"#,
    );
    plan.init_image = Some(Arc::new(b"accepted original".to_vec()));
    plan.input["denoisingStrength"] = json!(0.8);
    plan.mask_image = Some(Arc::new(b"accepted mask".to_vec()));
    plan.input["growMaskBy"] = json!(6);
    plan.loras = vec![json!({"path":root.path().join("catalog.safetensors"),"strength":0.75})];
    let hooks = Arc::new(Hooks::default());
    let prepared = service
        .prepare_native(plan, CancellationToken::new())
        .await
        .unwrap();
    let submitted = service
        .clone()
        .submit(prepared, "owner".into(), Some(hooks.clone()))
        .await
        .unwrap();
    let id = submitted["id"].as_str().unwrap();
    let result = settled(&service, id).await;
    assert_eq!(result["status"], "succeeded", "{result}");
    assert_eq!(result["provider"], "native");
    assert_eq!(result["progress"], 1);
    assert_eq!(
        service.result(id, "intruder").await.unwrap_err().code,
        "RESULT_NOT_FOUND"
    );
    assert_eq!(
        service.result(id, "owner").await.unwrap().mime(),
        "image/png"
    );
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if hooks.0.lock().unwrap().contains(&"collect") {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        *hooks.0.lock().unwrap(),
        vec!["checkpoint", "submitting", "observed", "collect"]
    );
    service.close().await;
}

#[tokio::test]
async fn native_teacache_forwards_only_the_host_selected_profile_and_explicit_parameters() {
    let root = tempfile::tempdir().unwrap();
    let (service, mut plan) = fixture(
        root.path(),
        r#"import json,sys
r=json.loads(sys.stdin.readline())
assert r['teaCacheProfilePath'].endswith('teacache-profile.json')
assert r['input']['teaCache'] is True and r['input']['teaCacheThresh']==0.2
assert 'teaCacheProfilePath' not in r['input']
print(json.dumps({'id':r['id'],'event':'error','code':'FIXTURE_TEACACHE_VERIFIED','message':'contract verified'}),flush=True)
"#,
    );
    plan.tea_cache_profile_path = Some(root.path().join("teacache-profile.json"));
    plan.input["teaCache"] = json!(true);
    plan.input["teaCacheThresh"] = json!(0.2);
    plan.input["teaCacheProfilePath"] = json!("/untrusted/request/path");
    let prepared = service
        .prepare_native(plan, CancellationToken::new())
        .await
        .unwrap();
    let submitted = service
        .clone()
        .submit(prepared, "owner".into(), None)
        .await
        .unwrap();
    let result = settled(&service, submitted["id"].as_str().unwrap()).await;
    assert_eq!(result["code"], "FIXTURE_TEACACHE_VERIFIED", "{result}");
    service.close().await;
}
#[tokio::test]
async fn native_cancel_terminates_owned_worker_before_settling() {
    let root = tempfile::tempdir().unwrap();
    let marker = root.path().join("pid");
    let script = format!(
        "import os,sys,json,time\nr=json.loads(sys.stdin.readline())\nopen({},'w').write(str(os.getpid()))\ntime.sleep(60)\n",
        serde_json::to_string(marker.to_str().unwrap()).unwrap()
    );
    let (service, plan) = fixture(root.path(), &script);
    let prepared = service
        .prepare_native(plan, CancellationToken::new())
        .await
        .unwrap();
    let submitted = service
        .clone()
        .submit(prepared, "owner".into(), None)
        .await
        .unwrap();
    let id = submitted["id"].as_str().unwrap();
    let pid: u64 = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(text) = tokio::fs::read_to_string(&marker).await
                && let Ok(pid) = text.parse()
            {
                return pid;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    service.cancel(id, "owner").await.unwrap();
    assert_eq!(settled(&service, id).await["status"], "cancelled");
    assert_eq!(
        crate::processes::liveness(pid),
        "dead",
        "owned worker must be reaped before cancellation settles"
    );
    assert_eq!(service.pending(), 0);
    service.close().await;
}

#[tokio::test]
async fn native_reuses_owned_worker_then_releases_idle_model() {
    let root = tempfile::tempdir().unwrap();
    let script = r#"import base64,os,json,sys
r=json.loads(sys.stdin.readline())
with open(r['modelDir']+'/pid','a') as record: record.write(str(os.getpid())+'\n')
open(r['outputPath'],'wb').write(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='))
print(json.dumps({'id':r['id'],'event':'result','outputPath':r['outputPath']}),flush=True)
"#;
    let (mut service, first) = fixture(root.path(), script);
    Arc::get_mut(&mut Arc::get_mut(&mut service).unwrap().inner)
        .unwrap()
        .native
        .idle_timeout = Duration::from_millis(400);
    let next = |source: &Plan| Plan {
        input: source.input.clone(),
        settings: source.settings.clone(),
        model_dir: source.model_dir.clone(),
        mask_model_dir: None,
        tea_cache_profile_path: None,
        init_image: None,
        mask_image: None,
        loras: vec![],
    };
    let second = next(&first);
    let third = next(&first);
    for plan in [first, second] {
        let prepared = service
            .prepare_native(plan, CancellationToken::new())
            .await
            .unwrap();
        let submitted = service
            .clone()
            .submit(prepared, "owner".into(), None)
            .await
            .unwrap();
        assert_eq!(
            settled(&service, submitted["id"].as_str().unwrap()).await["status"],
            "succeeded"
        );
    }
    let pids = std::fs::read_to_string(root.path().join("pid"))
        .unwrap()
        .lines()
        .map(|line| line.parse::<u64>().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(pids.len(), 2);
    assert_eq!(
        pids[0], pids[1],
        "both requests must use the same owned process"
    );
    let pid = pids[0];
    // The first process is still owned/resident and serves the second request.
    assert_eq!(crate::processes::liveness(pid), "alive");
    tokio::time::timeout(Duration::from_secs(3), async {
        while crate::processes::liveness(pid) != "dead" {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let prepared = service
        .prepare_native(third, CancellationToken::new())
        .await
        .unwrap();
    let submitted = service
        .clone()
        .submit(prepared, "owner".into(), None)
        .await
        .unwrap();
    assert_eq!(
        settled(&service, submitted["id"].as_str().unwrap()).await["status"],
        "succeeded"
    );
    let fresh: u64 = std::fs::read_to_string(root.path().join("pid"))
        .unwrap()
        .lines()
        .last()
        .unwrap()
        .parse()
        .unwrap();
    assert_ne!(pid, fresh);
    service.close().await;
    assert_eq!(crate::processes::liveness(fresh), "dead");
}

#[tokio::test]
async fn native_idle_release_survives_busy_submission_slot_and_worker_reuse() {
    for outcome in ["failed", "reused", "shutdown"] {
        let root = tempfile::tempdir().unwrap();
        let (service, plan) = fixture(root.path(), "");
        let slot = service.inner.native.slot.acquire().await.unwrap();
        let resident = service
            .inner
            .native
            .take_worker(&plan.settings)
            .await
            .unwrap();
        tokio::time::pause();
        Engine::retain_worker(service.inner.clone(), resident).await;
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(121)).await;
        tokio::task::yield_now().await;
        assert!(service.inner.native.worker.lock().await.is_some());
        if outcome == "shutdown" {
            // Shutdown must interrupt the timer even while submission holds
            // the slot; close waits for tracked tasks before process cleanup.
            tokio::time::resume();
            tokio::time::timeout(Duration::from_secs(2), service.close())
                .await
                .expect("shutdown must cancel an idle timer waiting for the slot");
            assert!(service.inner.native.worker.lock().await.is_none());
            continue;
        }
        if outcome == "reused" {
            // A successful submission cancels the expired timer and gives the
            // same process a new idle lifetime before releasing its GPU slot.
            let resident = service
                .inner
                .native
                .take_worker(&plan.settings)
                .await
                .unwrap();
            Engine::retain_worker(service.inner.clone(), resident).await;
            tokio::task::yield_now().await;
        }
        // Otherwise submission failed/cancelled before take_worker, so the old
        // resident must still be released after its already-expired deadline.
        drop(slot);
        if outcome == "reused" {
            tokio::time::advance(Duration::from_secs(119)).await;
            tokio::task::yield_now().await;
            assert!(
                service.inner.native.worker.lock().await.is_some(),
                "an expired old timer must not stop the newly retained worker"
            );
            tokio::time::advance(Duration::from_secs(2)).await;
        }
        tokio::time::resume();
        let released = tokio::time::timeout(Duration::from_secs(2), async {
            while service.inner.native.worker.lock().await.is_some() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        service.close().await;
        assert!(
            released.is_ok(),
            "resident lost its idle release after slot contention"
        );
    }
}

#[tokio::test]
async fn cancellation_before_registration_and_after_worker_success_settles() {
    for completed in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let (service, plan) = fixture(root.path(), "");
        let settings = plan.settings.clone();
        let prepared = service
            .prepare_native(plan, CancellationToken::new())
            .await
            .unwrap();
        let job = jobs::create(prepared, "owner".into(), None);
        if completed {
            let resident = service.inner.native.take_worker(&settings).await.unwrap();
            Engine::retain_worker(service.inner.clone(), resident).await;
        }
        // No registered cancellation token yet, or already completed process.
        cancel(service.inner.clone(), job.clone()).await.unwrap();
        let outcome = if completed {
            Ok(Output::Bytes {
                bytes: Arc::new(vec![1]),
                mime: "image/png".into(),
            })
        } else {
            Err(ApiError::new(
                499,
                "ABORT_ERR",
                "cancelled before worker spawn",
            ))
        };
        settle(&service.inner, &job, outcome, false).await;
        let state = job.state.lock().await;
        assert_eq!(state.status, "cancelled");
        assert!(state.settled && state.result.is_none() && state.permit.is_none());
        drop(state);
        assert!(
            service.inner.native.worker.lock().await.is_none(),
            "late cancellation must retire the resident model before settlement"
        );
        assert_eq!(service.pending(), 0);
        service.close().await;
    }
}

#[tokio::test]
async fn unconfirmed_termination_is_not_reported_as_cancelled() {
    let root = tempfile::tempdir().unwrap();
    let (service, plan) = fixture(root.path(), "");
    let prepared = service
        .prepare_native(plan, CancellationToken::new())
        .await
        .unwrap();
    let job = jobs::create(prepared, "owner".into(), None);
    cancel(service.inner.clone(), job.clone()).await.unwrap();
    settle(
        &service.inner,
        &job,
        Err(ApiError::new(
            503,
            "TERMINATION_UNCONFIRMED",
            "cleanup failed",
        )),
        true,
    )
    .await;
    let state = job.state.lock().await;
    assert_eq!(state.status, "failed");
    assert!(state.unknown && !state.settled && state.permit.is_some());
    assert_eq!(state.code.as_deref(), Some("TERMINATION_UNCONFIRMED"));
    drop(state);
    service.close().await;
}

#[tokio::test]
async fn native_automatic_mask_forwards_only_host_selected_model_and_frozen_parameters() {
    let root = tempfile::tempdir().unwrap();
    let (service, mut plan) = fixture(
        root.path(),
        r#"import json,sys
r=json.loads(sys.stdin.readline())
assert r['maskModelDir'].endswith('clipseg-rd64-refined')
assert r['maskImagePath'] is None
assert open(r['inputImagePath'],'rb').read()==b'accepted original'
assert r['input']['maskPrompt']=='jacket | sleeves'
assert r['input']['maskThreshold']==0.65
assert r['input']['growMaskBy']==4
assert 'maskModelDir' not in r['input']
print(json.dumps({'id':r['id'],'event':'error','code':'FIXTURE_MASK_VERIFIED','message':'contract verified'}),flush=True)
"#,
    );
    plan.init_image = Some(Arc::new(b"accepted original".to_vec()));
    plan.mask_model_dir = Some(root.path().join("clipseg-rd64-refined"));
    plan.input["denoisingStrength"] = json!(0.6);
    plan.input["maskPrompt"] = json!("jacket | sleeves");
    plan.input["maskThreshold"] = json!(0.65);
    plan.input["growMaskBy"] = json!(4);
    plan.input["maskModelDir"] = json!("/untrusted/request/path");
    let prepared = service
        .prepare_native(plan, CancellationToken::new())
        .await
        .unwrap();
    let submitted = service
        .clone()
        .submit(prepared, "owner".into(), None)
        .await
        .unwrap();
    let result = settled(&service, submitted["id"].as_str().unwrap()).await;
    assert_eq!(result["code"], "FIXTURE_MASK_VERIFIED", "{result}");
    service.close().await;
}
