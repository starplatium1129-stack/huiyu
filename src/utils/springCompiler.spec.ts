import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compileSpring, sampleSpring, BAKED_SPRINGS, SPRING_PRESETS } from './springCompiler'

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

  it('pre-bakes global presets in BAKED_SPRINGS', () => {
    for (const name of Object.keys(SPRING_PRESETS) as (keyof typeof SPRING_PRESETS)[]) {
      expect(BAKED_SPRINGS[name]).toBeDefined()
      expect(BAKED_SPRINGS[name].easing).toContain('linear(')
      expect(BAKED_SPRINGS[name].duration).toBeGreaterThan(0)
      expect(BAKED_SPRINGS[name].easing.length).toBeLessThan(1000)
    }
  })

  it('keeps the baked CSS tokens in sync with the compiler', () => {
    const css = readFileSync('src/assets/css/design-system.css', 'utf8')
    const sceneCardCss = readFileSync('src/assets/css/scene-card.css', 'utf8')

    expect(css).toContain(`--spring-bouncy-duration: ${BAKED_SPRINGS.bouncy.duration}ms`)
    expect(css).toContain(`--spring-gentle-duration: ${BAKED_SPRINGS.gentle.duration}ms`)
    expect(css).toContain('--spring-bouncy-ease: var(--spring-bounce)')
    expect(css).toContain('--spring-gentle-ease: linear(')
    expect(sceneCardCss).toContain('var(--spring-gentle-duration) var(--spring-gentle-ease)')
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
