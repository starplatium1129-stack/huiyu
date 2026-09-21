import { afterEach, beforeEach, expect, it, vi } from 'vitest'

beforeEach(() => { vi.resetModules(); vi.stubGlobal('fetch', vi.fn()) })
afterEach(() => vi.unstubAllGlobals())
const profile = (characterId: string, displayName = characterId) => ({ characterId, displayName, outfits: [] })
it('requests only the selected character and deduplicates concurrent callers', async () => {
  const loader = await import('./characterReferenceData')
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(profile('one'))))
  const first = loader.ensureCharacterReferencesLoaded('one')
  expect(loader.ensureCharacterReferencesLoaded('one')).toBe(first)
  await first
  expect(fetch).toHaveBeenCalledWith('/api/character-reference-profile/one', { cache: 'no-cache' })
  expect(loader.getCharacterReferences('one')?.characterId).toBe('one')
  expect(loader.getCharacterReferences('two')).toBeUndefined()
})
it('retries failures and ignores old results after refresh', async () => {
  const loader = await import('./characterReferenceData')
  vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'))
  await expect(loader.ensureCharacterReferencesLoaded('one')).rejects.toThrow('offline')
  let finish!: (response: Response) => void
  vi.mocked(fetch).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  const old = loader.ensureCharacterReferencesLoaded('one')
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(profile('one', 'new'))))
  await loader.ensureCharacterReferencesLoaded('one', true)
  finish(new Response(JSON.stringify(profile('one', 'old'))))
  await old
  expect(loader.getCharacterReferences('one')?.displayName).toBe('new')
})
it('clears a removed profile on refresh and rejects mismatched payloads', async () => {
  const loader = await import('./characterReferenceData')
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(profile('one'))))
  await loader.ensureCharacterReferencesLoaded('one')
  vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 404 }))
  await loader.ensureCharacterReferencesLoaded('one', true)
  expect(loader.getCharacterReferences('one')).toBeUndefined()
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(profile('two'))))
  await expect(loader.ensureCharacterReferencesLoaded('one', true)).rejects.toThrow('格式无效')
})
