import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, ref, toRaw } from 'vue'
import { CHARACTERS, STORAGE_KEY } from '@/config/characters'
import { useChatStorage, type ChatMessage } from './useChatStorage'
import { useChatConversation } from './useChatConversation'

const message = (mid: string, content = mid): ChatMessage => ({ mid, content, role: 'assistant', stopped: false })
function open() {
  const storage = useChatStorage()
  storage.load()
  return storage
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear() })

describe('chat storage cross-window recovery', () => {
  it('preserves malformed JSON and refuses writes instead of replacing the original', () => {
    localStorage.setItem(STORAGE_KEY, '{damaged')
    const onError = vi.fn()
    const storage = useChatStorage(onError)
    storage.load()
    expect(storage.messages()).toEqual([])
    expect(localStorage.getItem(STORAGE_KEY)).toBe('{damaged')
    expect(storage.save()).toBe(false)
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('原件已保留'))
    expect(open().messages()).toEqual([])
  })

  it('preserves a zero-revision character update after clearing another character', () => {
    const a = open()
    a.messages('nene').push(message('old'))
    a.save()
    const b = open()
    a.clear('nene')
    b.messages('natsume').push(message('new'))
    b.save()
    a.save()
    const restored = open()
    expect(restored.messages('nene')).toEqual([])
    expect(restored.messages('natsume').map(item => item.mid)).toEqual(['new'])
  })

  it('does not resurrect either character after interleaved clears and stale saves', () => {
    const a = open()
    for (const char of ['nene', 'natsume']) a.messages(char).push(message(char))
    a.save()
    const b = open()
    const stale = open()
    a.clear('nene')
    b.clear('natsume')
    stale.save()
    const restored = open()
    expect(restored.messages('nene')).toEqual([])
    expect(restored.messages('natsume')).toEqual([])
  })

  it('preserves disk and loaded messages when normalization writeback fails once', () => {
    const a = open()
    a.messages().push(message('valid'))
    a.save()
    const original = localStorage.getItem(STORAGE_KEY)
    const setItem = localStorage.setItem.bind(localStorage)
    let failed = false
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === STORAGE_KEY && !failed) {
        failed = true
        throw new DOMException('full', 'QuotaExceededError')
      }
      setItem(key, value)
    })
    const onError = vi.fn()
    const b = useChatStorage(onError)
    b.load()
    expect(b.messages()).toHaveLength(1)
    expect(localStorage.getItem(STORAGE_KEY)).toBe(original)
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('暂时无法保存'))
    b.save()
    expect(open().messages()).toHaveLength(1)
  })

  it('retains streaming message and array identity across another window append', () => {
    const a = open()
    const history = a.messages()
    const assistant = message('stream', 'first token')
    history.push(assistant)
    a.save()
    const b = open()
    b.messages().push(message('other-window'))
    b.save()
    a.setVolume(50)
    expect(a.messages()).toBe(history)
    expect(toRaw(a.messages()[0])).toBe(assistant)
    assistant.content += ' plus more finished'
    a.save()
    b.save()
    const restored = open()
    expect(restored.messages().map(item => item.content)).toEqual(['first token plus more finished', 'other-window'])
  })

  it('adopts remote token updates even when history length is unchanged', () => {
    const a = open()
    a.messages().push(message('stream', 'first'))
    a.save()
    const b = open()
    const existing = b.messages()[0]
    a.messages()[0].content = 'first completed'
    a.save()
    b.save()
    expect(b.messages()[0]).toBe(existing)
    expect(existing.content).toBe('first completed')
    expect(open().messages()[0].content).toBe('first completed')
  })

  it('keeps locally modified tokens when a remote stale copy adds a message', () => {
    const a = open()
    a.messages().push(message('stream', 'first'))
    a.save()
    const b = open()
    a.messages()[0].content = 'first plus unsaved token'
    b.messages().push(message('other'))
    b.save()
    a.save()
    expect(open().messages()[0].content).toBe('first plus unsaved token')
  })

  it('persists a real conversation stream through a cross-window save and reload', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(value) { controller = value },
    }))))
    const a = open()
    const busy = ref(false)
    const options = {
      storage: a,
      voice: { ensureAudioContext: vi.fn(), startTurn: vi.fn(), append: vi.fn(), finishTurn: vi.fn(), stop: vi.fn(), isActive: () => false },
      activeChar: ref('nene'), currentCharacter: computed(() => CHARACTERS.nene), busy,
      chatReady: computed(() => true), chatProvider: ref('api'), currentModel: ref('test'),
      apiBaseUrl: ref('https://example.test/v1'), apiModel: ref('test'), apiKey: ref('test'),
      webSearchEnabled: ref(false), useHostConfig: ref(false), companionTools: ref(false),
      reasoning: ref('off'), userProfile: ref({}), recallMemories: () => [],
      setBusy: (value: boolean) => { busy.value = value }, onError: vi.fn(), nearBottom: () => false, scrollBottom: vi.fn(),
    }
    const conversation = useChatConversation(options as unknown as Parameters<typeof useChatConversation>[0])
    a.setDraft('nene', 'hello')
    conversation.inputText.value = 'hello'
    const pending = conversation.sendMessage()
    expect(open().draft('nene')).toBe('')
    const emit = (event: object) => controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n'))
    emit({ type: 'token', content: 'first token' })
    await vi.waitFor(() => expect(a.messages().at(-1)?.content).toBe('first token'))
    a.save() // Publish a stream checkpoint explicitly; volume no longer saves history.
    a.setVolume(30)
    const b = open()
    b.messages().push(message('other-window'))
    b.save()
    a.setDraft('nene', 'next question')
    emit({ type: 'token', content: ' plus more finished' })
    emit({ type: 'done' })
    controller.close()
    await pending
    const restored = open()
    expect(restored.messages().map(item => item.content)).toEqual(['hello', 'first token plus more finished', 'other-window'])
    expect(options.onError.mock.calls.every(([text]) => !text)).toBe(true)
    expect(busy.value).toBe(false)
  })
})
