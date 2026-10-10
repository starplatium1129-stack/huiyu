use super::*;
const MODEL: &str = "anima-base-v1.0";
fn inputs(s: &ControlService) -> (PrepareRequest, PathBuf) {
    let root = &s.config.app_root;
    std::fs::create_dir_all(root.join("scripts/maintenance")).unwrap();
    for name in ["prepare-inference.py", "import-anima-directory.py"] {
        std::fs::write(
            root.join("scripts/maintenance").join(name),
            "# fixture helper\n",
        )
        .unwrap();
    }
    let python = root.join("fake-python");
    std::fs::write(&python, "fixture").unwrap();
    let wheels = root.join("offline wheels;literal");
    let source = root.join("source directory;literal");
    std::fs::create_dir(&wheels).unwrap();
    std::fs::create_dir(&source).unwrap();
    let mut configured = s.inference.as_ref().unwrap().clone();
    configured.python = python.clone();
    s.saved.write().unwrap()["inference"] = serde_json::to_value(configured).unwrap();
    (
        PrepareRequest {
            base_python: python,
            wheelhouse: wheels,
            workspace_path: s.config.ai_workspace_root.clone(),
            reviewed: true,
        },
        source,
    )
}
#[cfg(unix)]
fn executable(path: &Path, body: &str) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
}
#[cfg(unix)]
fn prepare_receipt(s: &ControlService) -> Value {
    let root = s.config.ai_workspace_root.join("inference");
    json!({"ok":true,"schemaVersion":1,"engine":"native","root":root,
            "python":root.join("venv/bin/python"),"worker":s.config.app_root.join("tools/inference/worker.py"),
            "modelRoot":root.join("models"),"environment":{}})
}
#[cfg(unix)]
async fn settled(s: &ControlService) -> Value {
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let op = s.state.lock().unwrap().operation.clone().unwrap();
            if op["status"] != "running" {
                return op;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn strict_review_path_catalog_and_saved_root_guards() {
    let (_temp, s) = super::super::tests::fixture(json!({}));
    let (mut request, source) = inputs(&s);
    request.reviewed = false;
    assert_eq!(
        s.prepare_inference(request).unwrap_err().code,
        "WORKSPACE_CHANGED"
    );
    assert!(absolute(Path::new("relative/python")).is_err());
    assert!(existing(&source, false).is_err());
    assert!(s.model_import_command("../escape", &source, None).is_err());
    assert!(
        s.model_import_command("krea2-turbo-fp8", &source, None)
            .is_err()
    );
    assert_eq!(
        s.model_import_command(MODEL, &source, Some(&s.config.app_root))
            .unwrap_err()
            .code,
        "MODELS_ROOT_CHANGED"
    );
    let (command, target) = s.model_import_command(MODEL, &source, None).unwrap();
    let args: Vec<_> = command
        .as_std()
        .get_args()
        .map(|s| s.to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        args,
        vec![
            "-I".to_owned(),
            "-B".into(),
            "-u".into(),
            s.config
                .app_root
                .join("scripts/maintenance/import-anima-directory.py")
                .to_string_lossy()
                .into_owned(),
            "--source-dir".into(),
            source.to_string_lossy().into_owned(),
            "--target-dir".into(),
            target.to_string_lossy().into_owned()
        ]
    );
    std::fs::create_dir_all(&target).unwrap();
    assert_eq!(
        s.model_import_command(MODEL, &source, None)
            .unwrap_err()
            .code,
        "MODEL_TARGET_EXISTS"
    );
    for value in [
        json!({"modelId":MODEL,"sourceDir":source,"extra":true}),
        json!({"modelId":MODEL}),
    ] {
        assert!(serde_json::from_value::<InspectRequest>(value).is_err());
    }
    assert!(serde_json::from_value::<PrepareRequest>(json!({"basePython":"/python","wheelhouse":"/wheels","workspacePath":"/workspace","reviewed":true,"args":["-c"]})).is_err());
    assert!(
        serde_json::from_value::<ImportRequest>(
            json!({"modelId":MODEL,"sourceDir":source,"modelsRoot":"/models"})
        )
        .is_err()
    );
    assert!(s.state.lock().unwrap().operation.is_none());
    s.close().await;
}
#[cfg(unix)]
#[tokio::test]
async fn preparation_uses_fixed_arguments_and_preserves_configuration() {
    let (_temp, s) = super::super::tests::fixture(json!({"unrelated":true}));
    let (request, _) = inputs(&s);
    let args_path = s.config.app_root.join("arguments");
    executable(
        &request.base_python,
        &format!(
            "printf '%s\\n' \"$@\" > '{}'\nprintf '%s\\n' '{}'",
            args_path.display(),
            prepare_receipt(&s)
        ),
    );
    let saved = s.saved.read().unwrap().clone();
    let active = s.inference.as_ref().unwrap().clone();
    let root = s.config.ai_workspace_root.join("inference");
    let expected = vec![
        "-I".into(),
        "-B".into(),
        "-u".into(),
        s.config
            .app_root
            .join("scripts/maintenance/prepare-inference.py")
            .display()
            .to_string(),
        "--target-dir".into(),
        root.display().to_string(),
        "--apply".into(),
        "--wheelhouse".into(),
        request.wheelhouse.display().to_string(),
    ];
    let response = s.prepare_inference(request).unwrap();
    let operation = settled(&s).await;
    assert_eq!(operation["status"], "completed");
    assert_eq!(operation["preparedPaths"], response["preparedPaths"]);
    assert_eq!(operation["result"]["ok"], true);
    let mut invalid = operation["result"].clone();
    invalid["python"] = json!("/unexpected/python");
    assert!(validate_prepared_result(&invalid, &operation).is_err());
    assert_eq!(
        std::fs::read_to_string(args_path)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect::<Vec<_>>(),
        expected
    );
    assert_eq!(*s.saved.read().unwrap(), saved);
    assert_eq!(s.inference.as_ref().unwrap(), &active);
    assert!(s.setup_permit().is_ok());
    s.close().await;
}
#[cfg(unix)]
#[tokio::test]
async fn inspection_is_read_only_and_import_has_layout_only_result() {
    let (_temp, s) = super::super::tests::fixture(json!({}));
    let (request, source) = inputs(&s);
    let models_root = s.configured_inference().unwrap().models_root;
    let result = json!({"ok":true,"planOnly":true,"sourceDir":source,"targetDir":models_root.join(MODEL),"scope":"layout-only","readyForInference":false,"fileCount":8,"totalBytes":100,"published":false,"downloads":false});
    executable(
        &request.base_python,
        &format!("printf '%s\\n' '{}'", result),
    );
    let Json(plan) = inspect(
        Extension(s.clone()),
        Json(InspectRequest {
            model_id: MODEL.into(),
            source_dir: source.clone(),
        }),
    )
    .await
    .unwrap();
    assert_eq!(plan, result);
    assert!(!models_root.exists());
    let mut applied = result.clone();
    applied["planOnly"] = json!(false);
    applied["published"] = json!(true);
    executable(
        &request.base_python,
        &format!("printf '%s\\n' '{}'", applied),
    );
    let Json(response) = import(
        Extension(s.clone()),
        Json(ImportRequest {
            model_id: MODEL.into(),
            source_dir: source.clone(),
            models_root: models_root.clone(),
            reviewed: true,
        }),
    )
    .await
    .unwrap();
    let op = settled(&s).await;
    assert_eq!(op["status"], "completed");
    assert_eq!(op["id"], response["operation"]["id"]);
    assert_eq!(op["modelsRoot"], json!(models_root));
    assert_eq!(op["result"], applied);
    assert!(
        !models_root.exists(),
        "only the helper may create the destination after its path/layout checks"
    );
    s.close().await;
}
#[cfg(target_os = "linux")]
#[tokio::test]
async fn cancellation_stops_owned_child_tree_before_releasing_operation() {
    let (_temp, s) = super::super::tests::fixture(json!({}));
    let (request, _) = inputs(&s);
    let pids = s.config.app_root.join("pids");
    executable(
        &request.base_python,
        &format!(
            "sleep 30 &\nprintf '%s %s' \"$$\" \"$!\" > '{}'\nwait",
            pids.display()
        ),
    );
    let response = s.prepare_inference(request).unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while !pids.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(s.setup_permit().unwrap_err().code, "SETUP_BUSY");
    assert_eq!(
        s.cancel_environment(Some("old-operation"))
            .unwrap_err()
            .code,
        "OPERATION_CHANGED"
    );
    s.cancel_environment(response["operation"]["id"].as_str())
        .unwrap();
    assert_eq!(settled(&s).await["status"], "failed");
    let ids = std::fs::read_to_string(pids).unwrap();
    let ids: Vec<_> = ids.split_whitespace().collect();
    assert!(
        !PathBuf::from(format!("/proc/{}", ids[0])).exists(),
        "direct child must be reaped"
    );
    if let Ok(state) = std::fs::read_to_string(format!("/proc/{}/stat", ids[1])) {
        assert!(
            state.split_once(") ").unwrap().1.starts_with('Z'),
            "descendant must no longer run"
        );
    }
    assert!(s.setup_permit().is_ok());
    s.close().await;
}
#[cfg(unix)]
#[tokio::test]
async fn helper_errors_are_redacted_and_stdout_is_bounded() {
    let (_temp, s) = super::super::tests::fixture(json!({}));
    let (request, _) = inputs(&s);
    executable(
        &request.base_python,
        &format!(
            "printf '%s' '{}fixture-secret-token token=fixture' >&2\nexit 1",
            "x".repeat(1490)
        ),
    );
    s.prepare_inference(request).unwrap();
    let op = settled(&s).await;
    assert_eq!(op["status"], "failed");
    assert!(!op["error"].as_str().unwrap().contains("fixture"));
    assert!(bounded_output(Some(&b"12345"[..]), 4).await.is_err());
    assert_eq!(
        bounded_output(Some(&b"1234"[..]), 4).await.unwrap(),
        b"1234"
    );
    s.close().await;
}
