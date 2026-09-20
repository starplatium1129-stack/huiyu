import { afterEach, describe, it, expect } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { normalizeFraming, useStageFraming, type StageSurface } from './useStageFraming'
import { STAGE_FRAMING_KEY } from '@/utils/storageKeys'
afterEach(() => localStorage.removeItem(STAGE_FRAMING_KEY))
describe('presentation calibration', () => {
  it('bounds corrupt or extreme saved framing without accepting NaN or strings', () => {
    const base = { zoom: 1.15, x: 0, y: 8 }
    expect(normalizeFraming(null, base)).toEqual(base)
    expect(normalizeFraming({ zoom: Infinity, x: -900, y: NaN }, base)).toEqual({ zoom: 1.15, x: -25, y: 8 })
    expect(normalizeFraming({ zoom: 20, x: 3, y: 28 }, base)).toEqual({ zoom: 2.2, x: 3, y: 25 })
  })
  it('keeps saved room calibration and the independent companion calibration until explicit reset', async () => {
    localStorage.setItem(STAGE_FRAMING_KEY, JSON.stringify({ 'room:natsume': { zoom: 1.6, x: 4, y: -5 }, 'companion:natsume': { zoom: 1.2, x: -2, y: 3 } }))
    const scope = effectScope(), character = ref('natsume'), surface = ref<StageSurface>('room')
    try {
      const state = scope.run(() => useStageFraming(character, () => surface.value))!
      expect(state.framing.value).toEqual({ zoom: 1.6, x: 4, y: -5 })
      surface.value = 'companion'; await nextTick()
      expect(state.framing.value.zoom).toBe(1.2)
      surface.value = 'room'; await nextTick()
      state.reset()
      expect(state.framing.value).toEqual({ zoom: .9, x: 0, y: 0 })
      expect(JSON.parse(localStorage.getItem(STAGE_FRAMING_KEY)!)['companion:natsume']).toEqual({ zoom: 1.2, x: -2, y: 3 })
    } finally { scope.stop() }
  })
  it('changing characters reads their defaults without overwriting existing persisted choices', async () => {
    const scope = effectScope(), character = ref('hatsune_miku')
    try {
      const state = scope.run(() => useStageFraming(character, () => 'room'))!
      expect(state.framing.value.zoom).toBe(1)
      character.value = 'frieren'; await nextTick()
      expect(state.framing.value).toEqual({ zoom: 1, x: 0, y: 0 })
      expect(localStorage.getItem(STAGE_FRAMING_KEY)).toBeNull()
    } finally { scope.stop() }
  })
})
