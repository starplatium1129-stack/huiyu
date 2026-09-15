import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { allocateSceneId, formatSceneId, isSceneId, nextSceneId } from './sceneId'

const backend = createRequire(import.meta.url)('../../scripts/lib/scene-id.js') as {
  isSceneId: (value: unknown) => boolean
  formatSceneId: (value: number) => string
  nextSceneId: (active?: string[], retired?: string[]) => string
}

describe('canonical scene identities shared with the backend', () => {
  it.each(['sc001', 'sc009', 'sc099', 'sc999', 'sc1000', 'sc9007199254740991'])('accepts %s unchanged', id => {
    expect(isSceneId(id)).toBe(true)
    expect(backend.isSceneId(id)).toBe(true)
    expect(formatSceneId(Number(id.slice(2)))).toBe(id)
  })
  it.each(['sc000', 'sc0001', 'sc0999', 'sc1', 'sc01', 'sc-001', 'sc1e3', 'sc1000x', 'SC1000',
    ' sc1000', 'sc1000 ', 'sc9007199254740992', 'sc999999999999999999999', '', null, 1000])('rejects %s in both implementations', id => {
    expect(isSceneId(id)).toBe(false)
    expect(backend.isSceneId(id)).toBe(false)
  })
  it('moves past active and retired IDs without recycling gaps', () => {
    expect(nextSceneId(['sc999'], ['sc1000'])).toBe('sc1001')
    expect(nextSceneId(['sc999'], ['sc1000'])).toBe(backend.nextSceneId(['sc999'], ['sc1000']))
    expect(allocateSceneId('sc1000', ['sc1007'])).toBe('sc1008')
    expect(allocateSceneId('sc2000', ['sc1007'])).toBe('sc2000')
    expect(nextSceneId()).toBe('sc001')
  })
  it('allows the last candidate once and refuses overflow or malformed existing IDs', () => {
    const last = 'sc9007199254740991'
    expect(allocateSceneId(last, [])).toBe(last)
    expect(() => allocateSceneId(last, [last])).toThrow('上限')
    expect(() => nextSceneId([], [last])).toThrow('上限')
    expect(() => backend.nextSceneId([], [last])).toThrow('上限')
    expect(() => nextSceneId(['sc0001'])).toThrow('不规范')
    for (const number of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => formatSceneId(number)).toThrow()
      expect(() => backend.formatSceneId(number)).toThrow()
    }
  })
})
