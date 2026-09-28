import { afterEach, describe, expect, it, vi } from 'vitest'
import { characterArtApi, parseCharacterArtManifest } from './characterArtApi'
import { characterArtEntry, clearCharacterArtManifest } from '../platform/characterArtState'
const request = vi.hoisted(() => vi.fn())
vi.mock('./client.ts', () => ({ apiClient: { request } }))
vi.mock('../utils/runtimeEnvironment.ts', () => ({ isLocalStudioHost: () => true }))
function response(revision = 'first') {
  const base = `/api/character-art/nene/${revision}/`
  return { ok: true, version: revision, entries: { nene: { revision, portraitUrl: `${base}portrait.png`, thumbnailUrl: `${base}thumbnail.png`, particleUrl: `${base}particles.json`, width: 512, height: 768, hasTransparency: true } } }
}
afterEach(() => { clearCharacterArtManifest(); request.mockReset(); vi.unstubAllGlobals() })
describe('character art API boundary', () => {
  it('keeps successful persistence successful when this desktop origin disallows broadcast channels', async () => {
    vi.stubGlobal('BroadcastChannel', class { constructor() { throw new DOMException('unavailable', 'SecurityError') } })
    request.mockResolvedValueOnce(response())
    await expect(characterArtApi.save({ baseVersion: '0', id: 'nene', image: 'data:image/png;base64,x' })).resolves.toMatchObject({ version: 'first' })
    expect(characterArtEntry('nene')?.revision).toBe('first')
  })
  it('rejects externally supplied asset URLs', () => {
    const value = response(); value.entries.nene.portraitUrl = 'https://other.test/private.png'
    expect(() => parseCharacterArtManifest(value)).toThrow('资源地址')
  })
  it('adopts successful save and reset immediately', async () => {
    request.mockResolvedValueOnce(response()).mockResolvedValueOnce({ ok: true, version: 'reset', entries: {} })
    await characterArtApi.save({ baseVersion: '0', id: 'nene', image: 'data:image/png;base64,x' })
    expect(characterArtEntry('nene')?.revision).toBe('first')
    await characterArtApi.save({ baseVersion: 'first', id: 'nene', reset: true })
    expect(characterArtEntry('nene')).toBeUndefined()
  })
  it('does not let a pre-save read restore a stale revision', async () => {
    let finish!: (value: unknown) => void
    request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValueOnce(response('new'))
    const pending = characterArtApi.get()
    await characterArtApi.save({ baseVersion: '0', id: 'nene', image: 'data:image/png;base64,x' })
    finish(response('old')); await pending
    expect(characterArtEntry('nene')?.revision).toBe('new')
  })
  it('does not overwrite a later writer observed before our delayed save acknowledgement', async () => {
    let saved!: (value: unknown) => void
    request.mockImplementationOnce(() => new Promise(resolve => { saved = resolve }))
      .mockResolvedValueOnce(response('other-window')).mockResolvedValueOnce(response('other-window'))
    const writing = characterArtApi.save({ baseVersion: '0', id: 'nene', image: 'data:image/png;base64,x' })
    await characterArtApi.get()
    saved(response('our-earlier-write')); await writing
    expect(characterArtEntry('nene')?.revision).toBe('other-window')
  })

})
