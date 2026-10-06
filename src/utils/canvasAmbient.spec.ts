import { afterEach, describe, expect, it, vi } from 'vitest'
import { sampleCanvasAmbient } from './canvasAmbient'

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

describe('canvas ambient palette', () => {
  it('samples only the perimeter and keeps eight spatially ordered colors', () => {
    const pixels = Array.from({ length: 36 }, (_, index) => {
      const x = index % 6, y = Math.floor(index / 6)
      return x === 0 || y === 0 || x === 5 || y === 5 ? [90, 140, 180, 255] : [255, 0, 0, 255]
    }).flat()
    context(pixels)
    expect(sampleCanvasAmbient(image(6, 6))).toEqual(Array(8).fill('90 140 180'))
  })

  it('has no palette when the perimeter is fully transparent', () => {
    context(Array(12).fill(0))
    expect(sampleCanvasAmbient(image(3))).toEqual([])
  })

  it('falls back harmlessly if the browser rejects pixel access', () => {
    const sample = context([])
    sample.getImageData.mockImplementation(() => { throw new DOMException('Tainted canvas', 'SecurityError') })
    expect(sampleCanvasAmbient(image(7680, 4320))).toEqual([])
  })
})
