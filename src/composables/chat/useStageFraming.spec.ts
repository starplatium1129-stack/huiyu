import { describe, it, expect } from 'vitest'
import { normalizeFraming } from './useStageFraming'
describe('presentation calibration', () => {
  it('bounds corrupt or extreme saved framing without accepting NaN or strings', () => {
    const base = { zoom: 1.15, x: 0, y: 8 }
    expect(normalizeFraming(null, base)).toEqual(base)
    expect(normalizeFraming({ zoom: Infinity, x: -900, y: NaN }, base)).toEqual({ zoom: 1.15, x: -25, y: 8 })
    expect(normalizeFraming({ zoom: 20, x: 3, y: 28 }, base)).toEqual({ zoom: 2.2, x: 3, y: 25 })
  })
})
