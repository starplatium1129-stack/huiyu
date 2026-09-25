/**
 * springCompiler.ts —— 弹簧物理编译为 CSS linear() 缓动。
 *
 * 解析解出阻尼谐振子的位移轨迹，再把轨迹压缩成浏览器原生 timing function。
 * 运行时不需要 requestAnimationFrame；调用方只需对 transform/opacity 使用生成的
 * transition。linear() 在不支持的浏览器上由 design-system.css 的 Bézier fallback 接管。
 */

export interface SpringConfig {
  /** 劲度，单位为 rad²/s²。 */
  stiffness?: number
  /** 阻尼，单位与劲度匹配；0 表示无阻尼。 */
  damping?: number
  /** 质量，必须大于 0。 */
  mass?: number
  /** 初始归一化速度（单位：目标距离/秒）。 */
  velocity?: number
  /** 位置/速度收敛阈值，默认 0.003。 */
  precision?: number
  /** 轨迹采样数，默认 96。 */
  sampleCount?: number
  /** linear() 最大 stop 数，默认 32；越少越省 CSS 体积。 */
  maxStops?: number
}

export interface CompiledSpring {
  /** 可直接放入 transition-timing-function 的 CSS linear() 字符串。 */
  easing: string
  /** 从 0 到 1 的物理收敛时间，单位毫秒。 */
  duration: number
  /** 便于绑定到元素 style 的 CSS 变量。 */
  style: {
    '--spring-ease': string
    '--spring-duration': string
  }
}

export interface SpringSample {
  position: number
  velocity: number
}

export type SpringPresetName = 'bouncy' | 'gentle' | 'snappy' | 'wobbly'

/** 画室用的四档物理手感；gentle 临界阻尼，bouncy/wobbly 保留动量过冲。 */
export const SPRING_PRESETS: Record<SpringPresetName, Required<SpringConfig>> = {
  bouncy: {
    stiffness: 320,
    damping: 20,
    mass: 1,
    velocity: 0,
    precision: 0.003,
    sampleCount: 96,
    maxStops: 24,
  },
  gentle: {
    stiffness: 300,
    damping: 2 * Math.sqrt(300),
    mass: 1,
    velocity: 0,
    precision: 0.003,
    sampleCount: 96,
    maxStops: 24,
  },
  snappy: {
    stiffness: 480,
    damping: 34,
    mass: 1,
    velocity: 0,
    precision: 0.003,
    sampleCount: 96,
    maxStops: 24,
  },
  wobbly: {
    stiffness: 240,
    damping: 14,
    mass: 1,
    velocity: 0,
    precision: 0.003,
    sampleCount: 96,
    maxStops: 24,
  },
}

type ResolvedConfig = Required<SpringConfig>
interface SamplePoint {
  t: number
  value: number
}

const MAX_SETTLE_SECONDS = 2.5
const MIN_SETTLE_SECONDS = 0.12

function resolveConfig(config: SpringConfig | SpringPresetName): ResolvedConfig {
  const base = typeof config === 'string' ? SPRING_PRESETS[config] : SPRING_PRESETS.bouncy
  const resolved = { ...base, ...(typeof config === 'string' ? {} : config) }
  const numeric = [resolved.stiffness, resolved.damping, resolved.mass, resolved.velocity, resolved.precision, resolved.sampleCount, resolved.maxStops]

  if (!numeric.every(Number.isFinite)) throw new TypeError('Spring parameters must be finite numbers')
  if (resolved.stiffness <= 0) throw new RangeError('Spring stiffness must be greater than 0')
  if (resolved.mass <= 0) throw new RangeError('Spring mass must be greater than 0')
  if (resolved.damping < 0) throw new RangeError('Spring damping cannot be negative')
  if (resolved.precision <= 0 || resolved.precision > 0.1) throw new RangeError('Spring precision must be between 0 and 0.1')
  if (resolved.sampleCount < 24 || resolved.sampleCount > 240) throw new RangeError('Spring sampleCount must be between 24 and 240')
  if (resolved.maxStops < 4 || resolved.maxStops > 96) throw new RangeError('Spring maxStops must be between 4 and 96')
  return resolved
}

/** 求归一化弹簧（0 → 1）在指定时间的解析位置与速度。 */
export function sampleSpring(config: SpringConfig | SpringPresetName, elapsedSeconds: number): SpringSample {
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) throw new RangeError('elapsedSeconds must be a non-negative finite number')
  const cfg = resolveConfig(config)
  return solveOscillator(elapsedSeconds, cfg)
}

