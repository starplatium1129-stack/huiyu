
/// 覆盖式眨眼状态机（2026-08-16 眼睛灰修复，对齐浏览器 blinkScheduler）：
/// 夏目作者 Idle 眼曲线长期闭/半闭且左右眼不同步（ParamEyeLOpen /
/// ParamEyeLOpen2 长时间一闭一睁），native 此前无任何参数覆写，眼睛在
/// Idle 下灰暗无神（用户反馈：常态眼睛发灰、点互动动作时正常、回 idle 又灰）。
/// 每帧把双眼参数写同一值（1=睁、0=闭），间隔随机 2.5-5s、单次眨眼约
/// 0.31s（closing 0.09s / closed 0.06s / opening 0.16s），与前端
/// `blinkScheduler.ts` 完全同参。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum BlinkPhase {
    Open,
    Closing,
    Closed,
    Opening,
}

#[derive(Clone, Copy, Debug)]
pub(super) struct BlinkState {
    pub(super) phase: BlinkPhase,
    pub(super) phase_elapsed: f32,
    pub(super) timer_ms: f32,
    pub(super) seed: u64,
}

impl BlinkState {
    const CLOSING_S: f32 = 0.09;
    const CLOSED_S: f32 = 0.06;
    const OPENING_S: f32 = 0.16;
    const MIN_INTERVAL_MS: f32 = 2500.0;
    const MAX_INTERVAL_MS: f32 = 5000.0;

    pub(super) fn new() -> Self {
        let mut state = Self {
            phase: BlinkPhase::Open,
            phase_elapsed: 0.0,
            timer_ms: 0.0,
            seed: 0x9E37_79B9_7F4A_7C15 ^ u64::from(std::process::id()) ^ 0x0DDB_1A5E_5BAD_5EED,
        };
        state.timer_ms = state.next_delay();
        state
    }

    /// xorshift32 风格随机（复用渲染线程 motion_seed 的同款 RNG）。
    pub(super) fn next_random(&mut self) -> f32 {
        self.seed ^= self.seed << 13;
        self.seed ^= self.seed >> 7;
        self.seed ^= self.seed << 17;
        (self.seed & 0xFFFF) as f32 / 65536.0
    }

    pub(super) fn next_delay(&mut self) -> f32 {
        Self::MIN_INTERVAL_MS + self.next_random() * (Self::MAX_INTERVAL_MS - Self::MIN_INTERVAL_MS)
    }

    pub(super) fn value(&self) -> f32 {
        match self.phase {
            BlinkPhase::Open => 1.0,
            BlinkPhase::Closing => 1.0 - (self.phase_elapsed / Self::CLOSING_S).min(1.0),
            BlinkPhase::Closed => 0.0,
            BlinkPhase::Opening => (self.phase_elapsed / Self::OPENING_S).min(1.0),
        }
    }

    pub(super) fn update(&mut self, dt: f32) -> f32 {
        let dt = dt.clamp(0.0, 0.25);
        self.phase_elapsed += dt;
        match self.phase {
            BlinkPhase::Open => {
                self.timer_ms -= dt * 1000.0;
                if self.timer_ms <= 0.0 {
                    self.phase = BlinkPhase::Closing;
                    self.phase_elapsed = 0.0;
                }
            }
            BlinkPhase::Closing => {
                if self.phase_elapsed >= Self::CLOSING_S {
                    self.phase = BlinkPhase::Closed;
                    self.phase_elapsed = 0.0;
                }
            }
            BlinkPhase::Closed => {
                if self.phase_elapsed >= Self::CLOSED_S {
                    self.phase = BlinkPhase::Opening;
                    self.phase_elapsed = 0.0;
                }
            }
            BlinkPhase::Opening => {
                if self.phase_elapsed >= Self::OPENING_S {
                    self.phase = BlinkPhase::Open;
                    self.phase_elapsed = 0.0;
                    self.timer_ms = self.next_delay();
                }
            }
        }
        self.value()
    }
}
