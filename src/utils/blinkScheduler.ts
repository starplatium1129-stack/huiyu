/**
 * 眨眼调度器 —— 与渲染循环解耦的纯逻辑模块。
 *
 * 背景：pixi-live2d-display / wl-live2d 的 CubismEyeBlink 自动眨眼只在
 * "当前帧没有运动在更新"时运行（update() 里的 `if (!motionUpdated)`），
 * 而循环 Idle 运动永远占着队列，导致自动眨眼几乎从不触发；眼睛的开合
 * 完全取决于各 Idle 运动里作者手写的眼参数曲线。夏目模型的这些曲线
 * 左右眼（ParamEyeLOpen / ParamEyeLOpen2）经常不同步，出现持续数秒的
 * "单眼 Wink / 一只眼闭着"状态，且部分 Idle 完全没有眼曲线（长时间不眨眼）。
 *
 * 这里实现一个覆盖式眨眼：每个渲染帧向双眼参数写入同一个值（1=睁、
 * 0=闭），保证双眼永远同步；间隔随机（默认 2.5-5 秒），单次眨眼约 0.3 秒。
 * 值与写法对齐源工程 Live2DViewerEX 的 EyeBlink 控制器语义。
 */

export interface BlinkScheduler {
  /** 推进调度器并返回新值；deltaSeconds 为帧时长 */
  update(deltaSeconds: number): number
  /** 回到全睁状态并重新计时（角色切换/销毁时调用） */
  reset(): void
}

type BlinkPhase = 'open' | 'closing' | 'closed' | 'opening'

export function createBlinkScheduler(): BlinkScheduler {
  const minIntervalMs = 2500
  const maxIntervalMs = 5000
  const closingSeconds = 0.09
  const closedSeconds = 0.06
  const openingSeconds = 0.16

  let phase: BlinkPhase = 'open'
  let phaseElapsed = 0
  let timerMs = nextDelay()

  function nextDelay(): number {
    return minIntervalMs + Math.random() * (maxIntervalMs - minIntervalMs)
  }

  function valueFor(): number {
    switch (phase) {
      case 'open': return 1
      case 'closing': return 1 - Math.min(1, phaseElapsed / closingSeconds)
      case 'closed': return 0
      case 'opening': return Math.min(1, phaseElapsed / openingSeconds)
    }
  }

  function update(deltaSeconds: number): number {
    const dt = Math.min(0.25, Math.max(0, deltaSeconds))
    phaseElapsed += dt
    switch (phase) {
      case 'open':
        timerMs -= dt * 1000
        if (timerMs <= 0) {
          phase = 'closing'
          phaseElapsed = 0
        }
        break
      case 'closing':
        if (phaseElapsed >= closingSeconds) {
          phase = 'closed'
          phaseElapsed = 0
        }
        break
      case 'closed':
        if (phaseElapsed >= closedSeconds) {
          phase = 'opening'
          phaseElapsed = 0
        }
        break
      case 'opening':
        if (phaseElapsed >= openingSeconds) {
          phase = 'open'
          phaseElapsed = 0
          timerMs = nextDelay()
        }
        break
    }
    return valueFor()
  }

  function reset() {
    phase = 'open'
    phaseElapsed = 0
    timerMs = nextDelay()
  }

  return { update, reset }
}