function solveOscillator(t: number, cfg: ResolvedConfig): SpringSample {
  const { stiffness: k, damping: c, mass: m, velocity: v0 } = cfg
  const w0 = Math.sqrt(k / m)
  const zeta = c / (2 * Math.sqrt(k * m))

  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta)
    const gamma = zeta * w0
    const decay = Math.exp(-gamma * t)
    const cos = Math.cos(wd * t)
    const sin = Math.sin(wd * t)
    const x = decay * (-cos + ((v0 - gamma) / wd) * sin)
    return {
      position: 1 + x,
      velocity: -gamma * x + decay * ((v0 - gamma) * cos + sin * wd),
    }
  }

  if (Math.abs(zeta - 1) < 1e-7) {
    const decay = Math.exp(-w0 * t)
    const x = decay * (-1 + (v0 - w0) * t)
    return { position: 1 + x, velocity: -w0 * x + decay * (v0 - w0) }
  }

  const wd = w0 * Math.sqrt(zeta * zeta - 1)
  const r1 = -zeta * w0 + wd
  const r2 = -zeta * w0 - wd
  const c1 = (-r2 - v0) / (r1 - r2)
  const c2 = -1 - c1
  const e1 = Math.exp(r1 * t)
  const e2 = Math.exp(r2 * t)
  return { position: 1 + c1 * e1 + c2 * e2, velocity: c1 * r1 * e1 + c2 * r2 * e2 }
}

function findSettlingTime(cfg: ResolvedConfig): number {
  const dt = 1 / 120
  let time = 0
  let stableSamples = 0
  while (time < MAX_SETTLE_SECONDS) {
    const sample = solveOscillator(time, cfg)
    if (Math.abs(sample.position - 1) < cfg.precision && Math.abs(sample.velocity) < cfg.precision * 8) {
      stableSamples += 1
      if (stableSamples >= 6) return Math.max(MIN_SETTLE_SECONDS, time)
    } else {
      stableSamples = 0
    }
    time += dt
  }
  return MAX_SETTLE_SECONDS
}

/** Ramer–Douglas–Peucker 简化：误差以归一化位移衡量，不按屏幕像素猜测。 */
function simplifyPoints(points: SamplePoint[], tolerance: number): SamplePoint[] {
  if (points.length <= 2) return points
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack: Array<[number, number]> = [[0, points.length - 1]]

  while (stack.length) {
    const [first, last] = stack.pop()!
    const a = points[first]
    const b = points[last]
    const spanT = b.t - a.t || 1
    const spanValue = b.value - a.value
    let maxDistance = 0
    let maxIndex = -1

    for (let i = first + 1; i < last; i += 1) {
      const point = points[i]
      const interpolated = a.value + spanValue * ((point.t - a.t) / spanT)
      const distance = Math.abs(point.value - interpolated)
      if (distance > maxDistance) {
        maxDistance = distance
        maxIndex = i
      }
    }

    if (maxDistance > tolerance && maxIndex > 0) {
      keep[maxIndex] = 1
      stack.push([first, maxIndex], [maxIndex, last])
    }
  }

  return points.filter((_, index) => keep[index] === 1)
}

function limitStops(points: SamplePoint[], maxStops: number): SamplePoint[] {
  const reduced = points.slice()
  while (reduced.length > maxStops) {
    let removeIndex = 1
    let leastImportance = Number.POSITIVE_INFINITY
    for (let i = 1; i < reduced.length - 1; i += 1) {
      const previous = reduced[i - 1]
      const current = reduced[i]
      const next = reduced[i + 1]
      const span = next.t - previous.t || 1
      const interpolated = previous.value + (next.value - previous.value) * ((current.t - previous.t) / span)
      const importance = Math.abs(current.value - interpolated)
      if (importance < leastImportance) {
        leastImportance = importance
        removeIndex = i
      }
    }
    reduced.splice(removeIndex, 1)
  }
  return reduced
}

function formatNumber(value: number, digits = 4): string {
  const rounded = Number(value.toFixed(digits))
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

/** 编译为浏览器原生 timing function；默认起点 0、终点 1，允许物理过冲。 */
export function compileSpring(config: SpringConfig | SpringPresetName = 'bouncy'): CompiledSpring {
  const cfg = resolveConfig(config)
  const settleSeconds = findSettlingTime(cfg)
  const samples: SamplePoint[] = []

  for (let index = 0; index <= cfg.sampleCount; index += 1) {
    const t = index / cfg.sampleCount
    samples.push({ t, value: solveOscillator(t * settleSeconds, cfg).position })
  }
  samples[0].value = 0
  samples[samples.length - 1].value = 1

  const stops = limitStops(simplifyPoints(samples, Math.max(cfg.precision * 0.2, 0.0003)), cfg.maxStops)
  const parts = stops.map((point, index) => {
    if (index === 0) return '0'
    if (index === stops.length - 1) return '1'
    return `${formatNumber(point.value)} ${formatNumber(point.t * 100, 3)}%`
  })
  const easing = `linear(${parts.join(', ')})`
  const duration = Math.round(settleSeconds * 1000)

  return {
    easing,
    duration,
    style: {
      '--spring-ease': easing,
      '--spring-duration': `${duration}ms`,
    },
  }
}

/** 预烘焙常用档位；调用方直接复用结果，避免每次渲染重新解算。 */
export const BAKED_SPRINGS: Record<SpringPresetName, CompiledSpring> = {
  bouncy: compileSpring('bouncy'),
  gentle: compileSpring('gentle'),
  snappy: compileSpring('snappy'),
  wobbly: compileSpring('wobbly'),
}
