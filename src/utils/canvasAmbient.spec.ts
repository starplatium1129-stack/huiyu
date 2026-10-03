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
  it('extracts image colors while excluding transparent, near-white and near-black pixels', () => {
    context([
      190, 80, 70, 255, 20, 180, 240, 0,
      70, 160, 90, 255, 245, 245, 245, 255,
      80, 100, 190, 255, 8, 8, 8, 255,
    ])
    expect(sampleCanvasAmbient(image())).toEqual(['190 80 70', '70 160 90', '80 100 190'])
  })

  it('has no palette when the image has no visible color', () => {
    context([200, 90, 80, 0, 255, 255, 255, 255, 0, 0, 0, 255])
    expect(sampleCanvasAmbient(image(3))).toEqual([])
  })

  it('falls back harmlessly if the browser rejects pixel access', () => {
    const sample = context([])
    sample.getImageData.mockImplementation(() => { throw new DOMException('Tainted canvas', 'SecurityError') })
    expect(sampleCanvasAmbient(image(7680, 4320))).toEqual([])
  })
})
