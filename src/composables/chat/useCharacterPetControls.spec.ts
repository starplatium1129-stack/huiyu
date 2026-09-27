import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useCharacterPetControls } from './useCharacterPetControls'
import { createLive2DCtx } from '../live2d/context'
import { createInteractionController } from '../live2d/interactions'
import { compileAdapterProfile, NATSUME_BUILTIN_PROFILE } from '@/live2d/adapterProfile'
import type { Live2DModelHandle } from '@/live2d/types'

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('companion menu capabilities', () => {
  it('rejects arbitrary actions and stale loaded characters', () => {
    const character = ref('natsume')
    const runtime = { ready: ref(true), loadedCharacter: ref('natsume'), interactionHint: ref(''), playPetMotion: vi.fn(), setExpression: vi.fn(async () => true) }
    const controls = useCharacterPetControls(() => character.value, runtime)
    expect(controls.petControls.value.motions.some(item => item.id === 'Head')).toBe(true)
    controls.playPetMotion('Head')
    expect(runtime.playPetMotion).toHaveBeenCalledWith('Head')
    controls.playPetMotion('invented')
    expect(runtime.playPetMotion).toHaveBeenCalledTimes(1)
    character.value = 'nene'
    expect(controls.petControls.value.ready).toBe(false)
    controls.playPetMotion('Head')
    expect(runtime.playPetMotion).toHaveBeenCalledTimes(1)
  })

  it('allows the neutral expression reset but rejects unregistered expressions', async () => {
    const runtime = { ready: ref(true), loadedCharacter: ref('nene'), interactionHint: ref(''), playPetMotion: vi.fn(), setExpression: vi.fn(async () => true) }
    const controls = useCharacterPetControls(() => 'nene', runtime)
    expect(await controls.setPetExpression('unknown')).toBe(false)
    expect(runtime.setExpression).not.toHaveBeenCalled()
    expect(await controls.setPetExpression('')).toBe(true)
    runtime.ready.value = false
    expect(await controls.setPetExpression('')).toBe(false)
    expect(runtime.setExpression).toHaveBeenCalledTimes(1)
  })
})

describe('menu motion lifecycle', () => {
  function setup(motion: Live2DModelHandle['motion']) {
    const ctx = createLive2DCtx()
    const compiled = compileAdapterProfile(NATSUME_BUILTIN_PROFILE, 'browser')
    if (!compiled.ok) throw new Error('test profile invalid')
    ctx.adapter = compiled.adapter
    ctx.ready.value = true
    ctx.character.value = ctx.loadedCharacter.value = 'natsume'
    ctx.model = { visible: true, motion } as Live2DModelHandle
    const setState = vi.fn()
    const interactions = createInteractionController(ctx, { setState, resumeRendering: vi.fn() })
    return { ctx, interactions, setState }
  }

  it('does not apply a late motion result after the model changes', async () => {
    let finish!: (value: boolean) => void
    const motion = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
    const h = setup(motion)
    h.interactions.playById('Head')
    expect(motion).toHaveBeenCalled()
    h.ctx.model = null
    h.ctx.interactionHint.value = 'new model'
    finish(true)
    await Promise.resolve()
    expect(h.ctx.interactionHint.value).toBe('new model')
    expect(h.ctx.activeInteraction).toBe('')
    expect(h.setState).not.toHaveBeenCalled()
  })

  it('retains speech and reduced motion restrictions for menu actions', () => {
    const motion = vi.fn(() => true)
    const h = setup(motion)
    h.ctx.mouthValue.value = 0.5
    h.interactions.playById('Head')
    h.ctx.mouthValue.value = 0
    document.documentElement.dataset.motion = 'reduce'
    try { h.interactions.playById('Head') } finally { delete document.documentElement.dataset.motion }
    expect(motion).not.toHaveBeenCalled()
  })
})
