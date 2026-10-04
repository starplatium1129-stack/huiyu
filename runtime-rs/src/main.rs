use axum::serve::ListenerExt;
use huiyu_runtime::{AppState, config::Config, host::HostAuthority, storage::Storage};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if let Some(result) = huiyu_runtime::catalog::cli(&args)? {
        println!("{}", serde_json::to_string_pretty(&result)?);
        return Ok(());
    }
    if let Some(result) = huiyu_runtime::resources::offline::cli(&args).await? {
        println!("{}", serde_json::to_string_pretty(&result)?);
        return Ok(());
    }
    if let Some(result) = huiyu_runtime::maintenance::cli::run(&args)? {
        println!("{}", serde_json::to_string_pretty(&result)?);
        if result.get("executable") == Some(&serde_json::Value::Bool(false))
            || result.get("ok") == Some(&serde_json::Value::Bool(false))
        {
            std::process::exit(1);
        }
        return Ok(());
    }
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!(
            "huiyu-runtime --app-root <path> [--bind 127.0.0.1:3000]\n  [--workspace-root <absolute-private-path> --workspace-id <id> [--create-workspace]]\nDesktop session: AICS_DESKTOP_GATEWAY_TOKEN + AICS_DESKTOP_SOURCE_PROFILE_ID.\nMaintenance recovery: huiyu-runtime maintenance-recovery --help\nOffline import: huiyu-runtime offline-import --help"
        );
        return Ok(());
    }
    let mut config = Config::from_env()?;
    let _offline_session = huiyu_runtime::resources::offline::gateway_guard(&config)?;
    config.prepare_content()?;
    let shutdown = CancellationToken::new();
    let signal = shutdown.clone();
    let signal_task = tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            signal.cancel();
        }
    });
    let prepare_config = config.clone();
    let prepare_cancel = shutdown.clone();
    if let Err(error) = tokio::task::spawn_blocking(move || {
        huiyu_runtime::bootstrap::ensure(&prepare_config, &prepare_cancel)
    })
    .await?
    {
        // Source-mode startup retains the Node warning/degraded behavior. An
        // unresolved maintenance journal still blocks data reads in the router.
        eprintln!(
            "Data preparation incomplete ({}): {}",
            error.code, error.message
        );
    }
    if shutdown.is_cancelled() {
        signal_task.abort();
        return Ok(());
    }
    let catalog_options = huiyu_runtime::catalog::Options::from_config(&config);
    tokio::task::spawn_blocking(move || {
        huiyu_runtime::catalog::Catalog::open(catalog_options).map(|_| ())
    })
    .await??;
    let listener = tokio::net::TcpListener::bind(config.bind).await?;
    config.bind = listener.local_addr()?;
    config.gateway_origin = format!("http://{}", config.bind);
    let storage = match (&config.workspace_root, &config.workspace_id) {
        (Some(root), Some(id)) => Some(
            Storage::open(root.clone(), id.clone(), config.create_workspace)
                .await?
                .with_native_images(huiyu_runtime::native_images::library_path(&config)),
        ),
        _ => None,
    };
    let host = Arc::new(HostAuthority::new(
        storage,
        config.workspace_pointer.clone(),
        config.workspace_candidate.clone(),
    ));
    let voice = Arc::new(huiyu_runtime::voice::VoiceService::new(
        &config,
        shutdown.clone(),
    ));
    let model_config = huiyu_runtime::generation::Config {
        sd_host: config.sd_host.clone(),
        sd_auth: config.sd_auth.clone(),
        comfy_host: config.comfy_host.clone(),
        ai_workspace_root: config.ai_workspace_root.clone(),
        runtime_root: config.runtime_root.clone(),
    };
    let transport = huiyu_runtime::upstream::LocalUpstream::new();
    let generation = Arc::new(huiyu_runtime::generation::GenerationService::new(
        model_config.clone(),
        transport.clone(),
        shutdown.clone(),
    )?);
    let images = Arc::new(huiyu_runtime::images::ImageService::new(
        model_config.clone(),
        transport.clone(),
        shutdown.clone(),
    )?);
    let video = Arc::new(huiyu_runtime::video::VideoService::new(
        model_config,
        transport,
        shutdown.clone(),
    )?);
    let tasks = Arc::new(huiyu_runtime::task_runtime::TaskRuntime::new(
        generation.clone(),
        Some(images.clone()),
        Some(video.clone()),
        shutdown.clone(),
    )?);
    let mut state = AppState::new(Arc::new(config), host, shutdown.clone());
    state.chat = Some(Arc::new(huiyu_runtime::chat::ChatService::new()));
    state.voice = Some(voice.clone());
    state.generation = Some(generation);
    state.tasks = Some(tasks.clone());
    state.images = Some(images);
    state.video = Some(video);
    state.live2d = Some(Arc::new(huiyu_runtime::live2d::Live2dService::new(
        &state.config,
        shutdown.clone(),
    )));
    state.desktop_tools = Some(Arc::new(
        huiyu_runtime::desktop_tools::DesktopToolsService::new(&state.config, shutdown.clone()),
    ));
    state.maintenance = Some(Arc::new(
        huiyu_runtime::maintenance::MaintenanceService::new(&state.config),
    ));
    state.interrogate = Some(Arc::new(
        huiyu_runtime::interrogate::InterrogateService::new(&state.config, shutdown.clone()),
    ));
    state.remote = Some(Arc::new(huiyu_runtime::remote_content::RemoteAccess::new(
        &state.config,
        shutdown.clone(),
    )));
    state.resources = Some(Arc::new(huiyu_runtime::resources::Service::new(
        &state.config,
        shutdown.clone(),
    )?));
    state.control = Some(huiyu_runtime::control::ControlService::new(
        state.config.clone(),
        state.remote.as_ref().unwrap().clone(),
        shutdown.clone(),
        voice.clone(),
    ));
    let app = huiyu_runtime::router(state.clone());
    println!(
        "{}",
        serde_json::json!({"event":"ready","origin":state.config.gateway_origin,"runtime":"rust","candidate":true})
    );
    let signal = shutdown.clone();
    let host = state.host.clone();
    // Interactive JSON and token streams must not wait for Nagle's batch timer.
    let listener = listener.tap_io(|stream| {
        if let Err(error) = stream.set_nodelay(true) {
            eprintln!("TCP_NODELAY: {error}");
        }
    });
    let served = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        signal.cancelled().await;
        host.drain().await;
    })
    .await;
    voice.close().await;
    if let Some(service) = &state.live2d {
        service.close().await;
    }
    if let Some(tools) = &state.desktop_tools {
        tools.close().await;
    }
    tasks.close().await;
    if let Some(service) = &state.interrogate {
        service.close().await;
    }
    if let Some(service) = &state.resources {
        service.close().await;
    }
    if let Some(service) = &state.control {
        service.close().await;
    }
    if let Some(storage) = state.host.storage() {
        storage.close().await?;
    }
    signal_task.abort();
    served?;
    Ok(())
}
