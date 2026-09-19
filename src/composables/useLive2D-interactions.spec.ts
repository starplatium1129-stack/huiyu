import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLive2DCtx } from './live2d/context'
import { createInteractionController } from './live2d/interactions'
import { createParameterFrame } from './live2d/parameterFrame'
import { useCompanionAffection } from './useCompanionAffection'
import { compileAdapterProfile, NATSUME_BUILTIN_PROFILE } from '@/live2d/adapterProfile'

function setup() {
  const ctx = createLive2DCtx()
  ctx.character.value = 'natsume'
  const compiled = compileAdapterProfile(NATSUME_BUILTIN_PROFILE, 'browser')
  if (!compiled.ok) throw new Error(compiled.report.errors.join(', '))
  ctx.adapter = compiled.adapter
  ctx.ready.value = true
  const params = new Map<string, number>([['Param59', -0.65], ['Param60', -0.65]])
  let group: string | null | undefined = 'TapSkirt'
  const motion = vi.fn(() => true)
  ctx.model = {
    visible: true, motion, expression: () => true, hitTest: () => [], focus: () => {},
    setParameterValueById: (id, value) => { params.set(id, value) },
    getParameterValueById: id => params.get(id),
    getActiveMotionGroup: () => group,
    onBeforeModelUpdate: () => {}, applyFit: () => {},
    getNaturalSize: () => ({ width: 420, height: 610 }),
  }
  const interactions = createInteractionController(ctx, { setState: vi.fn(), resumeRendering: vi.fn() })
  const frame = createParameterFrame(ctx, { beginOverlaySettle: interactions.beginOverlaySettle })
  return { ctx, params, motion, interactions, frame, setGroup: (value: typeof group) => { group = value } }
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('Live2D interaction completion', () => {
  it('preserves expression eye parameters and clamps mouth values to the authored range', () => {
    const h = setup()
    h.setGroup('Idle')
    h.ctx.expressionParamIds.add('ParamEyeLOpen')
    h.params.set('ParamEyeLOpen', 0.3)
    h.ctx.adapter!.mouth = { id: 'ParamMouthOpenY', scale: 3, range: [0, 1] }
    h.ctx.speaking = true
    h.ctx.mouthValue.value = 0.8
    h.frame.apply()
    expect(h.params.get('ParamEyeLOpen')).toBe(0.3)
    expect(h.params.get('ParamMouthOpenY')).toBe(1)
    h.ctx.expressionParamIds.clear()
    h.frame.apply()
    expect(h.params.get('ParamEyeLOpen')).toBeGreaterThan(0.3)
  })
  it('interaction audio follows room volume and stays silent during speech or mute', () => {
    vi.useFakeTimers()
    const h = setup()
    h.setGroup('Idle')
    h.ctx.stageEl = document.createElement('div')
    vi.spyOn(h.ctx.stageEl, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 100, height: 100 } as DOMRect)
    const played: { volume: number; play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> }[] = []
    class TestAudio {
      volume = 1
      play = vi.fn(async () => {})
      pause = vi.fn()
      constructor() { played.push(this) }
    }
    vi.stubGlobal('Audio', TestAudio)
    try {
      h.ctx.interactionVolume = 0.23
      h.interactions.bind()
      const tap = () => {
        h.ctx.activeInteraction = ''
        h.ctx.stageEl!.dispatchEvent(new MouseEvent('click', { clientX: 50, clientY: 8 }))
      }
      tap()
      expect(played).toHaveLength(1)
      expect(played[0]!.volume).toBe(0.23)
      h.interactions.stopAudio()
      h.ctx.interactionVolume = 0
      tap()
      h.ctx.interactionVolume = 0.8
      h.ctx.speaking = true
      tap()
      expect(played).toHaveLength(1)
    } finally { vi.clearAllTimers(); vi.unstubAllGlobals() }
  })

  it('settles short variants when Cubism returns to idle, without waiting for the longest variant', () => {
    const h = setup()
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    h.ctx.activeInteraction = 'TapSkirt'
    h.frame.apply()
    expect(h.params.get('Param59')).toBe(-0.65)
    now = 1900
    h.setGroup('Idle')
    h.frame.apply()
    expect(h.ctx.activeInteraction).toBe('')
    expect(h.params.get('Param59')).toBe(-0.65)
    now += 225
    h.frame.apply()
    expect(h.params.get('Param59')).toBeCloseTo(-0.825)
    now += 225
    h.frame.apply()
    expect(h.params.get('Param59')).toBe(-1)
    expect(h.params.get('Param60')).toBe(-1)
  })

  it('ends entrance ownership when Start finishes but preserves legacy runtime fallback', () => {
    const h = setup()
    vi.spyOn(performance, 'now').mockReturnValue(2000)
    h.ctx.entranceUntil = 5200
    h.setGroup('Start')
    h.frame.apply()
    expect(h.ctx.overlaySettle).toBeNull()
    h.setGroup('Idle')
    h.frame.apply()
    expect(h.ctx.entranceUntil).toBe(0)
    expect(h.ctx.overlaySettle).not.toBeNull()
    h.setGroup(undefined)
    h.ctx.activeInteraction = 'TapSkirt'
    h.frame.apply()
    expect(h.ctx.activeInteraction).toBe('TapSkirt')
  })

  it('a locked click does not play motion, audio or award affection', () => {
    const h = setup()
    const affection = useCompanionAffection()
    affection.setScore('natsume', 15)
    h.ctx.stageEl = document.createElement('div')
    vi.spyOn(h.ctx.stageEl, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 100, height: 100 } as DOMRect)
    const audio = vi.fn()
    vi.stubGlobal('Audio', audio)
    try {
      h.interactions.bind()
      h.ctx.stageEl.dispatchEvent(new MouseEvent('click', { clientX: 50, clientY: 85 }))
      expect(h.motion).not.toHaveBeenCalled()
      expect(audio).not.toHaveBeenCalled()
      expect(affection.getScore('natsume')).toBe(15)
      expect(h.ctx.interactionHint.value).toContain('尚未解锁')
      expect(h.ctx.activeInteraction).toBe('')
      expect(affection.dispatchInteractiveMotion('natsume', 'TapFoot')).toBeNull()
    } finally { vi.unstubAllGlobals() }
  })
})
