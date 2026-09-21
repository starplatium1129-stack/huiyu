import { describe, expect, it, vi } from 'vitest'
import { enumerateModelParameters } from './modelParameters'
const parameters = () => ({ count: 1, ids: ['CustomMouth'], minimumValues: new Float32Array([-2]), maximumValues: new Float32Array([2]), defaultValues: new Float32Array([1]), values: new Float32Array([0.5]) })
describe('real model parameter snapshots', () => {
  it('supports Core wrappers and returns independent snapshots without lookup side effects', () => {
    const data = parameters(), lookup = vi.fn()
    for (const core of [{ getModel: () => ({ parameters: data }) }, { _model: { parameters: data } }, { parameters: data, getParameterIndex: lookup }]) {
      expect(enumerateModelParameters(core)).toEqual({ supported: true, parameters: [{ id: 'CustomMouth', index: 0, minimum: -2, maximum: 2, defaultValue: 1, value: 0.5 }] })
    }
    expect(lookup).not.toHaveBeenCalled()
  })
  it('fails closed on absent, corrupt, duplicate and throwing runtime data', () => {
    const data = parameters()
    for (const core of [undefined, {}, { getModel: () => { throw new Error('released') } },
      { parameters: { ...data, values: [NaN] } }, { parameters: { ...data, defaultValues: [10] } },
      { parameters: { ...data, minimumValues: [3] } }, { parameters: { ...data, ids: ['a','a'] } }]) {
      expect(enumerateModelParameters(core)).toMatchObject({ supported: false, parameters: [] })
    }
  })
})
