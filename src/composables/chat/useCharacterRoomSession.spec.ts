import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import { useCharacterRoomSession } from './useCharacterRoomSession'

const fixture = vi.hoisted(() => ({
  clips: new Set<string>(),
  callbacks: {} as { onAudioReady?: (mid: string) => void; onAudioCleared?: () => void },
}))
vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }) }))
vi.mock('@/utils/characterSettingMemory', () => ({ loadCharacterSettingCards: async () => {} }))
vi.mock('@/composables/chat/useChatStorage', () => ({ useChatStorage: () => ({
  load: vi.fn(), draft: () => '',
  state: { active: 'nene', settings: { autoVoice: true, volume: 80 } },
  messages: () => [{ role: 'assistant', mid: 'reply', content: 'Final text already received' }],
}) }))
vi.mock('@/composables/chat/useChatProvider', () => ({ useChatProvider: () => ({
  currentModel: ref(''), chatProvider: ref('local'),
  refreshHostConfig: async () => {}, refreshChatStatus: async () => {},
}) }))
vi.mock('@/composables/chat/useRoomSetup', () => ({ useRoomSetup: () => ({
  refreshVoiceStatus: async () => {}, destroy: vi.fn(),
}) }))
vi.mock('@/composables/chat/useRoomMemory', () => ({ useRoomMemory: () => ({ onChatAuxStorage: vi.fn() }) }))
vi.mock('@/composables/chat/useChatConversation', () => ({ useChatConversation: () => ({ inputText: ref(''), destroy: vi.fn() }) }))
vi.mock('@/composables/useVoice', () => ({ useVoice: (callbacks: typeof fixture.callbacks) => {
  fixture.callbacks = callbacks
  return {
    setVolume: vi.fn(), destroy: vi.fn(),
    hasAudio: (mid: string) => fixture.clips.has(mid),
    clearMessages: () => { fixture.clips.clear(); callbacks.onAudioCleared?.() },
  }
} }))
let wrapper: ReturnType<typeof mount> | undefined
afterEach(() => { wrapper?.unmount(); fixture.clips.clear() })

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
