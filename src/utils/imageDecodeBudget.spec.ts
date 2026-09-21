import { expect, it } from 'vitest'
import { withinImageDecodeBudget } from './imageDecodeBudget'
it('rejects giant dimensions, animations and truncated headers before browser decoding', async () => {
  const png = (width: number, height: number, animated = false) => {
    const bytes = new Uint8Array(40), v = new DataView(bytes.buffer)
    bytes.set([137, 80, 78, 71]); v.setUint32(8, 13); bytes.set([73, 72, 68, 82], 12)
    v.setUint32(16, width); v.setUint32(20, height)
    if (animated) { v.setUint32(8, 0); bytes.set([97, 99, 84, 76], 12) }
    return new Blob([bytes])
  }
  expect(await withinImageDecodeBudget(png(100000, 2))).toBe(false)
  expect(await withinImageDecodeBudget(png(8000, 8000))).toBe(false)
  expect(await withinImageDecodeBudget(png(2, 2, true))).toBe(false)
  expect(await withinImageDecodeBudget(new Blob(['broken']))).toBe(false)
})
