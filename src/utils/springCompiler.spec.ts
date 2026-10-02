import { describe, expect, it } from 'vitest'
import { compileSpring, sampleSpring, BAKED_SPRINGS } from './springCompiler'

describe('springCompiler (Spring-to-Linear-Easing)', () => {
  it('generates valid CSS linear(...) format starting at 0 and ending at 1', () => {
    const compiled = compileSpring('bouncy')
    expect(compiled.easing).toMatch(/^linear\(0, .+ 1\)$/)
    expect(compiled.duration).toBeGreaterThan(200)
    expect(compiled.duration).toBeLessThan(2000)

    expect(compiled.style['--spring-ease']).toBe(compiled.easing)
    expect(compiled.style['--spring-duration']).toBe(`${compiled.duration}ms`)
  })

  it('captures physical overshoot (value > 1) for bouncy and wobbly presets', () => {
    const bouncy = compileSpring('bouncy')
    const wobbly = compileSpring('wobbly')

    // 检查 linear 内部是否存在 > 1.0 的过冲采样点
    const hasBouncyOvershoot = bouncy.easing.split(',').some(part => {
      const val = parseFloat(part.trim().split(' ')[0])
      return val > 1.01
    })
    expect(hasBouncyOvershoot).toBe(true)

    const hasWobblyOvershoot = wobbly.easing.split(',').some(part => {
      const val = parseFloat(part.trim().split(' ')[0])
      return val > 1.05
    })
    expect(hasWobblyOvershoot).toBe(true)
  })

  it('produces snappy response with shorter settling duration', () => {
    const snappy = compileSpring('snappy')
    const gentle = compileSpring('gentle')

    expect(snappy.duration).toBeLessThan(gentle.duration)
  })

  it('supports custom spring physics parameters', () => {
    const custom = compileSpring({
      stiffness: 400,
      damping: 30,
      mass: 0.8,
    })

    expect(custom.easing.startsWith('linear(')).toBe(true)
    expect(custom.duration).toBeGreaterThan(100)
  })

  it('exposes the analytic sample used by the compiler', () => {
    const start = sampleSpring('gentle', 0)
    const end = sampleSpring('gentle', BAKED_SPRINGS.gentle.duration / 1000)
    expect(start.position).toBeCloseTo(0, 5)
    expect(start.velocity).toBeCloseTo(0, 5)
    expect(end.position).toBeCloseTo(1, 2)
    expect(Math.abs(end.velocity)).toBeLessThan(0.05)
  })

  it('rejects physically invalid configurations', () => {
    expect(() => compileSpring({ stiffness: 0 })).toThrow(/stiffness/)
    expect(() => compileSpring({ mass: -1 })).toThrow(/mass/)
    expect(() => compileSpring({ damping: -1 })).toThrow(/damping/)
    expect(() => compileSpring({ precision: 0 })).toThrow(/precision/)
    expect(() => sampleSpring('gentle', -1)).toThrow(/elapsedSeconds/)
  })
})
