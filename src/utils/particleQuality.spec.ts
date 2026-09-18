import { describe, expect, it } from 'vitest'
import { createParticleQuality } from './particleQuality'

describe('009 particle quality hysteresis', () => {
  it('preserves full detail under healthy or isolated slow frames', () => {
    const quality = createParticleQuality()
    for (let i = 0; i < 1000; i++) quality.frame(i % 10 === 0 ? 35 : 16.67)
    expect(quality.scale).toBe(1)
  })
  it('retains the existing slow-frame trigger without falling below the lower bound', () => {
    const quality = createParticleQuality()
    for (let i = 0; i < 19; i++) expect(quality.frame(35)).toBe(false)
    expect(quality.frame(35)).toBe(true); expect(quality.scale).toBe(.7)
    for (let i = 0; i < 1000; i++) quality.frame(35)
    expect(quality.scale).toBe(.48)
  })
  it('recovers only after sustained healthy visible time and eventually restores full detail', () => {
    const quality = createParticleQuality()
    for (let i = 0; i < 20; i++) quality.frame(35)
    for (let i = 0; i < 299; i++) quality.frame(16.67)
    expect(quality.scale).toBe(.7)
    quality.frame(16.67); expect(quality.scale).toBe(1)
  })
  it('does not oscillate when load alternates around the recovery threshold', () => {
    const quality = createParticleQuality()
    for (let i = 0; i < 20; i++) quality.frame(35)
    for (let i = 0; i < 2000; i++) quality.frame(i % 2 ? 21 : 16)
    expect(quality.scale).toBe(.7)
  })
  it('never counts hidden time or stale frame history towards recovery', () => {
    const quality = createParticleQuality()
    for (let i = 0; i < 20; i++) quality.frame(35)
    for (let i = 0; i < 200; i++) quality.frame(16.67)
    quality.resetHistory()
    expect(quality.frame(60000)).toBe(false)
    for (let i = 0; i < 200; i++) quality.frame(16.67)
    expect(quality.scale).toBe(.7)
    for (let i = 0; i < 100; i++) quality.frame(16.67)
    expect(quality.scale).toBe(1)
  })
  it('ignores invalid elapsed samples without changing the presentation tier', () => {
    const quality = createParticleQuality()
    for (const elapsed of [0, -1, NaN, Infinity]) expect(quality.frame(elapsed)).toBe(false)
    expect(quality.scale).toBe(1)
  })
})
