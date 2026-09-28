import { afterEach, expect, it, vi } from 'vitest'
import { adoptCharacterArtManifest, clearCharacterArtManifest } from '../platform/characterArtState'
import { loadPortraitCloud, portraitCloudIdentity } from './particlePortrait'
vi.mock('../utils/runtimeEnvironment.ts', () => ({ isLocalStudioHost: () => true }))
const cloud = { id: 'nene', aspect: 1, palette: ['#aabbcc'], grid: { w: 8, h: 8, cells: '0'.repeat(64) } }
function update(revision: string) {
  const base = `/api/character-art/nene/${revision}/`
  adoptCharacterArtManifest({ version: revision, entries: { nene: { revision, portraitUrl: `${base}portrait.png`, thumbnailUrl: `${base}thumbnail.png`, particleUrl: `${base}particles.json`, width: 512, height: 512, hasTransparency: true } } })
}
afterEach(() => { clearCharacterArtManifest(); vi.unstubAllGlobals() })
it('shares same-version loads but rejects an old cloud after a portrait replacement', async () => {
  let finish!: (value: Response) => void
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValueOnce(new Response(JSON.stringify(cloud)))
  vi.stubGlobal('fetch', fetcher)
  update('before')
  const old = loadPortraitCloud('nene')
  expect(loadPortraitCloud('nene')).toBe(old)
  update('after')
  expect(portraitCloudIdentity('nene')).toContain(':after')
  expect(await loadPortraitCloud('nene')).toEqual(cloud)
  finish(new Response(JSON.stringify(cloud)))
  expect(await old).toBeNull()
  expect(fetcher).toHaveBeenLastCalledWith('/api/character-art/nene/after/particles.json', expect.any(Object))
})
