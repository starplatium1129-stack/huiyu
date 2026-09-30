import { afterEach, describe, expect, it, vi } from 'vitest'
import { useLive2D } from '@/composables/useLive2D'
import * as context from './live2d/context'
import { NATIVE_CAPABILITY, type Live2DStageSession } from '@/live2d/types'

afterEach(() => vi.restoreAllMocks())

describe('useLive2D 组合根 · 安全口型控制', () => {

  it('setMouth 钳制到 [0,1]，非数/越界回退安全值', () => {
    const ctx = context.createLive2DCtx()
    vi.spyOn(context, 'createLive2DCtx').mockReturnValue(ctx)
    const api = useLive2D()
    expect(api.ready.value).toBe(false)
    expect(api.enabled.value).toBe(false)
    expect(api.character.value).toBe('nene')
    api.setMouth(1.5)
    expect(api.mouthValue.value).toBe(1)
    api.setMouth(-1)
    expect(api.mouthValue.value).toBe(0)
    api.setMouth(NaN)
    expect(api.mouthValue.value).toBe(0)
    api.setMouth(0.42)
    expect(api.mouthValue.value).toBeCloseTo(0.42)
    const sendMouthLevel = vi.fn()
    ctx.session = { kind: 'native', capability: NATIVE_CAPABILITY, sendMouthLevel, setPaused: vi.fn(), destroy: vi.fn() } as unknown as Live2DStageSession
    api.setSpeaking(false)
    expect(api.mouthValue.value).toBe(0)
    expect(sendMouthLevel).toHaveBeenCalledExactlyOnceWith(0)
    api.destroy()
  })
})
