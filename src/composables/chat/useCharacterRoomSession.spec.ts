import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import { useCharacterRoomSession } from './useCharacterRoomSession'
import { resolveConfirm, useConfirmState } from '@/composables/useConfirm'

const fixture = vi.hoisted(() => ({
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
vi.mock('@/composables/chat/useChatConversation', () => ({ useChatConversation: () => ({ inputText: ref(''), destroy: vi.fn(), sendMessage: fixture.sendMessage }) }))
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
