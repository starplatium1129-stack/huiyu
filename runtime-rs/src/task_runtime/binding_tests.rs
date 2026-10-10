use super::*;
use crate::{generation::Config, upstream::LocalUpstream};

fn runtime(config: Config) -> TaskRuntime {
    let shutdown = CancellationToken::new();
    let provider = Arc::new(
        GenerationService::new(config.clone(), LocalUpstream::new(), shutdown.clone()).unwrap(),
    );
    let images = Arc::new(
        crate::images::ImageService::new(config, LocalUpstream::new(), shutdown.clone()).unwrap(),
    );
    TaskRuntime::new(provider, Some(images), None, shutdown).unwrap()
}

#[tokio::test]
async fn native_image_binding_survives_restart_and_unrelated_comfy_changes() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path();
    let mut config = Config {
        sd_host: "http://127.0.0.1:1".into(),
        sd_auth: None,
        comfy_host: "http://127.0.0.1:2".into(),
        ai_workspace_root: root.join("AI"),
        runtime_root: root.join("runtime"),
    };
    std::fs::create_dir_all(&config.runtime_root).unwrap();
    let mut settings = crate::generation::native::load(&config).unwrap();
    settings.engine = "native".into();
    let save = |settings: &crate::generation::native::Settings| {
        std::fs::write(
            config.runtime_root.join("config.json"),
            serde_json::to_vec(&json!({"inference":settings})).unwrap(),
        )
        .unwrap();
    };
    save(&settings);
    // No Comfy installation, Python, models, process launches or SQLite access.
    let first = runtime(config.clone());
    let native = first.binding_for(TaskKind::Anima);
    assert_eq!(native, first.binding_for(TaskKind::Creative));
    let restarted = runtime(config.clone());
    assert_eq!(native, restarted.binding_for(TaskKind::Anima));
    // The unrelated generic provider retains its unbound-epoch protection.
    assert_ne!(first.binding(), restarted.binding());
    for kind in [TaskKind::Generation, TaskKind::Video, TaskKind::Batch] {
        assert_eq!(first.binding_for(kind), first.binding());
    }
    std::fs::create_dir_all(config.ai_workspace_root.join("ComfyUI")).unwrap();
    config.comfy_host = "http://127.0.0.1:3".into();
    config.sd_host = "http://127.0.0.1:4".into();
    let unrelated_changed = runtime(config.clone());
    assert_eq!(native, unrelated_changed.binding_for(TaskKind::Anima));
    assert_ne!(restarted.binding(), unrelated_changed.binding());
    settings.models_root = root.join("replacement-models");
    save(&settings);
    assert_eq!(native, first.binding_for(TaskKind::Anima));
    let native_changed = runtime(config);
    assert_ne!(native, native_changed.binding_for(TaskKind::Anima));
    first.close().await;
    restarted.close().await;
    unrelated_changed.close().await;
    native_changed.close().await;
}
