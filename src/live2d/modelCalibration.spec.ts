import { describe, expect, it } from 'vitest'
import { buildCalibratedProfile, calibratedBinding, calibrationValue } from './modelCalibration'
import { validateAdapterProfile } from './adapterProfile'

const parameters = [{ id: 'Mouth', min: -2, max: 2, default: 1 }, { id: 'Eye', min: -1, max: 3, default: 3 }]
const mouth = { id: 'Mouth', closed: 1, open: -1 }
describe('calibration endpoints and ownership', () => {
  it('preserves inverted authored ranges and clamps only the normalized input', () => {
    expect(calibrationValue(mouth, 0)).toBe(1)
    expect(calibrationValue(mouth, 0.5)).toBe(0)
    expect(calibrationValue(mouth, 9)).toBe(-1)
    const profile = buildCalibratedProfile('fixture', parameters, mouth, [{ id: 'Eye', closed: -1, open: 3 }])
    expect(profile.parameterBindings.mouth).toMatchObject({ closed: 1, open: -1, range: [-2,2] })
    expect(profile.verification.status).toBe('needs-confirmation')
    expect(profile.backendCompatibility).toEqual(['browser'])
  })
  it('rejects invented parameters, invalid ranges, non-finite values and cross-channel conflicts', () => {
    expect(() => calibratedBinding({ ...mouth, id: 'missing' }, parameters)).toThrow()
    expect(() => calibratedBinding(mouth, [{ ...parameters[0]!, min: Infinity }])).toThrow()
    expect(() => calibratedBinding({ ...mouth, open: 5 }, parameters)).toThrow()
    expect(() => calibrationValue(mouth, NaN)).toThrow()
    expect(() => buildCalibratedProfile('fixture', parameters, mouth, [mouth])).toThrow('重复')
  })
  it('does not mutate the prior profile and never accepts malformed calibration containers', () => {
    const previous = buildCalibratedProfile('fixture', parameters, mouth, [])
    const snapshot = structuredClone(previous)
    buildCalibratedProfile('fixture', parameters, { ...mouth, open: 2 }, [], previous)
    expect(previous).toEqual(snapshot)
    for (const value of [5, [], { Eye: null }, { Eye: { closed: 0, open: NaN, range: [0,1] } }]) {
      const candidate = { ...previous, parameterBindings: { blink: ['Eye'], blinkCalibration: value } }
      expect(validateAdapterProfile(candidate).valid).toBe(false)
    }
    expect(validateAdapterProfile({ ...previous, backendCompatibility: {}, parameterBindings: { mouth: previous.parameterBindings.mouth } }).valid).toBe(false)
  })
})
