use super::*;
use crate::{
    AppState,
    config::Config,
    host::HostAuthority,
    maintenance::{MaintenanceService, router},
};
use axum::{
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use std::{
    collections::HashSet,
    io::{Read, Write},
    path::Path,
    sync::Arc,
};
use tower::ServiceExt;
fn write(root: &Path, name: &str, value: &Value) {
    let path = root.join(name);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, blueprints::json_text(value)).unwrap();
}
fn fixture(root: &Path) {
    super::super::contracts::tests::fixture(root);
    for name in super::super::context::VERSIONED_FILES {
        if !["popular-characters.json", "scene-blueprints.json"].contains(name) {
            write(root, &format!("data/{name}"), &json!([]));
        }
    }
    let ids = [1, 207, 208, 209, 210, 301, 302, 303, 304];
    let scenes=ids.iter().map(|number|{let (id,character,trigger,name)=if *number==1{(format!("sc{number:03}"),"nene","ayachi_nene","寧々")}else{(format!("sc{number:03}"),"natsume","shiki_natsume","夏目")};json!({"id":id,"title":"Neutral library","char":character,"character":[character],"category":"Core","story":"A quiet library has several windows facing a garden. The afternoon light falls across a wooden table beside an open book.","storyJa":format!("【{name}】静かな部屋で本を読み、窓に光が差します。"),"lora":"fixture","emotion":"calm","season":"spring","time":"day","timeOfDay":"afternoon","tags":["1girl","book"],"rating":"All","mature":false,"location":"library","weather":"clear","camera":"medium","lighting":"window","usage":["fixture"],"prompt":format!("1girl, {trigger}, adult, reading_book, library, wooden_table, soft_window_light, quiet_room, afternoon, paper_pages, green_garden, chair"),"negative":"text, watermark, signature, bad hands, extra fingers, missing fingers","recommendedSize":"768×1024"})}).collect::<Vec<_>>();
    let pins = scenes
        .iter()
        .map(|scene| (scene["id"].as_str().unwrap().to_owned(), json!(true)))
        .collect::<serde_json::Map<_, _>>();
    write(
        root,
        "data/prompt-pinned-scenes.json",
        &json!({"scenes":pins}),
    );
    write(
        root,
        "data/scenes/manifest.json",
        &json!({"batchSize":50,"files":[{"file":"nene-core.json","character":"nene"},{"file":"natsume-core.json","character":"natsume"}]}),
    );
    write(root, "data/scenes/nene-core.json", &json!([scenes[0]]));
    write(root, "data/scenes/natsume-core.json", &json!(scenes[1..]));
    let active = ids.into_iter().collect::<HashSet<_>>();
    write(
        root,
        "data/retired-scenes.json",
        &json!({"records":(1..=304).filter(|id|!active.contains(id)).map(|id|json!({"id":format!("sc{id:03}"),"reason":"neutral fixture"})).collect::<Vec<_>>()}),
    );
    write(
        root,
        "data/curation.json",
        &json!({"curatedSceneIds":["sc001","sc207"],"signatureSceneIds":["sc001"],"reviewSceneIds":[],"personaCoreSceneIds":["sc001","sc207"],"recommendationReasons":{"sc001":"neutral fixture"},"moodRails":[{"id":"library","title":"Library","query":"library"}]}),
    );
    write(
        root,
        "data/characters.json",
        &json!([{"id":"nene","traits":[{"tag":"white_hair"},{"tag":"low_twintails"},{"tag":"purple_eyes"},{"tag":"ahoge"},{"tag":"hair_ribbon"}],"lora":{"name":"fixture","recommended_scene":["sc001"]}},{"id":"natsume","traits":[{"tag":"black_hair"},{"tag":"long_hair"},{"tag":"yellow_eyes"},{"tag":"mole_under_eye"},{"tag":"hairclip"}],"lora":{"name":"fixture","recommended_scene":["sc207"]}}]),
    );
    let profiles=["wai_illustrious_v17","anima_base_v10","anima_aesthetic_v11","krea2_turbo_fp8"].map(|id|json!({"id":id,"match":["fixture"],"quality_prefix":"","negative_prefix":"text","sampler":"Euler","steps":20,"cfg":6,"size":"768×1024"}));
    write(
        root,
        "data/presets.json",
        &json!({"model_profiles":profiles,"presets":[{"id":"fixture","name":"fixture","sampler":"Euler","steps":20,"cfg":6,"size":"768×1024"}]}),
    );
    std::fs::create_dir_all(root.join("src/stores")).unwrap();
    std::fs::write(
        root.join("src/stores/sceneStore.ts"),
        "import version from 'virtual:data-version';",
    )
    .unwrap();
    let mut characters = fs::json(&root.join("data/characters.json")).unwrap();
    for character in characters.as_array_mut().unwrap() {
        for (key, value) in [
            ("name", json!("Neutral")),
            ("source", json!("Fixture")),
            ("speech", json!("Fixture")),
            ("portrait", json!({"image":"../assets/neutral.png"})),
            ("visual_dna", json!({"signature":"neutral"})),
        ] {
            character[key] = value;
        }
        character["lora"]["weight"] = json!(1);
    }
    write(root, "data/characters.json", &characters);
    write(
        root,
        "data/loras.json",
        &json!([{"id":"fixture","name":"fixture","strength":{"min":0,"default":1,"max":2},"compatible_models":["fixture"],"test_scene":["sc001"]}]),
    );
    let popular = fs::json(&root.join("data/popular-characters.json")).unwrap();
    write(
        root,
        "data/popular/manifest.json",
        &json!({"version":1,"files":[{"file":"fixture.json","franchise":"Fixture","count":1}]}),
    );
    write(
        root,
        "data/popular/fixture.json",
        &json!({"version":1,"franchise":"Fixture","characters":popular["characters"]}),
    );
    let mut blueprints = fs::json(&root.join("data/scene-blueprints.json")).unwrap();
    for blueprint in blueprints["blueprints"].as_array_mut().unwrap() {
        blueprint["negativeTokens"] = json!(["blur", "artifact"]);
    }
    write(root, "data/scene-blueprints.json", &blueprints);
    write(
        root,
        "data/blueprints/manifest.json",
        &json!({"version":1,"files":[{"file":"fixture.json","franchise":"Fixture","count":20}]}),
    );
    write(
        root,
        "data/blueprints/fixture.json",
        &json!({"version":2,"franchise":"Fixture","blueprints":blueprints["blueprints"]}),
    );
    let mut compressed = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    compressed.write_all(b"old stale fixture").unwrap();
    std::fs::write(
        root.join("data/scenes.json.gz"),
        compressed.finish().unwrap(),
    )
    .unwrap();
}
#[tokio::test]
async fn actual_http_save_commits_and_failed_validation_restores_original_bytes() {
    http_save(false).await;
}
#[tokio::test]
async fn packaged_http_save_uses_writable_content_and_preserves_bundle() {
    http_save(true).await;
}
async fn http_save(packaged: bool) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("app");
    fixture(&root);
    let config = Arc::new(Config {
        app_root: root.clone(),
        runtime_root: directory.path().join("runtime"),
        ai_workspace_root: directory.path().join("AI"),
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
    });
    config.prepare_content_for(packaged).unwrap();
    let bundled = std::fs::read(root.join("data/scenes/nene-core.json")).unwrap();
    let package_root = root;
    let root = config.content_root_for(packaged);
    let options = Options {
        assets_root: Some(package_root.join("assets")),
        root: root.clone(),
        runtime: config.runtime_root.clone(),
        showcase: None,
    };
    let mut service = MaintenanceService::new(&config);
    service.options = options.clone();
    let config_for_restart = config.clone();
    let app = router(Arc::new(service)).with_state(AppState::new(
        config,
        Arc::new(HostAuthority::new(None, None, None)),
        CancellationToken::new(),
    ));
    let before = state::read(&options).unwrap();
    assert!(
        semantics::validate(
            &root,
            before.value["snapshot"]["scenes"].as_array().unwrap()
        )
        .is_empty()
    );
    let mut edited = before.value["snapshot"]["scenes"][0].clone();
    edited["title"] = "Neutral library revision".into();
    async fn call(app: &axum::Router, body: Value, peer: &str) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method("POST")
            .uri("/api/maintenance/scenes/changes")
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        request
            .extensions_mut()
            .insert(ConnectInfo(peer.parse::<std::net::SocketAddr>().unwrap()));
        let response = app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap())
    }
    let body = json!({"baseVersion":before.value["version"],"changeSet":{"version":1,"scenes":{"upsert":[edited],"remove":[]}}});
    assert_eq!(
        call(&app, body.clone(), "203.0.113.1:1234").await.0,
        StatusCode::FORBIDDEN
    );
    let (status, saved) = call(&app, body.clone(), "127.0.0.1:1234").await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(
        saved["snapshot"]["scenes"][0]["title"],
        "Neutral library revision"
    );
    assert_eq!(journal::inspect(&options)["status"], "free");
    assert_eq!(
        call(&app, body, "127.0.0.1:1234").await.0,
        StatusCode::CONFLICT
    );
    let mut decoded = Vec::new();
    flate2::read::GzDecoder::new(std::fs::File::open(root.join("data/scenes.json.gz")).unwrap())
        .read_to_end(&mut decoded)
        .unwrap();
    assert_eq!(
        decoded,
        std::fs::read(root.join("data/scenes.json")).unwrap()
    );
    let version = state::version(&root).unwrap();
    let raw = std::fs::read(root.join("data/scenes/nene-core.json")).unwrap();
    let compressed = std::fs::read(root.join("data/scenes.json.gz")).unwrap();
    edited["story"] = "Short".into();
    let (status,rejected)=call(&app,json!({"baseVersion":version,"changeSet":{"version":1,"scenes":{"upsert":[edited],"remove":[]}}}),"127.0.0.1:1234").await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{rejected}");
    assert_eq!(rejected["rolledBack"], true);
    assert_eq!(rejected["dataIntegrity"], "restored");
    assert_eq!(version, state::version(&root).unwrap());
    assert_eq!(
        raw,
        std::fs::read(root.join("data/scenes/nene-core.json")).unwrap()
    );
    assert_eq!(
        compressed,
        std::fs::read(root.join("data/scenes.json.gz")).unwrap()
    );
    assert_eq!(journal::inspect(&options)["status"], "free");
    // A captured rendered request survives the real HTTP transaction without editorial rewrites.
    let mut captured = before.value["snapshot"]["scenes"][0].clone();
    captured["id"] = "sc305".into();
    captured["title"] = "My image".into();
    captured["story"] = "窗边阅读".into();
    captured["storyJa"] = "".into();
    captured["prompt"] = "A woman reading beside a window.\n  Soft light.".into();
    captured["negative"] = "".into();
    captured["rating"] = "R15".into();
    captured["generatedRecipe"] = json!({"version":1,"engine":"krea2","prompt":captured["prompt"],"negative":"","parameters":{"seed":123,"steps":"20","cfg":"6","size":"768×1024","loras":[]}});
    let payload = |scene: &Value| json!({"baseVersion":state::version(&root).unwrap(),"changeSet":{"version":1,"scenes":{"upsert":[scene],"remove":[]}}});
    let (status, captured_saved) = call(&app, payload(&captured), "127.0.0.1:1234").await;
    assert_eq!(status, StatusCode::OK, "{captured_saved}");
    let stored = captured_saved["snapshot"]["scenes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == "sc305")
        .unwrap();
    assert_eq!(stored["prompt"], captured["prompt"]);
    assert_eq!(stored["generatedRecipe"], captured["generatedRecipe"]);
    assert_eq!(stored["negative"], "");
    assert_eq!(
        stored["rating"], "R15",
        "an explicit conservative rating is never lowered"
    );
    let version = state::version(&root).unwrap();
    for field in ["version", "parameters", "prompt"] {
        let mut invalid = captured.clone();
        invalid["generatedRecipe"][field] = match field {
            "version" => json!(2),
            "parameters" => json!({"arbitrary":{"nested":true}}),
            _ => json!("different prompt"),
        };
        let (status, rejected) = call(&app, payload(&invalid), "127.0.0.1:1234").await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{rejected}");
        assert_eq!(version, state::version(&root).unwrap());
    }
    captured["id"] = "sc306".into();
    captured["rating"] = "All".into();
    captured["prompt"] = "1girl, nude".into();
    captured["generatedRecipe"]["prompt"] = captured["prompt"].clone();
    let (status, elevated) = call(&app, payload(&captured), "127.0.0.1:1234").await;
    assert_eq!(status, StatusCode::OK, "{elevated}");
    let elevated = elevated["snapshot"]["scenes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == "sc306")
        .unwrap();
    assert_ne!(elevated["rating"], "All");
    assert_eq!(elevated["prompt"], captured["prompt"]);
    for task in ["validate", "classify", "optimize"] {
        let result =
            super::super::commands::run(&options, &json!({"task":task}), &CancellationToken::new())
                .unwrap();
        assert_eq!(result["exitCode"], 0);
    }
    let current = state::read(&options).unwrap();
    let mut blueprint = current.value["snapshot"]["blueprints"][0].clone();
    blueprint["title"] = "Neutral title revision".into();
    let(status,blueprint_saved)=call(&app,json!({"baseVersion":current.value["version"],"changeSet":{"version":1,"scenes":{"upsert":[],"remove":[]},"blueprints":{"upsert":[blueprint],"remove":[]}}}),"127.0.0.1:1234").await;
    assert_eq!(status, StatusCode::OK, "{blueprint_saved}");
    assert_eq!(blueprint_saved["blueprintCount"], 20);
    let version = state::version(&root).unwrap();
    let raw = std::fs::read(root.join("data/blueprints/fixture.json")).unwrap();
    blueprint["promptProse"] = "ayachi_nene in a neutral room".into();
    let(status,failed)=call(&app,json!({"baseVersion":version,"changeSet":{"version":1,"scenes":{"upsert":[],"remove":[]},"blueprints":{"upsert":[blueprint],"remove":[]}}}),"127.0.0.1:1234").await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{failed}");
    assert_eq!(failed["stage"], "validate-content-contracts");
    assert_eq!(failed["rolledBack"], true);
    assert_eq!(version, state::version(&root).unwrap());
    assert_eq!(
        raw,
        std::fs::read(root.join("data/blueprints/fixture.json")).unwrap()
    );
    assert_eq!(journal::inspect(&options)["status"], "free");
    for engine in ["krea2", "anima"] {
        let current = state::read(&options).unwrap();
        let mut generated = current.value["snapshot"]["blueprints"][0].clone();
        generated["id"] = format!("captured-{engine}").into();
        generated["title"] = "My captured room".into();
        generated["description"] = "阅读".into();
        generated["sampleRating"] = "All".into();
        generated["adult"] = false.into();
        generated["compositionIntent"] = "single".into();
        generated["promptTokens"] = if engine == "krea2" {
            json!([])
        } else {
            json!(["A quiet room."])
        };
        generated["promptProse"] = if engine == "krea2" {
            "A quiet room."
        } else {
            ""
        }
        .into();
        generated["negativeTokens"] = json!([]);
        generated["generatedRecipe"] = json!({"version":1,"engine":engine,"prompt":"A quiet room.","negative":"","parameters":{"size":"1024x1024"}});
        let body = json!({"baseVersion":current.value["version"],"changeSet":{"version":1,"scenes":{"upsert":[],"remove":[]},"blueprints":{"upsert":[generated],"remove":[]}}});
        let (status, saved) = call(&app, body, "127.0.0.1:1234").await;
        assert_eq!(status, StatusCode::OK, "{saved}");
        let stored = saved["snapshot"]["blueprints"]
            .as_array()
            .unwrap()
            .iter()
            .find(|b| b["id"] == generated["id"])
            .unwrap();
        assert_eq!(stored["generatedRecipe"], generated["generatedRecipe"]);
        assert_eq!(stored["promptTokens"], generated["promptTokens"]);
        assert_eq!(stored["promptProse"], generated["promptProse"]);
        let saved_version = saved["version"].clone();
        if engine == "krea2" {
            generated["promptTokens"] = json!(["a different scene"]);
        } else {
            generated["promptProse"] = "A different scene.".into();
        }
        let invalid = json!({"baseVersion":saved_version,"changeSet":{"version":1,"scenes":{"upsert":[],"remove":[]},"blueprints":{"upsert":[generated],"remove":[]}}});
        let (status, rejected) = call(&app, invalid, "127.0.0.1:1234").await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{rejected}");
        assert_eq!(
            state::version(&root).unwrap(),
            saved_version.as_u64().unwrap()
        );
    }
    if packaged {
        assert_eq!(
            bundled,
            std::fs::read(package_root.join("data/scenes/nene-core.json")).unwrap()
        );
        let saved = std::fs::read(root.join("data/scenes/nene-core.json")).unwrap();
        assert_ne!(saved, bundled);
        // Restart and package upgrades must never replace local edits.
        config_for_restart.prepare_content_for(true).unwrap();
        assert_eq!(
            saved,
            std::fs::read(root.join("data/scenes/nene-core.json")).unwrap()
        );
    }
}
