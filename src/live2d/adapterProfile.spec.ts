import { describe, expect, it } from 'vitest'
import {
  NATSUME_BUILTIN_PROFILE,
  adapterCapabilityReport,
  compileAdapterProfile,
  validateAdapterProfile,
  type Live2DAdapterProfile,
} from './adapterProfile'

function fixtureProfile(overrides: Partial<Live2DAdapterProfile> = {}): Live2DAdapterProfile {
  return {
    schemaVersion: 1,
    profileId: 'fixture-profile',
    profileVersion: '1.0.0',
    avatarId: 'fixture-avatar',
    backendCompatibility: ['browser'],
    parameterBindings: {},
    verification: { status: 'needs-confirmation', reason: 'fixture mapping' },
    ...overrides,
  }
}

describe('Live2D adapter profile compilation', () => {
  it('keeps migrated built-ins pending until paired visual evidence exists', () => {
    const report = adapterCapabilityReport(NATSUME_BUILTIN_PROFILE, 'native')
    expect(report.status).toBe('needs-confirmation')
    expect(report.items.find(item => item.id === 'mouth')?.status).toBe('needs-confirmation')
    expect(report.items.find(item => item.id === 'overlay-reset')?.reason).toContain('叠层复位参数')
  })

  it('treats absent mouth and blink as understandable degradation, not an invalid profile', () => {
    const profile = fixtureProfile()
    expect(validateAdapterProfile(profile)).toEqual({ valid: true, errors: [] })
    const compiled = compileAdapterProfile(profile, 'browser')
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    expect(compiled.adapter.mouth).toBeUndefined()
    expect(compiled.adapter.blink).toEqual([])
    expect(compiled.adapter.report.items.find(item => item.id === 'mouth')).toMatchObject({
      status: 'unsupported',
    })
  })

  it('rejects a backend that the model profile does not declare', () => {
    const compiled = compileAdapterProfile(fixtureProfile(), 'native')
    expect(compiled.ok).toBe(false)
    if (compiled.ok) return
    expect(compiled.report.status).toBe('unsupported')
    expect(compiled.report.errors).toEqual([])
  })

  it('rejects unsafe or contradictory parameter mappings before runtime', () => {
    const profile = fixtureProfile({
      parameterBindings: { mouth: { id: '', scale: Number.NaN, range: [1, -1] } },
      overlaySettle: { settleMs: 0, resetDefaults: { ParamA: Number.POSITIVE_INFINITY } },
    })
    const result = validateAdapterProfile(profile)
    expect(result.valid).toBe(false)
    expect(result.errors).toEqual(expect.arrayContaining([
      'mouth parameter id must be a non-empty string',
      'mouth scale must be finite',
      'mouth range must be finite and ordered',
      'overlay settleMs must be positive',
      'overlay reset defaults must be finite',
    ]))
  })
})
