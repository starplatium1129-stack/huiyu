use super::*;

pub(crate) fn selftest_adapter(character: &str) -> Live2DAdapterConfig {
    let natsume = character == "natsume";
    Live2DAdapterConfig {
        profile_id: format!("selftest-{character}"),
        mouth: Some(MouthBinding {
            id: if natsume { "ParamMouthForm3" } else { "ParamMouthOpenY" }.into(),
            scale: if natsume { -0.5 } else { 1.0 },
            range: None,
        }),
        blink: if natsume { vec!["ParamEyeLOpen".into(), "ParamEyeLOpen2".into()] }
            else { vec!["ParamEyeLOpen".into(), "ParamEyeROpen".into()] },
        focus: vec!["ParamAngleX".into(), "ParamAngleY".into(), "ParamEyeBallX".into(), "ParamEyeBallY".into()],
        emotion_params: HashMap::new(),
        overlay_settle: None,
        entrance_group: natsume.then(|| "Start".into()),
        leave_group: Some("Leave".into()),
    }
}

/// 启动 overlay 窗口 + 渲染线程（幂等）。
/// 渲染链路自测：无 Tauri 依赖，直接创建 overlay → 加载模型 → 渲染数帧 → 退出。
/// 供 LIVE2D_SELFTEST=1 环境变量驱动，验证窗口/wgpu/模型/渲染循环全链路。
pub fn selftest(assets_root: std::path::PathBuf) -> Result<(), String> {
    let state = Arc::new(Live2DOverlayState::default());
    state.starting.store(true, Ordering::SeqCst);
    let handle = state.clone();
    let worker = thread::spawn(move || overlay_window_thread(handle, RendererEnvironment { assets_root, local_root: None, events: None }));
    let _cleanup = SelftestCleanup { state: state.clone(), worker: Some(worker) };
    let deadline = Instant::now() + Duration::from_secs(15);
    while !state.window_ready.load(Ordering::SeqCst) {
        if Instant::now() > deadline {
            return Err("selftest: overlay window not ready within 15s".into());
        }
        thread::sleep(Duration::from_millis(50));
    }
    let tx = state
        .cmd_tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("selftest: no cmd channel")?;
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    tx.send(OverlayCommand::SetCharacter {
        character: "nene".to_string(),
        texture_scale: 1,
        adapter: selftest_adapter("nene"),
        reply: reply_tx,
    })
    .map_err(|e| format!("selftest: send set_character: {e}"))?;
    let reply = reply_rx
        .blocking_recv()
        .map_err(|e| format!("selftest: reply channel closed: {e}"))?;
    reply.map_err(|e| format!("selftest: set_character failed: {e}"))?;
    *state.rect.lock().unwrap() = OverlayRect {
        x: 200,
        y: 200,
        width: 800,
        height: 800,
    };
    state.visible.store(true, Ordering::SeqCst);

    let check = |label: &str, result: Result<Result<(), String>, String>| -> Result<(), String> {
        let inner = result.map_err(|e| format!("selftest: {label} channel error: {e}"))?;
        inner.map_err(|e| format!("selftest: {label} failed: {e}"))
    };

    let cmd = |c: OverlayCommand, timeout_ms: u64| -> Result<Result<(), String>, String> {
        let (r_tx, mut r_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
        let c = match c {
            OverlayCommand::SetCharacter { character, texture_scale, adapter, .. } => OverlayCommand::SetCharacter {
                character,
                texture_scale,
                adapter,
                reply: r_tx,
            },
            OverlayCommand::PlayMotion {
                group,
                index,
                priority,
                ..
            } => OverlayCommand::PlayMotion {
                group,
                index,
                priority,
                reply: r_tx,
            },
            OverlayCommand::Snapshot { path, .. } => OverlayCommand::Snapshot { path, reply: r_tx },
            _other => {
                return Err(format!("selftest: unsupported reply command"));
            }
        };
        let tx = state
            .cmd_tx
            .lock()
            .unwrap()
            .clone()
            .ok_or("selftest: no cmd channel")?;
        tx.send(c)
            .map_err(|e| format!("selftest: send failed: {e}"))?;
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            if let Ok(r) = r_rx.try_recv() {
                return Ok(r);
            }
            if Instant::now() > deadline {
                return Err("selftest: reply timeout".into());
            }
            thread::sleep(Duration::from_millis(20));
        }
    };

    let out_dir = std::env::var("LIVE2D_SNAPSHOT_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("."));

    check(
        "nene play_motion TapHead",
        cmd(
            OverlayCommand::PlayMotion {
                group: "TapHead".into(),
                index: Some(0),
                priority: Some("force".into()),
                reply: tokio::sync::oneshot::channel().0,
            },
            5000,
        ),
    )?;
    thread::sleep(Duration::from_millis(800));
    check(
        "nene snapshot",
        cmd(
            OverlayCommand::Snapshot {
                path: out_dir
                    .join("selftest-nene-motion.png")
                    .to_string_lossy()
                    .to_string(),
                reply: tokio::sync::oneshot::channel().0,
            },
            15000,
        ),
    )?;

    tx.send(OverlayCommand::SetMouthLevel(0.8))
        .map_err(|e| format!("selftest: send mouth: {e}"))?;
    tx.send(OverlayCommand::SetEmotion {
        name: "happy".into(),
        intensity: 1.0,
    })
    .map_err(|e| format!("selftest: send emotion: {e}"))?;
    thread::sleep(Duration::from_millis(500));
    check(
        "nene snapshot mouth+emotion",
        cmd(
            OverlayCommand::Snapshot {
                path: out_dir
                    .join("selftest-nene-mouth.png")
                    .to_string_lossy()
                    .to_string(),
                reply: tokio::sync::oneshot::channel().0,
            },
            15000,
        ),
    )?;

    // 点击点选在脸区中部（canvas y≈0.55，Face bbox y[0.441,0.625] 中心）。
    // 原 y=0.11 换算后 canvas y≈0.688，贴着 Head 区上缘（实测 bbox 到 0.687，
    // 差 0.001）——HitArea 顶点随动作相位微动，贴边坐标让断言随 TapHead
    // 姿势时好时坏（2026-08-23 实测空命中）。脸中心对动作相位不敏感。
    tx.send(OverlayCommand::HitTestAsync { x: 0.5, y: 0.20 })
        .map_err(|e| format!("selftest: send hit test: {e}"))?;
    thread::sleep(Duration::from_millis(300));
    let areas = state.hit_test_result.lock().unwrap().clone();
    match areas {
        Some(areas) if !areas.is_empty() => {
            println!("LIVE2D_SELFTEST_HITTEST areas={areas:?}");
        }
        Some(_) => {
            return Err("selftest: hit test returned empty areas (expected Face hit)".into())
        }
        None => return Err("selftest: hit test produced no result".into()),
    }

    check(
        "natsume set_character",
        cmd(
            OverlayCommand::SetCharacter {
                character: "natsume".into(),
                texture_scale: 1,
                adapter: selftest_adapter("natsume"),
                reply: tokio::sync::oneshot::channel().0,
            },
            120000,
        ),
    )?;
    check(
        "natsume play_motion Start",
        cmd(
            OverlayCommand::PlayMotion {
                group: "Start".into(),
                index: Some(0),
                priority: Some("force".into()),
                reply: tokio::sync::oneshot::channel().0,
            },
            5000,
        ),
    )?;
    thread::sleep(Duration::from_millis(800));
    check(
        "natsume snapshot",
        cmd(
            OverlayCommand::Snapshot {
                path: out_dir
                    .join("selftest-natsume.png")
                    .to_string_lossy()
                    .to_string(),
                reply: tokio::sync::oneshot::channel().0,
            },
            15000,
        ),
    )?;

    thread::sleep(Duration::from_secs(1));
    let frames = state.frame_count.load(Ordering::SeqCst);
    *state.cmd_tx.lock().unwrap() = None;
    if frames == 0 {
        return Err(format!(
            "selftest: no frames rendered (frame_count={frames})"
        ));
    }
    println!("LIVE2D_SELFTEST_OK frames={frames}");
    Ok(())
}

struct SelftestCleanup {
    state: Arc<Live2DOverlayState>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Drop for SelftestCleanup {
    fn drop(&mut self) {
        self.state.shutdown.store(true, Ordering::SeqCst);
        if let Some(sender) = self.state.cmd_tx.lock().unwrap().as_ref() {
            let _ = sender.send(OverlayCommand::Shutdown);
        }
        if let Some(worker) = self.worker.take() { let _ = worker.join(); }
    }
}
