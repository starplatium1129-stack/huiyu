import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import { useCharacterRoomSession } from './useCharacterRoomSession'
import { settingsRepository, CHAT_THINKING_SETTING } from '@/storage/settingsRepository'
import { resolveConfirm, useConfirmState } from '@/composables/useConfirm'

const fixture = vi.hoisted(() => ({
  conversationOptions: undefined as unknown,
  clips: new Set<string>(),
  callbacks: {} as { onAudioReady?: (mid: string) => void; onAudioCleared?: () => void },
  sendMessage: vi.fn(async () => {}),
  clear: vi.fn(),
  clearStoredChatContent: vi.fn(async () => ({ failed: [] })),
}))
vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }) }))
vi.mock('@/utils/characterSettingMemory', () => ({ loadCharacterSettingCards: async () => {} }))
vi.mock('@/utils/chatReset', () => ({ clearStoredChatContent: fixture.clearStoredChatContent }))
vi.mock('@/composables/chat/useChatStorage', () => ({ useChatStorage: () => ({
  load: vi.fn(), draft: () => '', canWrite: () => true, clear: fixture.clear,
  state: { active: 'nene', settings: { autoVoice: true, volume: 80 } },
  messages: () => [{ role: 'assistant', mid: 'reply', content: 'Final text already received' }],
}) }))
vi.mock('@/composables/chat/useChatProvider', () => ({ useChatProvider: () => ({
  currentModel: ref(''), chatProvider: ref('local'), chatReady: ref(true),
  refreshHostConfig: async () => {}, refreshChatStatus: async () => {},
}) }))
vi.mock('@/composables/chat/useRoomSetup', () => ({ useRoomSetup: () => ({
  refreshVoiceStatus: async () => {}, destroy: vi.fn(),
}) }))
vi.mock('@/composables/chat/useRoomMemory', () => ({ useRoomMemory: () => ({ onChatAuxStorage: vi.fn() }) }))
vi.mock('@/composables/chat/useChatConversation', () => ({ useChatConversation: (options: unknown) => { fixture.conversationOptions = options; return { inputText: ref(''), destroy: vi.fn(), sendMessage: fixture.sendMessage } } }))
vi.mock('@/composables/useVoice', () => ({ useVoice: (callbacks: typeof fixture.callbacks) => {
  fixture.callbacks = callbacks
  return {
    setVolume: vi.fn(), destroy: vi.fn(), stop: vi.fn(),
    hasAudio: (mid: string) => fixture.clips.has(mid),
    clearMessages: () => { fixture.clips.clear(); callbacks.onAudioCleared?.() },
  }
} }))
let wrapper: ReturnType<typeof mount> | undefined
afterEach(() => { wrapper?.unmount(); wrapper = undefined; fixture.clips.clear(); vi.clearAllMocks(); vi.unstubAllGlobals() })

it.each([true, false])('rejects a late chat lock result after unmount (granted=%s)', async granted => {
  let resolveLock!: (value: object | null) => void
  const pending = new Promise<object | null>(resolve => { resolveLock = resolve })
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: object, run: (lock: object | null) => Promise<void>) => run(await pending) } })
  let room!: ReturnType<typeof useCharacterRoomSession>
  wrapper = mount(defineComponent({ setup() { room = useCharacterRoomSession(); return () => null } }))
  const accepted = vi.fn()
  room.handleSend('页面关闭前准备发送的消息', undefined, accepted)
  wrapper.unmount(); wrapper = undefined
  resolveLock(granted ? {} : null)
  await flushPromises()
  expect(accepted).toHaveBeenCalledExactlyOnceWith(false)
  expect(fixture.sendMessage).not.toHaveBeenCalled()
  expect(room.chatError.value).toBe('')
})

it.each(['clearCharacterConversation', 'clearAllMemory'] as const)('dismisses the owned %s confirmation on unmount', async action => {
  let room!: ReturnType<typeof useCharacterRoomSession>
  wrapper = mount(defineComponent({ setup() { room = useCharacterRoomSession(); return () => null } }))
  const pending = room[action]()
  expect(useConfirmState().value.visible).toBe(true)
  wrapper.unmount(); wrapper = undefined
  expect.soft(useConfirmState().value.visible).toBe(false)
  resolveConfirm(true)
  await pending
  expect(fixture.clear).not.toHaveBeenCalled()
  expect(fixture.clearStoredChatContent).not.toHaveBeenCalled()
})

it('updates replay availability when audio arrives after final text and when cached audio is cleared', async () => {
  let room!: ReturnType<typeof useCharacterRoomSession>
  wrapper = mount(defineComponent({ setup() {
    room = useCharacterRoomSession()
    return () => h('button', { disabled: !room.hasReplayable.value }, 'Replay')
  } }))
  await nextTick()
  const messages = room.currentMessages.value
  expect(wrapper.get('button').attributes('disabled')).toBeDefined()
  fixture.clips.add('reply')
  fixture.callbacks.onAudioReady?.('reply')
  await nextTick()
  expect(room.currentMessages.value).toBe(messages)
  expect(wrapper.get('button').attributes('disabled')).toBeUndefined()
  room.voice.clearMessages(['reply'])
  await nextTick()
  expect(room.currentMessages.value).toBe(messages)
  expect(wrapper.get('button').attributes('disabled')).toBeDefined()
})


it.each([undefined, 'low', 'medium', 'high', 'off'] as const)('sends a fresh room profile with compatible default thinking while preserving saved %s', async saved => {
  vi.spyOn(settingsRepository, 'get').mockImplementation(key => key === CHAT_THINKING_SETTING ? saved ?? null : null)
  let room!: ReturnType<typeof useCharacterRoomSession>
  wrapper = mount(defineComponent({ setup() { room = useCharacterRoomSession(); return () => null } }))
  const actual = await vi.importActual<typeof import('./useChatConversation')>('./useChatConversation')
  const options = fixture.conversationOptions as Parameters<typeof actual.useChatConversation>[0]
  // Use the session's actual default refs through the real request serializer.
  Object.assign(options, {
    setBusy: vi.fn(), onError: vi.fn(),
    chatProvider: ref('api'), currentModel: ref('deepseek-flash'), apiModel: ref('deepseek-flash'),
    apiBaseUrl: ref('https://api.deepseek.com'), apiKey: ref('fixture-only'),
    useHostConfig: ref(false), webSearchEnabled: ref(false), userProfile: ref({}), recallMemories: () => [],
    storage: { messages: () => [], trim: vi.fn(), save: vi.fn(), setDraft: vi.fn() },
    voice: { ensureAudioContext: vi.fn(), startTurn: vi.fn(), append: vi.fn(), finishTurn: vi.fn(), stop: vi.fn(), isActive: () => false },
  })
  const fetchMock = vi.fn().mockResolvedValue(new Response('{"type":"token","content":"hello"}\n{"type":"done"}\n'))
  vi.stubGlobal('fetch', fetchMock)
  const conversation = actual.useChatConversation(options)
  await conversation.sendMessage('你好')
  const request = JSON.parse(fetchMock.mock.calls[0]![1].body)
  expect(request.reasoning).toBe(saved ?? 'off')
  expect(request.companionTools).toBe(true)
  expect(request.api.model).toBe('deepseek-flash')
  expect(room.reasoning.value).toBe(saved ?? 'off')
  conversation.destroy()
  vi.restoreAllMocks()
})
