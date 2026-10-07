import { afterEach, describe, expect, it, vi } from 'vitest'
import { sampleGenerationPalette, visibleGenerationPigment } from './generationPalette'

function image(width = 6, height = 1) {
  const element = document.createElement('img')
  Object.defineProperties(element, {
    complete: { value: true }, naturalWidth: { value: width }, naturalHeight: { value: height },
  })
  return element
}

function context(pixels: number[]) {
  const sample = {
    drawImage: vi.fn(),
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(pixels) })),
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(sample as unknown as CanvasRenderingContext2D)
  return sample
}

afterEach(() => vi.restoreAllMocks())

describe('generation pigments', () => {
  it('samples interior artwork instead of the retired perimeter lights', () => {
    const pixels = Array.from({ length: 36 }, (_, index) => {
      const x = index % 6, y = Math.floor(index / 6)
      return x === 0 || y === 0 || x === 5 || y === 5 ? [90, 140, 180, 255] : [255, 0, 0, 255]
    }).flat()
    context(pixels)
    expect(sampleGenerationPalette(image(6, 6))).toEqual(['255 0 0', '90 140 180', '90 140 180'])
  })

  it('has no palette when the image is fully transparent', () => {
    context(Array(12).fill(0))
    expect(sampleGenerationPalette(image(3))).toEqual([])
  })

  it('falls back harmlessly if the browser rejects pixel access', () => {
    const sample = context([])
    sample.getImageData.mockImplementation(() => { throw new DOMException('Tainted canvas', 'SecurityError') })
    expect(sampleGenerationPalette(image(7680, 4320))).toEqual([])
  })

  it('retains three distinct pigments without letting white margins dominate', () => {
    context([...Array(20).fill([255, 255, 255, 255]), ...Array(8).fill([180, 80, 45, 255]),
      ...Array(5).fill([35, 120, 160, 255]), ...Array(3).fill([115, 60, 165, 255])].flat())
    expect(sampleGenerationPalette(image(6, 6))).toEqual(['180 80 45', '35 120 160', '115 60 165'])
    for (const light of [true, false]) {
      const [red, green, blue] = visibleGenerationPigment('180 80 45', light).split(' ').map(Number)
      expect(red).toBeGreaterThan(green)
      expect(green).toBeGreaterThan(blue)
      const luminance = red * .2126 + green * .7152 + blue * .0722
      expect(luminance).toBeGreaterThanOrEqual(light ? 47 : 134)
      expect(luminance).toBeLessThanOrEqual(light ? 103 : 211)
    }
  })
})
