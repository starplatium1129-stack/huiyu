use super::*;

pub(super) fn fixture(root: &std::path::Path, script: &str) -> (Arc<Service>, Plan) {
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
            acceleration: "native".into(),
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
        upscale_model_path: None,
        init_image: None,
        mask_image: None,
        loras: vec![],
    };
    (Arc::new(service), plan)
}
