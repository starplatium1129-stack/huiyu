import { effectScope, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useReferenceCards, removeCastSlot } from './useReferenceCards'
import { catalogApi } from '@/api/catalogApi'

vi.mock('@/api/catalogApi', () => ({ catalogApi: { character: vi.fn() } }))
const character = {
  id: 'one', displayName: 'One', originalName: 'One', franchise: 'Fixture', aliases: [],
  identityProse: 'One identity', identityTokens: ['brown_hair'], adultEligibility: 'adult',
  recommendedEngine: 'anima', outfits: [
    { id: 'a', name: 'A', default: true, prose: 'outfit A', tokens: ['dress'] },
    { id: 'b', name: 'B', prose: 'outfit B', tokens: ['coat'] },
  ],
}
const response = { ok: true as const, version: 1, character, profile: null, blueprints: [] }
function setup() {
  const scope = effectScope()
  const deps = { identityCard: ref(''), batchError: ref(''), readBlobAsDataURL: vi.fn(async () => 'data:image/png;base64,eA=='), uploadVideoImage: vi.fn(async () => ({ ok: true as const, name: 'uploaded.png', bytes: 1 })), onCardRemoved: vi.fn() }
  return { scope, deps, cards: scope.run(() => useReferenceCards(deps))! }
}
beforeEach(() => {
  vi.mocked(catalogApi.character).mockReset().mockResolvedValue(response)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })
describe('optional reference cards', () => {
  it('uses catalog identity and outfits without requiring or uploading reference images', async () => {
    const { cards, deps, scope } = setup()
    expect(await cards.selectCardCharacter('one')).toBe(true)
    expect(deps.identityCard.value).toBe('[Character 1 - One]: One identity, outfit A')
    expect(cards.getCharOutfits('one').map(outfit => outfit.id)).toEqual(['a', 'b'])
    await cards.switchCardOutfit(0, 'b')
    expect(cards.referenceCards.value[0]).toMatchObject({ outfitId: 'b', images: [] })
    expect(deps.identityCard.value).toBe('[Character 1 - One]: One identity, outfit B')
    expect(deps.batchError.value).toBe('')
    expect(deps.uploadVideoImage).not.toHaveBeenCalled()
    expect(catalogApi.character).toHaveBeenCalledTimes(1)
    expect(cards.shotReferences({ cast: '1' })).toBeUndefined()
    scope.stop()
  })
  it('reads studio character traits and wardrobe from its catalog profile', async () => {
    vi.mocked(catalogApi.character).mockResolvedValueOnce({ ...response, character: null, profile: {
      id: 'nene', name: '宁宁', alias: ['Ayachi Nene'], traits: [{ tag: 'white_hair' }, { tag: 'purple_eyes' }],
      lora: { special_outfits: { official_witch: ['nene_witch_canonical', 'witch_hat'] } },
    } })
    const { cards, deps, scope } = setup()
    expect(await cards.selectCardCharacter('nene')).toBe(true)
    expect(deps.identityCard.value).toContain('Ayachi Nene, white hair, purple eyes')
    expect(deps.identityCard.value).toContain('witch costume, witch hat')
    expect(cards.referenceCards.value[0].outfitId).toBe('official_witch')
    scope.stop()
  })
  it('cancels an externally owned load without changing a newer card and removes its listener', async () => {
    let finish!: (value: typeof response) => void
    vi.mocked(catalogApi.character).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const { cards, scope } = setup()
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const pending = cards.selectCardCharacter('one', 0, 'b', controller.signal)
    controller.abort()
    await cards.selectCardCharacter('one', 0, 'a')
    finish(response); await pending
    expect(cards.referenceCards.value[0].outfitId).toBe('a')
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    scope.stop()
  })
  it('clears old images and generated identities when catalog selection fails', async () => {
    const { cards, deps, scope } = setup()
    await cards.selectCardCharacter('one')
    cards.referenceCards.value[0].images = [{ name: 'old.png', url: 'blob:old' }]
    vi.mocked(catalogApi.character).mockRejectedValueOnce(new Error('unavailable'))
    expect(await cards.selectCardCharacter('missing')).toBe(false)
    expect(cards.referenceCards.value[0].images).toHaveLength(0)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:old')
    expect(deps.identityCard.value).toBe('')
    expect(deps.batchError.value).toContain('读取失败')
    expect(cards.loadingRefAssets.value).toBe(false)
    scope.stop()
  })
  it('clears auto-generated identities without removing manual text on card removal', async () => {
    const { cards, deps, scope } = setup()
    await cards.selectCardCharacter('one')
    cards.removeReferenceCard(0)
    expect(deps.identityCard.value).toBe('')
    expect(deps.onCardRemoved).toHaveBeenCalledWith(0)
    deps.identityCard.value = 'User authored identity'
    await cards.onCardCharacterSelected(0, '')
    expect(deps.identityCard.value).toBe('User authored identity')
    scope.stop()
  })
  it('reserves concurrent manual upload slots and releases uploaded images on disposal', async () => {
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
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview')
  })
  it('cancels catalog loading when its card is removed and ignores late responses', async () => {
    let signal!: AbortSignal, finish!: (value: typeof response) => void
    vi.mocked(catalogApi.character).mockImplementationOnce((_id, consumerSignal) => new Promise(resolve => {
      signal = consumerSignal!
      finish = resolve
    }))
    const { cards, deps, scope } = setup()
    const pending = cards.selectCardCharacter('one')
    cards.removeReferenceCard(0)
    finish(response)
    expect(await pending).toBe(false)
    expect(signal.aborted).toBe(true)
    expect(cards.loadingRefAssets.value).toBe(false)
    expect(deps.batchError.value).toBe('')
    expect(deps.identityCard.value).toBe('')
    scope.stop()
  })
  it('keeps actor references attached to the same remaining cards after removal', () => {
    expect(removeCastSlot('123', 0)).toBe('12')
    expect(removeCastSlot('12', 1)).toBe('1')
    expect(removeCastSlot('1', 0)).toBe('')
    expect(removeCastSlot('all', 0)).toBe('all')
  })
})
