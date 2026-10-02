import type { CompanionDesktopBridge } from '@/types/desktop'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, nextTick, ref } from 'vue'
import { useCompanionChatWindow } from './useCompanionChatWindow'
import { useCompanionSpeechInput } from '@/composables/useCompanionSpeechInput'
import { COMPANION_CHAT_LIVE_KEY } from '@/utils/storageKeys'
import { DEFAULT_SPEECH_INPUT_CONFIG, SPEECH_INPUT_KEY } from '@/utils/speechInputConfig'
import { useChatSpeechInteraction } from './useChatSpeechInteraction'
import { getCompanionCharacterConfig } from '@/utils/companionRegistry'
import { profileLocalStorage } from '@/platform/web/profileStorage'

const fixture = vi.hoisted(() => ({
  onText: (_text: string, _source: string) => {},
  visibility: (_visible: boolean) => {},
  relay: vi.fn(async () => {}),
}))
const state = ref('idle'), autoListening = ref(false)
const start = vi.fn(async (mode?: string) => { state.value = 'capturing'; autoListening.value = mode === 'auto' })
const cancel = vi.fn(() => { state.value = 'idle'; autoListening.value = false })
vi.mock('@/composables/useVoiceInput', () => ({ useVoiceInput: (options: { onText: typeof fixture.onText }) => {
  fixture.onText = options.onText
  return { state, autoListening, supported: true, errorMessage: ref(''), start, cancel,
    stop: vi.fn(() => { state.value = 'idle'; autoListening.value = false }), release: vi.fn() }
} }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }))
vi.mock('@/utils/chatRelayReceipt', () => ({ relayChatTurn: fixture.relay }))
vi.mock('@/composables/chat/useConversationReading', () => ({ useConversationReading: () => ({ hasNew: ref(false), latest: vi.fn() }) }))
vi.mock('@/composables/chat/useChatStorage', () => ({ useChatStorage: () => {
  const drafts: Record<string, string> = {}
  return { state: { active: 'nene' }, messages: () => [], load: vi.fn(), canWrite: () => true,
    draft: (id: string) => drafts[id] || '', setDraft: (id: string, text: string) => { drafts[id] = text }, setActive: vi.fn() }
} }))

let wrapper: ReturnType<typeof mount> | undefined
let chat: ReturnType<typeof useCompanionChatWindow>
function mountSession(setup: () => void) {
  wrapper = mount(defineComponent({ setup() { setup(); return () => null } }))
}
function live(extra: Record<string, unknown> = {}) {
  localStorage.setItem(COMPANION_CHAT_LIVE_KEY, JSON.stringify({ activeChar: 'nene', busy: false, chatReady: true, speaking: false, ts: Date.now(), ...extra }))
  window.dispatchEvent(new StorageEvent('storage', { key: COMPANION_CHAT_LIVE_KEY }))
}
function setup(wakeEnabled = false, autoSend = false) {
  localStorage.setItem(SPEECH_INPUT_KEY, JSON.stringify({ ...DEFAULT_SPEECH_INPUT_CONFIG, enabled: true,
    endpoint: 'http://127.0.0.1:9999', wakeEnabled, autoSend, wakeWords: ['你好'] }))
  localStorage.setItem('aics_companion_behavior_v1', JSON.stringify({ enabled: true, quietStartHour: 0, quietEndHour: 0 }))
  live()
  mountSession(() => { chat = useCompanionChatWindow() })
}
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks(); state.value = 'idle'; autoListening.value = false
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  desktopFixture.current = { chatRelay: vi.fn(), getChatDocked: async () => true,
    onVisibilityChanged: (cb: typeof fixture.visibility) => { fixture.visibility = cb; return 1 }, offVisibilityChanged: vi.fn(),
  } as unknown as CompanionDesktopBridge
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined; desktopFixture.current = undefined; vi.restoreAllMocks() })

describe('companion chat speech ownership', () => {
  it.each(['blur', 'hidden', 'native-hidden'])('cancels manual recording on %s without submitting it', async reason => {
    setup(); chat.onSpeechPress(); await nextTick(); expect(state.value).toBe('capturing')
    if (reason === 'blur') { vi.mocked(document.hasFocus).mockReturnValue(false); window.dispatchEvent(new Event('blur')) }
    if (reason === 'hidden') { vi.spyOn(document, 'hidden', 'get').mockReturnValue(true); document.dispatchEvent(new Event('visibilitychange')) }
    if (reason === 'native-hidden') fixture.visibility(false)
    await nextTick(); expect(state.value).toBe('idle'); expect(cancel).toHaveBeenCalled(); expect(fixture.relay).not.toHaveBeenCalled()
  })
  it('cancels capture as soon as the character starts replying', async () => {
    setup(); chat.onSpeechPress(); live({ busy: true }); await nextTick()
    expect(state.value).toBe('idle')
  })
  it('resumes continuous listening after reply and TTS finish', async () => {
    setup(true, true); await nextTick()
    fixture.onText('你好', 'auto'); fixture.onText('今天怎么样', 'auto'); await flushPromises()
    live({ busy: true }); await nextTick()
    expect(autoListening.value).toBe(false)
    live({ speaking: true }); await nextTick()
    expect(autoListening.value).toBe(false)
    expect(chat.speechButtonDisabled.value).toBe(true)
    live(); await nextTick()
    expect(autoListening.value).toBe(true)
    expect(chat.speechButtonDisabled.value).toBe(false)
    fixture.onText('再聊一句', 'auto'); await flushPromises()
    expect(fixture.relay).toHaveBeenCalledTimes(2)
  })
  it('accepts a second manual transcript when auto-send is disabled', async () => {
    setup(); fixture.onText('第一段草稿', 'manual'); await nextTick()
    fixture.onText('第二段草稿', 'manual'); await nextTick()
    expect(chat.inputText.value).toBe('第二段草稿'); expect(fixture.relay).not.toHaveBeenCalled()
  })
  it('can wake again after an end phrase without a chat reply', async () => {
    setup(true); fixture.onText('你好', 'auto'); fixture.onText('结束对话', 'auto'); await nextTick()
    fixture.onText('你好', 'auto'); fixture.onText('新的草稿', 'auto'); await nextTick()
    expect(chat.inputText.value).toBe('新的草稿')
  })
})

