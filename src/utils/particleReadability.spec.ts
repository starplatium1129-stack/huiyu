import { describe, expect, it } from 'vitest'
import { lightPortraitColor, particleNeedsOutline } from './particlePortrait'
describe('light particle contrast', () => {
  it('adds an ink edge to pale colors while preserving their original fill', () => {
    expect(particleNeedsOutline('#ffffff', '#e7e0ed')).toBe(true)
    expect(particleNeedsOutline('#ffecd0', '#e7e0ed')).toBe(true)
    expect(particleNeedsOutline('#b9eaff', '#e7e0ed')).toBe(true)
    expect(particleNeedsOutline('#202030', '#e7e0ed')).toBe(false)
  })
  it('bases its decision on the actual local surface', () => {
    expect(particleNeedsOutline('#ffffff', '#101116')).toBe(false)
    expect(particleNeedsOutline('#202030', '#101116')).toBe(true)
  })
  it('enriches light-theme color without tinting neutrals or clipping hue', () => {
    for (const color of ['#000000', '#ffffff', '#808080', '#ff0000']) expect(lightPortraitColor(color)).toBe(color)
    const channels = (hex: string) => [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16))
    const source = channels('#cd8c68'), enriched = channels(lightPortraitColor('#cd8c68'))
    expect(enriched[0] - enriched[2]).toBeGreaterThan(source[0] - source[2])
    const brightness = (rgb: number[]) => rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722
    expect(Math.abs(brightness(enriched) - brightness(source))).toBeLessThan(.6)
    expect(lightPortraitColor('invalid')).toBe('invalid')
  })
})
