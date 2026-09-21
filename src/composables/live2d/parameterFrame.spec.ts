import { describe, expect, it, vi } from 'vitest'
import { createLive2DCtx } from './context'
import { createParameterFrame } from './parameterFrame'
import { buildCalibratedProfile } from '@/live2d/modelCalibration'
import { compileAdapterProfile } from '@/live2d/adapterProfile'
import type { Live2DModelHandle } from '@/live2d/types'

describe('calibrated frame bindings', () => {
  it('uses inverted mouth and non-unit eye endpoints and contains invalid input levels', () => {
    const ctx = createLive2DCtx(), writes = new Map<string, number>()
    const profile = buildCalibratedProfile('fixture', [
      { id: 'Mouth', min: -2, max: 3, default: 2 },
      { id: 'Eye', min: -3, max: 4, default: 4 },
    ], { id: 'Mouth', closed: 2, open: -1 }, [{ id: 'Eye', closed: -2, open: 3 }])
    const compiled = compileAdapterProfile(profile, 'browser')
    if (!compiled.ok) throw new Error('fixture compile failed')
    ctx.adapter = compiled.adapter
    ctx.model = { visible: true, setParameterValueById: (id: string, value: number) => writes.set(id, value) } as unknown as Live2DModelHandle
    ctx.speaking = true
    vi.spyOn(ctx.blinkScheduler, 'update').mockReturnValue(2)
    const frame = createParameterFrame(ctx, { beginOverlaySettle: () => {} })
    ctx.mouthValue.value = 2; frame.apply()
    expect(writes.get('Mouth')).toBe(-1); expect(writes.get('Eye')).toBe(3)
    ctx.mouthValue.value = -1; frame.apply(); expect(writes.get('Mouth')).toBe(2)
    ctx.mouthValue.value = NaN; frame.apply(); expect(writes.get('Mouth')).toBe(2)
    ctx.expressionParamIds.add('Eye'); writes.set('Eye', 1); frame.apply()
    expect(writes.get('Eye')).toBe(1)
  })
})
