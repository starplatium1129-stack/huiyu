import { effectScope, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useReferenceCards, removeCastSlot } from './useReferenceCards'
import { ensureCharacterReferencesLoaded } from '@/utils/characterReferenceData'
const profiles = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
vi.mock('@/utils/characterReferenceData', () => ({ getCharacterReferences: (id: string) => profiles.value[id], ensureCharacterReferencesLoaded: vi.fn(async () => {}) }))
function setup() {
  const scope = effectScope()
  const deps = { identityCard: ref(''), batchError: ref(''), readBlobAsDataURL: vi.fn(async () => 'data:image/png;base64,eA=='), uploadVideoImage: vi.fn(async () => ({ ok: true as const, name: 'uploaded.png', bytes: 1 })), onCardRemoved: vi.fn() }
  return { scope, deps, cards: scope.run(() => useReferenceCards(deps))! }
}
beforeEach(() => {
  profiles.value = { one: { displayName: 'One', identityProse: 'One identity', outfits: [
    { outfitId: 'a', outfitName: 'A', isDefault: true, prose: 'outfit A', references: [{ url: '/a.png' }] },
    { outfitId: 'b', outfitName: 'B', prose: 'outfit B', references: [{ url: '/b.png' }] },
  ] } }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['x'], { type: 'image/png' }))))
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
describe('reference-card async ownership', () => {
  it('ignores a previous character profile arriving after a new selection', async () => {
    let finish!: () => void
    vi.mocked(ensureCharacterReferencesLoaded).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const { cards, scope } = setup()
    const old = cards.autoLoadCharacterReferences('one')
    await cards.autoLoadCharacterReferences('missing')
    finish()
    await old
    expect(cards.referenceCards.value[0].characterId).toBe('missing')
    expect(cards.referenceCards.value[0].images).toHaveLength(0)
    expect(cards.loadingRefAssets.value).toBe(false)
    scope.stop()
  })
  it('clears old images when a newly selected character has no loaded profile', async () => {
    const { cards, deps, scope } = setup()
    await cards.autoLoadCharacterReferences('one')
    await cards.autoLoadCharacterReferences('missing')
    expect(cards.referenceCards.value[0].images).toHaveLength(0)
    expect(cards.referenceCards.value[0].characterId).toBe('missing')
    expect(deps.identityCard.value).toBe('')
    expect(deps.batchError.value).toContain('尚未就绪')
    scope.stop()
  })
  it('does not mix an old outfit response into a newly selected outfit', async () => {
    let resolve!: (response: Response) => void
    vi.mocked(fetch).mockReturnValueOnce(new Promise(done => { resolve = done }))
    const { cards, deps, scope } = setup()
    const old = cards.autoLoadCharacterReferences('one', 0, 'a')
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    await cards.autoLoadCharacterReferences('one', 0, 'b')
    resolve(new Response(new Blob(['old'], { type: 'image/png' })))
    await old
    expect(cards.referenceCards.value[0].outfitId).toBe('b')
    expect(cards.referenceCards.value[0].images).toHaveLength(1)
    expect(deps.identityCard.value).toContain('outfit B')
    expect(cards.loadingRefAssets.value).toBe(false)
    scope.stop()
  })
  it('aborts removed cards and clears auto-generated identities without removing manual text', async () => {
    const { cards, deps, scope } = setup()
    await cards.autoLoadCharacterReferences('one')
    cards.removeReferenceCard(0)
    expect(deps.identityCard.value).toBe('')
    expect(deps.onCardRemoved).toHaveBeenCalledWith(0)
    deps.identityCard.value = 'User authored identity'
    await cards.onCardCharacterSelected(0, { target: { value: '' } } as unknown as Event)
    expect(deps.identityCard.value).toBe('User authored identity')
    scope.stop()
  })
  it('continues after individual failed images and never counts pending assets', async () => {
    profiles.value.one = { displayName: 'One', outfits: [{ outfitId: 'a', isDefault: true, references: [{ url: '/bad.png' }, { url: '/ready.png' }, { url: '/pending.png', pending: true }] }] }
    vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'))
    const { cards, deps, scope } = setup()
    expect(await cards.autoLoadCharacterReferences('one')).toBe(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(deps.batchError.value).toContain('1/2')
    scope.stop()
  })
  it('reserves concurrent manual upload slots so the four-image limit cannot be exceeded', async () => {
    const { cards, deps, scope } = setup()
    cards.referenceCards.value[0].images = [{ name: 'one', url: '' }, { name: 'two', url: '' }]
    const resolvers: Array<(value: { ok: true; name: string; bytes: number }) => void> = []
    deps.uploadVideoImage.mockImplementation(() => new Promise(done => { resolvers.push(done) }))
    const event = () => ({ target: { files: [new File(['x'], 'x.png', { type: 'image/png' })], value: '' } } as unknown as Event)
    const first = cards.onReferencePicked(0, event()), second = cards.onReferencePicked(0, event())
    await cards.onReferencePicked(0, event())
    await vi.waitFor(() => expect(resolvers).toHaveLength(2))
    resolvers.forEach(resolve => resolve({ ok: true, name: 'new', bytes: 1 }))
    await Promise.all([first, second])
    expect(cards.referenceCards.value[0].images).toHaveLength(4)
    scope.stop()
  })
  it('keeps actor references attached to the same remaining cards after removal', () => {
    expect(removeCastSlot('123', 0)).toBe('12')
    expect(removeCastSlot('12', 1)).toBe('1')
    expect(removeCastSlot('1', 0)).toBe('')
    expect(removeCastSlot('all', 0)).toBe('all')
  })
})
