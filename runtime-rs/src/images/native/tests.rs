use super::*;
#[test]
fn native_defaults_are_explicit_and_unsupported_effects_fail() {
    let input = json!({"family":"anima","sampler":"res_multistep","scheduler":"simple","teaCache":true,"teaCacheThresh":0.08});
    let normalized = normalize(&json!({}), input.clone()).unwrap();
    assert_eq!(normalized["sampler"], "res_multistep");
    assert_eq!(normalized["teaCache"], true);
    assert_eq!(normalized["teaCacheAuto"], true);
    assert!(normalized.get("teaCacheThresh").is_none());
    assert_eq!(normalized["inferenceEngine"], "native");
    for key in ["styleLoraId", "rcas"] {
        let raw = json!({key:true});
        assert_eq!(
            normalize(&raw, input.clone()).unwrap_err().code,
            "NATIVE_FEATURE_UNSUPPORTED"
        );
    }
    assert_eq!(
        normalize(&json!({}), json!({"family":"krea2"}))
            .unwrap_err()
            .code,
        "NATIVE_FAMILY_UNSUPPORTED"
    );
}
#[test]
fn native_sampling_and_hires_preserve_supported_recipes_for_calibration_validation() {
    for (sampler, scheduler) in [
        ("euler", "normal"),
        ("euler", "sgm_uniform"),
        ("res_multistep", "simple"),
    ] {
        let input = json!({"family":"anima","sampler":sampler,"scheduler":scheduler});
        let accepted = normalize(&json!({}), input).unwrap();
        assert_eq!(accepted["sampler"], sampler);
        assert_eq!(accepted["scheduler"], scheduler);
    }
    let input = json!({"family":"anima","hiresFix":true,"hiresScale":1.5,"hiresDenoise":0.35,"hiresUpscaler":"Latent"});
    assert!(normalize(&json!({}), input.clone()).is_ok());
    assert_eq!(
        normalize(&json!({"teaCache":true}), input.clone()).unwrap()["teaCache"],
        true
    );
    assert!(normalize(&json!({"hiresUpscaler":"unknown"}), input).is_err());
    for prompt in ["(red coat:1.2)", "[blue sky]", "a BREAK b"] {
        let accepted = normalize(
            &json!({}),
            json!({"family":"anima","prompt":prompt,"negative":prompt}),
        )
        .unwrap();
        assert_eq!(accepted["prompt"], prompt);
        assert_eq!(accepted["negative"], prompt);
    }
    assert!(
        normalize(
            &json!({}),
            json!({"family":"anima","prompt":r"rossi \(arknights\), coat"})
        )
        .is_ok()
    );
}

