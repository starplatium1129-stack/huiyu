import { afterEach, beforeEach, expect, it, vi } from 'vitest'

beforeEach(() => { vi.resetModules(); vi.stubGlobal('fetch', vi.fn()) })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
const profile = (characterId: string, displayName = characterId) => ({ characterId, displayName, outfits: [] })
it('requests only the selected character and deduplicates concurrent callers', async () => {
  const loader = await import('./characterReferenceData')
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(profile('one'))))
  const first = loader.ensureCharacterReferencesLoaded('one')
  expect(loader.ensureCharacterReferencesLoaded('one')).toBe(first)
  await first
  expect(fetch).toHaveBeenCalledWith('/api/character-reference-profile/one', expect.objectContaining({ cache: 'no-cache', signal: expect.any(AbortSignal) }))
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
it('bounds a stalled profile body, evicts the request, and ignores its late data', async () => {
  vi.useFakeTimers()
  const loader = await import('./characterReferenceData')
  let finish!: (value: unknown) => void
  vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200, json: () => new Promise(resolve => { finish = resolve }) } as Response)
  let failure: unknown
  const pending = loader.ensureCharacterReferencesLoaded('one').catch(error => { failure = error })
  await vi.advanceTimersByTimeAsync(15_001)
  expect(failure).toMatchObject({ name: 'TimeoutError' })
  await pending
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(profile('one', 'retry'))))
  await loader.ensureCharacterReferencesLoaded('one')
  finish(profile('one', 'late'))
  await Promise.resolve(); await Promise.resolve()
  expect(loader.getCharacterReferences('one')?.displayName).toBe('retry')
  vi.useRealTimers()
})
it('cancels one consumer without aborting the shared request for another', async () => {
  const loader = await import('./characterReferenceData')
  let finish!: (response: Response) => void
  vi.mocked(fetch).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  const controller = new AbortController()
  let cancelled = false
  // Third argument is the consumer signal, not ownership of the shared transport.
  const first = loader.ensureCharacterReferencesLoaded('one', false, controller.signal).catch(() => { cancelled = true })
  const second = loader.ensureCharacterReferencesLoaded('one')
  await Promise.resolve()
  controller.abort()
  await Promise.resolve(); await Promise.resolve()
  expect(cancelled).toBe(true)
  expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(false)
  finish(new Response(JSON.stringify(profile('one'))))
  await Promise.all([first, second])
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(loader.getCharacterReferences('one')?.characterId).toBe('one')
})
it('keeps a newer cached refresh when the older request times out', async () => {
  vi.useFakeTimers()
  const loader = await import('./characterReferenceData')
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(() => {}))
  const old = loader.ensureCharacterReferencesLoaded('one').catch(error => error)
  await Promise.resolve()
  vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(profile('one', 'new'))))
  await loader.ensureCharacterReferencesLoaded('one', true)
  await vi.advanceTimersByTimeAsync(15_001)
  expect(await old).toMatchObject({ name: 'TimeoutError' })
  await loader.ensureCharacterReferencesLoaded('one')
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(loader.getCharacterReferences('one')?.displayName).toBe('new')
})
it('does not start a request for an already cancelled consumer', async () => {
  const loader = await import('./characterReferenceData')
  const controller = new AbortController(); controller.abort()
  await expect(loader.ensureCharacterReferencesLoaded('one', false, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(fetch).not.toHaveBeenCalled()
})
