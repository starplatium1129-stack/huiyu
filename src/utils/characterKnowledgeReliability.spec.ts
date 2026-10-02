import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { changeStoredChatMemory, emptyChatMemoryState, normalizeChatMemoryState, rememberChatFact, mergeChatMemoryStates, editChatFact } from './chatMemory'
import { parseCharacterSettingCards, recallCharacterSetting } from './characterSettingMemory'
import { CHAT_MEMORY_KEY } from './storageKeys'
vi.mock('virtual:data-version', () => ({ DATA_VERSION: 'test' }))
beforeEach(() => localStorage.clear())
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
describe('character knowledge and memory reliability', () => {
  it('preserves identity descriptions stored in the legacy string format', () => {
    const cards = parseCharacterSettingCards([{ id: 'legacy', identity: '咖啡馆兼职店员', bg_story: '角色背景' }])
    expect(cards[0].identity?.role).toBe('咖啡馆兼职店员')
    expect(recallCharacterSetting(cards, 'legacy', '咖啡馆')).toContain('设定：身份 咖啡馆兼职店员')
  })
  it('rejects invalid character identities and keeps the newest version of an edited memory', () => {
    const state = normalizeChatMemoryState({ byCharacter: { nene: [
      { id: 'edited', character: 'nene', text: 'old fact', updatedAt: 1 },
      { id: 'edited', character: 'nene', text: 'new fact', updatedAt: 2 },
      { id: 'foreign', character: 'unknown', text: 'must not become Nene' },
    ] } })
    expect(state.byCharacter.nene.map(item => item.text)).toEqual(['new fact'])
  })
  it('updates facts from the same source message rather than keeping contradictory old text', () => {
    const state = emptyChatMemoryState()
    const old = rememberChatFact(state, 'nene', '我周五有空', 'one')!
    const updated = rememberChatFact(state, 'nene', '我周五没空', 'one')!
    expect(updated.id).toBe(old.id)
    expect(state.byCharacter.nene).toHaveLength(1)
    expect(updated.text).toBe('我周五没空')
  })
  it('merges newer edits by identity and prevents duplicate text after editing', () => {
    const old = emptyChatMemoryState(), incoming = emptyChatMemoryState()
    const original = rememberChatFact(old, 'nene', 'old')!
    incoming.byCharacter.nene.push({ ...original, text: 'new', updatedAt: original.updatedAt + 1 })
    const merged = mergeChatMemoryStates(old, incoming)
    expect(merged.byCharacter.nene.map(item => item.text)).toEqual(['new'])
    const duplicate = rememberChatFact(merged, 'nene', 'other')!
    editChatFact(merged, 'nene', duplicate.id, 'new')
    expect(merged.byCharacter.nene).toHaveLength(1)
  })
  it('reads the latest persisted memory before changing it and preserves other characters', () => {
    changeStoredChatMemory(state => Boolean(rememberChatFact(state, 'nene', 'first')))
    changeStoredChatMemory(state => Boolean(rememberChatFact(state, 'natsume', 'other character')))
    const state = changeStoredChatMemory(state => Boolean(rememberChatFact(state, 'nene', 'second')))!
    expect(state.byCharacter.nene).toHaveLength(2)
    expect(state.byCharacter.natsume[0].text).toBe('other character')
  })
  it('does not overwrite existing memory when saving fails or storage is malformed', () => {
    localStorage.setItem(CHAT_MEMORY_KEY, JSON.stringify(emptyChatMemoryState()))
    const previous = localStorage.getItem(CHAT_MEMORY_KEY)
    const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota') })
    expect(() => changeStoredChatMemory(state => Boolean(rememberChatFact(state, 'nene', 'unsaved')))).toThrow('quota')
    expect(localStorage.getItem(CHAT_MEMORY_KEY)).toBe(previous)
    write.mockRestore()
    localStorage.setItem(CHAT_MEMORY_KEY, '{broken')
    expect(() => changeStoredChatMemory(() => true)).toThrow()
    expect(localStorage.getItem(CHAT_MEMORY_KEY)).toBe('{broken')
  })
  it('retrieves knowledge from the end of long backgrounds while preserving character isolation and limits', () => {
    const cards = parseCharacterSettingCards([{ id: 'nene', bg_story: '普通背景内容。'.repeat(70) + '最后在星空咖啡馆值夜班', personality: ['温柔'] }])
    expect(recallCharacterSetting(cards, 'nene', '星空咖啡馆')).toContainEqual(expect.stringContaining('星空咖啡馆'))
    expect(recallCharacterSetting(cards, 'natsume', '星空咖啡馆')).toEqual([])
    expect(recallCharacterSetting(cards, 'nene', 'unrelated', 0)).toEqual([])
  })
  it('retries a failed knowledge load and prevents stale refresh results replacing newer cards', async () => {
    vi.resetModules()
    const module = await import('./characterSettingMemory')
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(Response.json([{ id: 'nene', name: 'ready' }]))
    vi.stubGlobal('fetch', fetchMock)
    await expect(module.loadCharacterSettingCards()).rejects.toThrow('offline')
    await module.loadCharacterSettingCards()
    let resolve!: (response: Response) => void
    fetchMock.mockReturnValueOnce(new Promise(done => { resolve = done })).mockResolvedValueOnce(Response.json([{ id: 'nene', name: 'newest' }]))
    const old = module.loadCharacterSettingCards(true)
    await module.loadCharacterSettingCards(true)
    resolve(Response.json([{ id: 'nene', name: 'late' }]))
    await old
    expect(module.characterSettingCards()[0].name).toBe('newest')
  })
})