#[tokio::test]
async fn native_hires_resolves_fixed_remacri_resource_and_freezes_effective_path() {
    let root = tempfile::tempdir().unwrap();
    let settings = Settings {
        engine: "native".into(),
        acceleration: "native".into(),
        python: root.path().join("python"),
        worker: root.path().join("worker.py"),
        models_root: root.path().join("models"),
        loras_root: root.path().join("loras"),
        environment_overrides: vec![],
    };
    std::fs::write(&settings.python, "fixture").unwrap();
    std::fs::write(&settings.worker, "fixture").unwrap();
    let model = settings.models_root.join("anima-miaomiao-v1.6");
    std::fs::create_dir_all(&model).unwrap();
    std::fs::write(model.join("model_index.json"), "{}").unwrap();
    let profile = model.join(TEACACHE_PROFILE);
    std::fs::write(&profile, "{}").unwrap();
    let input = normalize(&json!({"teaCache":true}), json!({"family":"anima","modelId":"anima-miaomiao-v1.6",
        "sampler":"euler","scheduler":"normal","hiresFix":true,"hiresScale":1.5,"hiresDenoise":0.35,"hiresUpscaler":"Auto"})).unwrap();
    let latent = plan(&settings, input.clone(), &[]).await.unwrap();
    assert_eq!(latent.input["hiresUpscaler"], "Latent");
    assert_eq!(latent.input["hiresSampler"], "euler");
    assert_eq!(latent.input["hiresScheduler"], "normal");
    assert_eq!(latent.input["rcasStrength"], 0.75);
    assert_eq!(latent.input["teaCache"], true);
    assert_eq!(
        latent.tea_cache_profile_path,
        Some(std::fs::canonicalize(&profile).unwrap())
    );
    assert!(latent.upscale_model_path.is_none());
    let mut required = input.clone();
    required["hiresUpscaler"] = json!("Remacri");
    assert!(
        matches!(plan(&settings, required, &[]).await, Err(error) if error.code == "NATIVE_UPSCALER_UNAVAILABLE")
    );
    let weights = settings
        .models_root
        .join("upscale_models")
        .join(REMACRI_FILE);
    std::fs::create_dir_all(weights.parent().unwrap()).unwrap();
    std::fs::write(&weights, "fixture").unwrap();
    let mut injected = input;
    injected["upscaleModelPath"] = json!("/untrusted/path");
    injected["superResModel"] = json!("untrusted.safetensors");
    let pixel = plan(&settings, injected, &[]).await.unwrap();
    assert_eq!(
        pixel.upscale_model_path,
        Some(std::fs::canonicalize(&weights).unwrap())
    );
    assert_eq!(pixel.input["requestedHiresUpscaler"], "Auto");
    assert_eq!(pixel.input["hiresUpscaler"], "Remacri");
    assert_eq!(pixel.input["superResModel"], REMACRI_FILE);
    assert_eq!(pixel.input["rcasStrength"], 0.);
    assert!(pixel.input["hiresSampler"].is_null());
    std::fs::remove_file(&weights).unwrap();
    assert!(
        matches!(plan(&settings, pixel.input, &[]).await, Err(error) if error.code == "NATIVE_UPSCALER_UNAVAILABLE")
    );
}
#[test]
fn native_teacache_requires_explicit_boolean_and_does_not_inherit_comfy_thresholds() {
    let input = json!({"family":"anima","teaCache":true,"teaCacheThresh":0.08});
    let enabled = normalize(&json!({"teaCache":true}), input.clone()).unwrap();
    assert_eq!(enabled["teaCache"], true);
    assert_eq!(enabled["teaCacheAuto"], false);
    assert!(enabled.get("teaCacheThresh").is_none());
    assert_eq!(
        normalize(
            &json!({"teaCache":true,"teaCacheThresh":0.2}),
            input.clone()
        )
        .unwrap()["teaCacheThresh"],
        0.2
    );
    for raw in [
        json!({"teaCache":"true"}),
        json!({"teaCache":false,"teaCacheThresh":0.08}),
        json!({"teaCache":true,"teaCacheThresh":0.}),
        json!({"teaCache":true,"teaCacheThresh":1.01}),
        json!({"teaCacheThresh":0.2}),
    ] {
        assert_eq!(
            normalize(&raw, input.clone()).unwrap_err().code,
            "INVALID_PARAMETER"
        );
    }
    // A caller cannot forge the host-owned marker to weaken explicit requests.
    for enabled in [true, false] {
        let raw = json!({"teaCache":enabled,"teaCacheAuto":true});
        let normalized = normalize(&raw, input.clone()).unwrap();
        assert_eq!(normalized["teaCache"], enabled);
        assert_eq!(normalized["teaCacheAuto"], false);
        assert_eq!(
            validation::validate(&raw, "anima", true).unwrap_err().code,
            "UNKNOWN_PARAMETER"
        );
    }
}
#[tokio::test]
async fn native_teacache_requires_a_contained_local_profile_without_silent_fallback() {
    let root = tempfile::tempdir().unwrap();
    let settings = Settings {
        engine: "native".into(),
        acceleration: "native".into(),
        python: root.path().join("python"),
        worker: root.path().join("worker.py"),
        models_root: root.path().join("models"),
        loras_root: root.path().join("loras"),
        environment_overrides: vec![],
    };
    std::fs::write(&settings.python, "fixture").unwrap();
    std::fs::write(&settings.worker, "fixture").unwrap();
    let model = settings.models_root.join("anima-base-v1.0");
    std::fs::create_dir_all(&model).unwrap();
    std::fs::write(model.join("model_index.json"), "{}").unwrap();
    let mut input = json!({"inferenceEngine":"native","family":"anima","modelId":"anima-base-v1.0",
            "sampler":"euler","scheduler":"simple","teaCache":false,"cfg":4.5});
    assert!(
        plan(&settings, input.clone(), &[])
            .await
            .unwrap()
            .tea_cache_profile_path
            .is_none()
    );
    input["teaCache"] = json!(true);
    match plan(&settings, input.clone(), &[]).await {
        Err(error) => assert_eq!(error.code, "NATIVE_TEACACHE_PROFILE_UNAVAILABLE"),
        Ok(_) => panic!("explicit TeaCache must not silently disable caching"),
    }
    let auto = normalize(&json!({}), input.clone()).unwrap();
    let prepared = plan(&settings, auto.clone(), &[]).await.unwrap();
    assert!(prepared.tea_cache_profile_path.is_none());
    // Resuming the frozen input must not turn auto into a strict true request.
    let resumed = plan(&settings, prepared.input, &[]).await.unwrap();
    assert_eq!(resumed.input["teaCacheAuto"], true);
    assert!(resumed.tea_cache_profile_path.is_none());
    let profile = model.join(TEACACHE_PROFILE);
    std::fs::write(&profile, "").unwrap();
    assert!(tea_cache_profile(&model).await.is_err());
    assert!(matches!(plan(&settings, auto.clone(), &[]).await,
        Err(error) if error.code == "NATIVE_TEACACHE_PROFILE_UNAVAILABLE"));
    std::fs::write(&profile, vec![b' '; 65537]).unwrap();
    assert!(matches!(plan(&settings, auto.clone(), &[]).await,
        Err(error) if error.code == "NATIVE_TEACACHE_PROFILE_UNAVAILABLE"));
    std::fs::remove_file(&profile).unwrap();
    std::fs::create_dir(&profile).unwrap();
    assert!(matches!(plan(&settings, auto, &[]).await,
        Err(error) if error.code == "NATIVE_TEACACHE_PROFILE_UNAVAILABLE"));
    std::fs::remove_dir(&profile).unwrap();
    // Host reports file readiness only. Calibration validity belongs to the worker.
    std::fs::write(&profile, "{}").unwrap();
    input["teaCacheProfilePath"] = json!("/untrusted/profile.json");
    let prepared = plan(&settings, input, &[]).await.unwrap();
    assert_eq!(
        prepared.tea_cache_profile_path,
        Some(std::fs::canonicalize(&profile).unwrap())
    );
    let config = Config {
        sd_host: "http://127.0.0.1:1".into(),
        sd_auth: None,
        comfy_host: "http://127.0.0.1:2".into(),
        ai_workspace_root: root.path().join("AI"),
        runtime_root: root.path().join("runtime"),
    };
    std::fs::create_dir_all(&config.runtime_root).unwrap();
    std::fs::write(
        config.runtime_root.join("config.json"),
        serde_json::to_vec(&json!({"inference":settings})).unwrap(),
    )
    .unwrap();
    let backend =
        generation::Service::for_images(config, LocalUpstream::new(), CancellationToken::new())
            .unwrap();
    let snapshot = status(&backend, "anima").await.unwrap();
    assert_eq!(snapshot["capabilities"]["hiresTeaCache"], true);
    let selected = snapshot["models"]
        .as_array()
        .unwrap()
        .iter()
        .find(|model| model["id"] == "anima-base-v1.0")
        .unwrap();
    assert_eq!(selected["defaults"]["teaCache"], true);
    assert_eq!(selected["defaults"]["teaCachePolicy"], "auto");
    assert_eq!(selected["capabilities"]["teaCache"], true);
    assert_eq!(
        selected["teaCacheProfile"]["readiness"],
        "profile-files-only"
    );
    assert_eq!(selected["teaCacheProfile"]["validation"], "on-load");
    assert_eq!(selected["teaCacheProfile"]["performanceVerified"], false);
    assert_eq!(selected["teaCacheProfile"]["qualityVerified"], false);
    backend.close().await;
    #[cfg(unix)]
    {
        std::fs::remove_file(&profile).unwrap();
        let external = root.path().join("external.json");
        std::fs::write(&external, "{}").unwrap();
        std::os::unix::fs::symlink(&external, &profile).unwrap();
        assert!(tea_cache_profile(&model).await.is_err());
    }
}
#[test]
fn native_manual_mask_requires_original_and_bounded_growth() {
    assert_eq!(
        normalize(&json!({"maskImage":true}), json!({"family":"anima"}))
            .unwrap_err()
            .code,
        "INVALID_PARAMETER"
    );
    let mut input = json!({"family":"anima","maskImage":"mask.png","growMaskBy":6});
    assert_eq!(
        normalize(&input, input.clone()).unwrap_err().code,
        "INVALID_PARAMETER"
    );
    input["initImage"] = json!("source.png");
    assert_eq!(
        normalize(&input, input.clone()).unwrap()["maskImage"],
        "mask.png"
    );
    input["growMaskBy"] = json!(33);
    assert!(normalize(&input, input.clone()).is_err());
    input["growMaskBy"] = json!(6);
    input["maskPrompt"] = json!("clothing");
    assert_eq!(
        normalize(&input, input.clone()).unwrap_err().code,
        "INVALID_PARAMETER"
    );
}
#[test]
fn native_automatic_mask_requires_original_and_bounded_prompt_parameters() {
    let mut input = json!({"family":"anima","maskPrompt":"jacket | sleeves","maskThreshold":0.45,"growMaskBy":8});
    assert_eq!(
        normalize(&input, input.clone()).unwrap_err().code,
        "INVALID_PARAMETER"
    );
    input["initImage"] = json!("source.png");
    assert_eq!(
        normalize(&input, input.clone()).unwrap()["maskPrompt"],
        "jacket | sleeves"
    );
    for (key, value) in [
        ("maskThreshold", json!(0.99)),
        ("growMaskBy", json!(1.5)),
        ("maskPrompt", json!(" | ")),
        ("maskPrompt", json!("x".repeat(4097))),
    ] {
        let mut invalid = input.clone();
        invalid[key] = value;
        assert_eq!(
            normalize(&invalid, invalid.clone()).unwrap_err().code,
            "INVALID_PARAMETER"
        );
    }
}
#[tokio::test]
async fn native_automatic_mask_requires_complete_contained_safetensors_resources() {
    let root = tempfile::tempdir().unwrap();
    let settings = Settings {
        engine: "native".into(),
        acceleration: "native".into(),
        python: root.path().join("python"),
        worker: root.path().join("worker.py"),
        models_root: root.path().join("models"),
        loras_root: root.path().join("loras"),
        environment_overrides: vec![],
    };
    let model = settings.models_root.join(CLIPSEG_FOLDER);
    std::fs::create_dir_all(&model).unwrap();
    for name in CLIPSEG_FILES {
        std::fs::write(model.join(name), "fixture").unwrap();
    }
    assert_eq!(
        clipseg_model_dir(&settings).await,
        Some(std::fs::canonicalize(&model).unwrap())
    );
    std::fs::write(model.join("preprocessor_config.json"), "").unwrap();
    assert!(clipseg_model_dir(&settings).await.is_none());
    std::fs::write(model.join("preprocessor_config.json"), "fixture").unwrap();
    std::fs::remove_file(model.join("model.safetensors")).unwrap();
    std::fs::write(model.join("pytorch_model.bin"), "fixture").unwrap();
    assert!(clipseg_model_dir(&settings).await.is_none());
    #[cfg(unix)]
    {
        let external = root.path().join("external.safetensors");
        std::fs::write(&external, "fixture").unwrap();
        std::os::unix::fs::symlink(&external, model.join("model.safetensors")).unwrap();
        assert!(clipseg_model_dir(&settings).await.is_none());
    }
}
#[tokio::test]
async fn creative_status_keeps_anima_visible_in_aggregate_catalog() {
    let root = tempfile::tempdir().unwrap();
    let config = Config {
        sd_host: "http://127.0.0.1:1".into(),
        sd_auth: None,
        comfy_host: "http://127.0.0.1:2".into(),
        ai_workspace_root: root.path().join("AI"),
        runtime_root: root.path().join("runtime"),
    };
    let backend =
        generation::Service::for_images(config, LocalUpstream::new(), CancellationToken::new())
            .unwrap();
    // /api/creative/status is the shared discovery endpoint used by the UI.
    let aggregate = status(&backend, "krea2").await.unwrap();
    assert!(
        aggregate["models"]
            .as_array()
            .unwrap()
            .iter()
            .any(|model| model["family"] == "anima")
    );
    assert!(!aggregate["loras"].as_array().unwrap().is_empty());
    assert!(
        aggregate["models"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|model| model["family"] == "krea2")
            .all(|model| model["available"] == false)
    );
    let anima = status(&backend, "anima").await.unwrap();
    assert!(
        anima["models"]
            .as_array()
            .unwrap()
            .iter()
            .all(|model| model["family"] == "anima")
    );
    backend.close().await;
}
#[tokio::test]
async fn native_lora_resolves_only_compatible_catalog_resources() {
    let root = tempfile::tempdir().unwrap();
    let settings = Settings {
        engine: "native".into(),
        acceleration: "native".into(),
        python: root.path().join("python"),
        worker: root.path().join("worker.py"),
        models_root: root.path().join("models"),
        loras_root: root.path().join("loras"),
        environment_overrides: vec![],
    };
    std::fs::write(&settings.python, "fixture").unwrap();
    std::fs::write(&settings.worker, "fixture").unwrap();
    let model = settings.models_root.join("anima-base-v1.0");
    std::fs::create_dir_all(&model).unwrap();
    std::fs::write(model.join("model_index.json"), "{}").unwrap();
    std::fs::create_dir_all(&settings.loras_root).unwrap();
    let lora_file = settings.loras_root.join(
        catalog::lora("L_NENE_V21_ANIMA").unwrap()["file"]
            .as_str()
            .unwrap(),
    );
    std::fs::write(&lora_file, "fixture").unwrap();
    let mut input = json!({"inferenceEngine":"native","family":"anima","modelId":"anima-base-v1.0",
            "sampler":"euler","scheduler":"simple","teaCache":false,"cfg":4.5,
            "loraId":"L_NENE_V21_ANIMA","loraStrength":0.8});
    let prepared = plan(&settings, input.clone(), &[]).await.unwrap();
    assert_eq!(
        prepared.loras[0]["path"],
        json!(std::fs::canonicalize(lora_file).unwrap())
    );
    assert_eq!(prepared.loras[0]["strength"], 0.8);
    input["loraId"] = json!("/tmp/arbitrary.safetensors");
    match plan(&settings, input, &[]).await {
        Err(error) => assert_eq!(error.code, "UNKNOWN_LORA"),
        Ok(_) => panic!("raw LoRA paths must not be admitted"),
    }
}
