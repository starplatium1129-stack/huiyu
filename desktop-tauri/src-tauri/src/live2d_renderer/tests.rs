    use super::{
        clear_model_state, followed_overlay_rect, selftest_adapter,
        reset_runtime_state, try_begin_startup, would_reject_interaction, ActiveMotion,
        BlinkPhase, BlinkState, Live2DOverlayState, MotionPhase, OverlayRect,
    };
    use live2d_native::model;

    #[test]
    fn mouth_intent_uses_character_specific_ranges() {
        assert_eq!(selftest_adapter("nene").mouth_value(1.0), Some(("ParamMouthOpenY", 1.0)));
        assert_eq!(selftest_adapter("natsume").mouth_value(1.0), Some(("ParamMouthForm3", -0.5)));
        assert_eq!(selftest_adapter("natsume").mouth_value(2.0), Some(("ParamMouthForm3", -0.5)));
    }

    #[test]
    fn blink_state_cycles_open_closed_and_returns_to_open() {
        // 覆盖式眨眼状态机：open 值恒 1；强制走完 closing→closed→opening 后
        // 回到 open，且任意时刻值在 [0,1]。间隔随机（2.5-5s）不在此验证。
        let mut blink = BlinkState::new();
        assert_eq!(blink.value(), 1.0);
        assert_eq!(blink.phase, BlinkPhase::Open);
        // 直接推进到 closing（把定时器清零）
        blink.timer_ms = 0.0;
        let mut value = blink.update(0.016);
        assert_eq!(blink.phase, BlinkPhase::Closing);
        assert!((value - 1.0).abs() < 1e-6 || (0.0..=1.0).contains(&value));
        // 走完 closing（0.09s）+ closed（0.06s）+ opening（0.16s）
        for _ in 0..40 {
            value = blink.update(0.016);
        }
        assert_eq!(blink.phase, BlinkPhase::Open);
        assert_eq!(value, 1.0);
        // 全程值域合法
        let mut min_v = f32::MAX;
        let mut max_v = f32::MIN;
        let mut probe = BlinkState::new();
        probe.timer_ms = 0.0;
        for _ in 0..200 {
            let v = probe.update(0.016);
            min_v = min_v.min(v);
            max_v = max_v.max(v);
        }
        assert!(min_v >= 0.0 && max_v <= 1.0, "blink value out of range: {min_v}..{max_v}");
    }

    #[test]
    fn blink_params_follow_frontend_mapping() {
        assert_eq!(selftest_adapter("natsume").blink, ["ParamEyeLOpen", "ParamEyeLOpen2"]);
        assert_eq!(selftest_adapter("nene").blink, ["ParamEyeLOpen", "ParamEyeROpen"]);
    }

    #[test]
    fn overlay_follows_companion_without_changing_size() {
        let current = OverlayRect { x: 120, y: 80, width: 300, height: 480 };
        let moved = followed_overlay_rect(current, 700, 400, (12, 24));
        assert_eq!(moved, OverlayRect { x: 712, y: 424, width: 300, height: 480 });
    }

    #[test]
    fn interaction_busy_rejects_only_same_group() {
        let active = ActiveMotion {
            handle: model::MotionHandle(1),
            phase: MotionPhase::Interaction,
            group: "TapHead".to_string(),
            index: 2,
            remaining_seconds: Some(3.0),
        };
        assert!(would_reject_interaction(Some(&active), "TapHead"));
        assert!(!would_reject_interaction(Some(&active), "TapSkirt"));
        assert!(!would_reject_interaction(None, "TapHead"));
        let idle = ActiveMotion {
            phase: MotionPhase::Idle,
            ..active
        };
        assert!(
            !would_reject_interaction(Some(&idle), "TapHead"),
            "idle 可被点击打断"
        );
    }

    #[test]
    fn startup_gate_allows_one_starter_and_restarts_after_cleanup() {
        let state = Live2DOverlayState::default();
        assert!(try_begin_startup(&state));
        assert!(!try_begin_startup(&state));

        state.window_ready.store(true, std::sync::atomic::Ordering::SeqCst);
        state.starting.store(false, std::sync::atomic::Ordering::SeqCst);
        assert!(!try_begin_startup(&state));

        reset_runtime_state(&state);
        assert!(try_begin_startup(&state));
    }

    #[test]
    fn runtime_reset_clears_all_ready_and_starting_flags() {
        let state = Live2DOverlayState::default();
        state.window_ready.store(true, std::sync::atomic::Ordering::SeqCst);
        state.renderer_attached.store(true, std::sync::atomic::Ordering::SeqCst);
        state.starting.store(true, std::sync::atomic::Ordering::SeqCst);
        state.visible.store(true, std::sync::atomic::Ordering::SeqCst);
        reset_runtime_state(&state);
        assert!(!state.window_ready.load(std::sync::atomic::Ordering::SeqCst));
        assert!(!state.renderer_attached.load(std::sync::atomic::Ordering::SeqCst));
        assert!(!state.starting.load(std::sync::atomic::Ordering::SeqCst));
        assert!(!state.visible.load(std::sync::atomic::Ordering::SeqCst));
        assert!(state.hwnd.lock().unwrap().is_none());
        assert!(state.cmd_tx.lock().unwrap().is_none());
    }

    #[test]
    fn destroy_clears_model_state_but_keeps_thread_for_reuse() {
        let state = Live2DOverlayState::default();
        // 模拟运行中的渲染线程：窗口与通道就绪、模型已加载。
        state.window_ready.store(true, std::sync::atomic::Ordering::SeqCst);
        state.renderer_attached.store(true, std::sync::atomic::Ordering::SeqCst);
        state.starting.store(false, std::sync::atomic::Ordering::SeqCst);
        let (tx, _rx) = std::sync::mpsc::channel::<super::OverlayCommand>();
        *state.cmd_tx.lock().unwrap() = Some(tx);
        *state.character.lock().unwrap() = Some("nene".to_string());
        state.model_ready.store(true, std::sync::atomic::Ordering::SeqCst);
        *state.model_bounds.lock().unwrap() = Some(OverlayRect { x: 1, y: 2, width: 3, height: 4 });
        state
            .last_mouth_level
            .store(0.8f32.to_bits(), std::sync::atomic::Ordering::SeqCst);

        clear_model_state(&state);

        // 模型级状态清空：destroy 契约（释放模型、可重新 setCharacter）。
        assert!(!state.model_ready.load(std::sync::atomic::Ordering::SeqCst));
        assert!(state.character.lock().unwrap().is_none());
        assert!(state.model_bounds.lock().unwrap().is_none());
        assert_eq!(
            f32::from_bits(state.last_mouth_level.load(std::sync::atomic::Ordering::SeqCst)),
            0.0
        );
        // 线程与窗口保持：长期复用，不触发 stopped/重建。
        assert!(state.window_ready.load(std::sync::atomic::Ordering::SeqCst));
        assert!(state.renderer_attached.load(std::sync::atomic::Ordering::SeqCst));
        assert!(state.cmd_tx.lock().unwrap().is_some());
    }
