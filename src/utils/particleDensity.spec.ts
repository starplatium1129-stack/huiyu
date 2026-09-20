import { describe, expect, it } from 'vitest'
import { portraitAreaMultiplier, preferredParticleCount } from './particleDensity'
import { samplePortraitPoints, type PortraitCloud } from './particlePortrait'

const reference = { width: 500, height: 330 }
const settings = { density: 'ambient' as const, compact: false, lowMemory: false, reduceMotion: false, lowEffects: false, quality: 1, portraitAspect: 2 / 3, width: 500, height: 330 }
const cloud: PortraitCloud = { id: 'density-test', aspect: 2 / 3, palette: ['#777777'], grid: { w: 20, h: 30, cells: Array.from({ length: 600 }, (_, i) => i < 40 || i >= 560 || i % 20 < 2 || i % 20 > 17 ? '.' : '0').join('') } }

describe('portrait screen density', () => {
  it('quadruples points when both portrait dimensions double, preserving point spacing and radius', () => {
    const small = samplePortraitPoints(cloud, preferredParticleCount({ ...settings, reference }), 500, 330)
    const count = preferredParticleCount({ ...settings, reference, width: 1200, height: 660 })
    const large = samplePortraitPoints(cloud, count, 1200, 660)
    expect(count).toBe(24000)
    expect(large.spacing).toBeCloseTo(small.spacing, 6)
    expect(large.spacing * .3).toBeCloseTo(small.spacing * .3, 6)
    // Edge cells are rounded and transparent source cells are discarded.
    expect(large.points.length / small.points.length).toBeGreaterThan(3.8)
    expect(large.points.length / small.points.length).toBeLessThan(4.2)
  })
  it('ignores empty horizontal space and accounts for width-limited portraits', () => {
    expect(portraitAreaMultiplier(2 / 3, 1500, 330, reference)).toBe(1)
    expect(portraitAreaMultiplier(2 / 3, 110, 1000, reference)).toBeCloseTo(.25)
    expect(portraitAreaMultiplier(2 / 3, 0, 330, reference)).toBe(1)
  })
  it('keeps the reference spacing on narrow screens rather than applying a second point-count cut', () => {
    expect(preferredParticleCount({ ...settings, reference, compact: true, width: 350, height: 440 })).toBe(10667)
    expect(preferredParticleCount({ ...settings, compact: true })).toBe(2400)
    expect(preferredParticleCount({ ...settings })).toBe(6000)
    expect(preferredParticleCount({ ...settings, density: 'hero' })).toBe(8000)
  })
  it('retains explicit low-effects/static budgets and bounds exceptional displays', () => {
    expect(preferredParticleCount({ ...settings, reference, lowEffects: true })).toBe(3900)
    expect(preferredParticleCount({ ...settings, reference, quality: .48 })).toBe(6000)
    expect(preferredParticleCount({ ...settings, reference, reduceMotion: true, width: 1200, height: 660 })).toBe(1680)
    expect(preferredParticleCount({ ...settings, reduceMotion: true, quality: .48 })).toBe(420)
    expect(preferredParticleCount({ ...settings, reference, width: 8000, height: 8000 })).toBe(48000)
  })
})