describe('browser companion speech session', () => {
  it.each([
    { entry: 'companion', failure: 'getItem' }, { entry: 'chat', failure: 'getItem' },
    { entry: 'desktop', failure: 'getItem' }, { entry: 'companion', failure: 'getter' },
  ])('mounts $entry with speech disabled after a storage $failure failure', async ({ entry, failure }) => {
    const saved = JSON.stringify({ ...DEFAULT_SPEECH_INPUT_CONFIG, enabled: true,
      endpoint: 'https://speech.example.test/v1', wakeEnabled: true, wakeWords: ['你好'] })
    localStorage.setItem(SPEECH_INPUT_KEY, saved)
    live()
    const getItem = localStorage.getItem.bind(localStorage)
    vi.spyOn(profileLocalStorage, 'getItem').mockImplementation(key => {
      if (key === SPEECH_INPUT_KEY && failure === 'getItem') throw new DOMException('fixture read denied', 'SecurityError')
      if (failure === 'getter') return globalThis.localStorage.getItem(key)
      return getItem(key)
    })
    const writes = vi.spyOn(profileLocalStorage, 'setItem')
    if (failure === 'getter') vi.spyOn(globalThis, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('fixture storage unavailable', 'SecurityError')
    })
    let speech!: Pick<ReturnType<typeof useCompanionSpeechInput>, 'speechReady' | 'speechSettingsOpen' | 'onSpeechPress' | 'onSpeechSettingsSaved'>
    mountSession(() => {
      const common = { busy: ref(false), chatReady: ref(true), inputText: ref(''), handleSend: vi.fn() }
      speech = entry === 'desktop' ? useCompanionChatWindow() : entry === 'chat'
        ? useChatSpeechInteraction({ ...common, currentCharacter: ref(getCompanionCharacterConfig('nene')!) })
        : useCompanionSpeechInput({ ...common, currentCharacter: ref('nene'), currentCharacterName: () => '宁宁',
          desktopWindowVisible: ref(true), dnd: ref(false), inQuietHours: ref(false), isEditableTarget: () => false })
    })
    await nextTick()
    expect(speech.speechReady.value).toBe(false)
    expect(speech.speechSettingsOpen.value).toBe(true)
    speech.onSpeechPress()
    expect(start).not.toHaveBeenCalled()
    expect(writes.mock.calls.filter(([key]) => key === SPEECH_INPUT_KEY)).toEqual([])
    expect(getItem(SPEECH_INPUT_KEY)).toBe(saved)
    // A confirmed save is applied directly even if storage reads are still denied.
    speech.onSpeechSettingsSaved(JSON.parse(saved))
    await nextTick()
    expect(speech.speechReady.value).toBe(true)
    expect(speech.speechSettingsOpen.value).toBe(false)
    speech.onSpeechPress()
    expect(start).toHaveBeenCalled()
  })

  it.each([false, true])('accepts repeated drafts with wake=%s', async wakeEnabled => {
    localStorage.setItem(SPEECH_INPUT_KEY, JSON.stringify({ ...DEFAULT_SPEECH_INPUT_CONFIG,
      enabled: true, endpoint: 'http://127.0.0.1:9999', wakeEnabled, wakeWords: ['你好'] }))
    const inputText = ref('')
    mountSession(() => {
      useCompanionSpeechInput({ busy: ref(false), chatReady: ref(true), inputText,
        currentCharacter: ref('nene'), currentCharacterName: () => '宁宁', desktopWindowVisible: ref(true),
        dnd: ref(false), inQuietHours: ref(false), handleSend: vi.fn(), isEditableTarget: () => false })
    })
    if (wakeEnabled) fixture.onText('你好', 'auto')
    fixture.onText('第一段', wakeEnabled ? 'auto' : 'manual'); await nextTick()
    fixture.onText('第二段', wakeEnabled ? 'auto' : 'manual'); await nextTick()
    expect(inputText.value).toBe('第二段')
    fixture.onText('结束对话', 'manual'); await nextTick()
    if (wakeEnabled) fixture.onText('你好', 'auto')
    fixture.onText('重新开始', wakeEnabled ? 'auto' : 'manual'); await nextTick()
    expect(inputText.value).toBe('重新开始')
  })
})

const desktopFixture = vi.hoisted(() => ({ current: undefined as CompanionDesktopBridge | undefined }))
vi.mock('@/platform/desktop/capabilities', () => ({ getDesktopCapabilities: () => desktopFixture.current }))
