import type { CompanionDesktopBridge } from '@/types/desktop'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { computed, defineComponent, nextTick, ref } from 'vue'
import { useCompanionChatWindow } from './useCompanionChatWindow'
import { useCompanionSpeechInput } from '@/composables/useCompanionSpeechInput'
import { COMPANION_CHAT_LIVE_KEY } from '@/utils/storageKeys'
import { DEFAULT_SPEECH_INPUT_CONFIG, SPEECH_INPUT_KEY } from '@/utils/speechInputConfig'
import { useChatSpeechInteraction } from './useChatSpeechInteraction'
import { getCompanionCharacterConfig } from '@/utils/companionRegistry'
import { profileLocalStorage } from '@/platform/web/profileStorage'
import { useVoice } from '@/composables/useVoice'

const fixture = vi.hoisted(() => ({
  onText: (_text: string, _source: string) => {},
  visibility: (_visible: boolean) => {},
  relay: vi.fn(async () => {}),
  voiceApi: { getStatus: vi.fn(), prepare: vi.fn(), translate: vi.fn() },
}))
vi.mock('@/api/voiceApi', () => ({ voiceApi: fixture.voiceApi }))
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
let voice: ReturnType<typeof useVoice> | undefined
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
afterEach(() => { wrapper?.unmount(); wrapper = undefined; voice?.destroy(); voice = undefined;
  desktopFixture.current = undefined; vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('companion chat speech ownership', () => {
  it.each([
    { reason: 'hidden', mode: 'auto', phase: 'recognizing' },
    { reason: 'blur', mode: 'manual', phase: 'acquiring' },
  ])('chat cancels $mode speech on $reason and rejects its late transcript', async ({ reason, mode, phase }) => {
    localStorage.setItem(SPEECH_INPUT_KEY, JSON.stringify({ ...DEFAULT_SPEECH_INPUT_CONFIG,
      enabled: true, endpoint: 'http://127.0.0.1:9999', wakeEnabled: mode === 'auto', autoSend: true, wakeWords: ['你好'] }))
    const inputText = ref('原有草稿'), handleSend = vi.fn()
    let speech!: ReturnType<typeof useChatSpeechInteraction>
    mountSession(() => { speech = useChatSpeechInteraction({ currentCharacter: ref(getCompanionCharacterConfig('nene')!),
      busy: ref(false), chatReady: ref(true), inputText, handleSend }) })
    await nextTick()
    if (mode === 'auto') fixture.onText('你好', 'auto')
    else speech.onSpeechPress()
    state.value = phase
    if (reason === 'hidden') {
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
      document.dispatchEvent(new Event('visibilitychange'))
    } else {
      vi.mocked(document.hasFocus).mockReturnValue(false)
      window.dispatchEvent(new Event('blur'))
    }
    await nextTick()
    expect(cancel).toHaveBeenCalled()
    expect(state.value).toBe('idle')
    fixture.onText('已经失去焦点的识别结果', mode)
    expect(inputText.value).toBe('原有草稿')
    expect(handleSend).not.toHaveBeenCalled()
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    vi.mocked(document.hasFocus).mockReturnValue(true)
    window.dispatchEvent(new Event('focus')); await nextTick()
    if (mode === 'manual') speech.onSpeechPress()
    expect(start).toHaveBeenLastCalledWith(mode)
    fixture.onText('恢复之后的新识别结果', mode)
    expect(inputText.value).toBe('恢复之后的新识别结果')
    expect(handleSend).toHaveBeenCalledOnce()
  })
  it('preserves each browser fallback draft when switching characters before the debounce completes', async () => {
    vi.useFakeTimers()
    desktopFixture.current = undefined
    try {
      setup(); await flushPromises()
      chat.inputText.value = '宁宁尚未自动保存的末尾'; chat.onInput()
      chat.switchCharacter('natsume'); await nextTick()
      chat.inputText.value = '夏目的另一份草稿'; chat.onInput()
      chat.switchCharacter('nene'); await nextTick()
      expect(chat.inputText.value).toBe('宁宁尚未自动保存的末尾')
      await vi.advanceTimersByTimeAsync(240)
      chat.switchCharacter('natsume'); await nextTick()
      expect(chat.inputText.value).toBe('夏目的另一份草稿')
    } finally { wrapper?.unmount(); wrapper = undefined; vi.useRealTimers() }
  })
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
  it.each(['desktop', 'chat', 'companion'])('%s waits through translation and playback before listening again', async entry => {
    const audios: EventTarget[] = []
    vi.stubGlobal('Audio', class extends EventTarget {
      src = ''; paused = true; ended = false
      constructor() { super(); audios.push(this) }
      play() { this.paused = false; return Promise.resolve() }
      pause() { this.paused = true }
      load() {}
      removeAttribute() { this.src = '' }
    })
    const busy = ref(false), voiceActive = ref(false), speaking = ref(false)
    const publish = () => { if (entry === 'desktop') live({ busy: busy.value, speaking: speaking.value, voiceActive: voiceActive.value }) }
    let translated!: (value: { translation: string }) => void
    fixture.voiceApi.getStatus.mockResolvedValue({ online: true, voices: { nene: true } })
    fixture.voiceApi.prepare.mockResolvedValue({})
    fixture.voiceApi.translate.mockImplementationOnce(() => new Promise(resolve => { translated = resolve }))
    voice = useVoice({ enabled: () => true,
      onActivity: active => { voiceActive.value = active; publish() },
      onSpeaking: active => { speaking.value = active; publish() } })
    await voice.refreshAvailability()
    const handleSend = vi.fn()
    let speech!: Pick<ReturnType<typeof useCompanionSpeechInput>,
      'onSpeechPress' | 'onSpeechRelease' | 'onSpeechSettingsSaved' | 'speechButtonDisabled'>
    if (entry === 'desktop') { setup(true, true); speech = chat }
    else {
      desktopFixture.current = undefined
      localStorage.setItem(SPEECH_INPUT_KEY, JSON.stringify({ ...DEFAULT_SPEECH_INPUT_CONFIG,
        enabled: true, endpoint: 'http://127.0.0.1:9999', wakeEnabled: true, autoSend: true, wakeWords: ['你好'] }))
      mountSession(() => {
        const common = { busy: computed(() => busy.value || voiceActive.value), chatReady: ref(true), inputText: ref(''), handleSend }
        speech = entry === 'chat'
          ? useChatSpeechInteraction({ ...common, currentCharacter: ref(getCompanionCharacterConfig('nene')!) })
          : useCompanionSpeechInput({ ...common, currentCharacter: ref('nene'), currentCharacterName: () => '宁宁',
          desktopWindowVisible: ref(true), dnd: ref(false), inQuietHours: ref(false), isEditableTarget: () => false })
      })
    }
    await nextTick()
    fixture.onText('你好', 'auto'); fixture.onText('今天怎么样', 'auto'); await flushPromises()
    busy.value = true; publish(); await nextTick()
    voice.startTurn({ mid: 'reply', voice: 'nene', character: 'nene' })
    voice.append('今天我们一起去公园散步吧。'); voice.finishTurn()
    busy.value = false; publish(); await flushPromises()
    expect(voiceActive.value).toBe(true); expect(speaking.value).toBe(false)
    expect(audios).toHaveLength(0); expect(autoListening.value).toBe(false)
    translated({ translation: '今日はお天気ですね。' }); await flushPromises()
    expect(speaking.value).toBe(true); expect(autoListening.value).toBe(false)
    const starts = start.mock.calls.length
    speech.onSpeechPress()
    expect(start).toHaveBeenCalledTimes(starts)
    expect(speech.speechButtonDisabled.value).toBe(true)
    audios[0].dispatchEvent(new Event('ended')); await flushPromises()
    expect(voiceActive.value).toBe(false); expect(autoListening.value).toBe(true)
    fixture.onText('再聊一句', 'auto'); await flushPromises()
    expect(entry === 'desktop' ? fixture.relay : handleSend).toHaveBeenCalledTimes(2)
    speech.onSpeechSettingsSaved({ ...DEFAULT_SPEECH_INPUT_CONFIG, enabled: true,
      endpoint: 'http://127.0.0.1:9999', wakeEnabled: false })
    await nextTick()
    expect(speech.speechButtonDisabled.value).toBe(false)
    speech.onSpeechPress(); await nextTick()
    expect(start).toHaveBeenLastCalledWith('manual')
    busy.value = true; publish(); await nextTick()
    if (entry === 'chat') expect(speech.speechButtonDisabled.value).toBe(false)
    speech.onSpeechRelease(); await nextTick()
    expect(state.value).toBe('idle')
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

  it.each(['companion', 'chat'].flatMap(entry => [false, true].map(wakeEnabled => ({ entry, wakeEnabled }))))(
    '$entry accepts repeated drafts and can restart with wake=$wakeEnabled', async ({ entry, wakeEnabled }) => {
    localStorage.setItem(SPEECH_INPUT_KEY, JSON.stringify({ ...DEFAULT_SPEECH_INPUT_CONFIG,
      enabled: true, endpoint: 'http://127.0.0.1:9999', autoSend: false, wakeEnabled, wakeWords: ['你好'] }))
    const inputText = ref('')
    const handleSend = vi.fn()
    let speech!: Pick<ReturnType<typeof useChatSpeechInteraction>, 'speechSessionActive'>
    mountSession(() => {
      const common = { busy: ref(false), chatReady: ref(true), inputText, handleSend }
      speech = entry === 'chat'
        ? useChatSpeechInteraction({ ...common, currentCharacter: ref(getCompanionCharacterConfig('nene')!) })
        : useCompanionSpeechInput({ ...common,
        currentCharacter: ref('nene'), currentCharacterName: () => '宁宁', desktopWindowVisible: ref(true),
        dnd: ref(false), inQuietHours: ref(false), isEditableTarget: () => false })
    })
    if (wakeEnabled) fixture.onText('你好', 'auto')
    fixture.onText('第一段', wakeEnabled ? 'auto' : 'manual'); await nextTick()
    fixture.onText('第二段', wakeEnabled ? 'auto' : 'manual'); await nextTick()
    expect.soft(inputText.value).toBe('第二段')
    fixture.onText('结束对话', 'manual'); await nextTick()
    expect.soft(speech.speechSessionActive.value).toBe(false)
    if (wakeEnabled) fixture.onText('你好', 'auto')
    fixture.onText('重新开始', wakeEnabled ? 'auto' : 'manual'); await nextTick()
    expect(inputText.value).toBe('重新开始')
    expect(handleSend).not.toHaveBeenCalled()
  })
})

const desktopFixture = vi.hoisted(() => ({ current: undefined as CompanionDesktopBridge | undefined }))
vi.mock('@/platform/desktop/capabilities', () => ({ getDesktopCapabilities: () => desktopFixture.current }))

describe('companion native window controls', () => {
  it('keeps the acknowledged dock choice over an old bootstrap response and coalesces clicks', async () => {
    let snapshot!: (value: boolean) => void, acknowledge!: (value: boolean) => void
    desktopFixture.current!.getChatDocked = vi.fn(() => new Promise<boolean>(resolve => { snapshot = resolve }))
    const setDocked = vi.fn(() => new Promise<boolean>(resolve => { acknowledge = resolve }))
    desktopFixture.current!.setChatDocked = setDocked
    setup()
    const pending = chat.toggleDock()
    await chat.toggleDock()
    expect(chat.docking.value).toBe(true)
    expect(setDocked).toHaveBeenCalledExactlyOnceWith(false)
    acknowledge(false); await pending
    snapshot(true); await flushPromises()
    expect(chat.docked.value).toBe(false)
    expect(chat.docking.value).toBe(false)
    setDocked.mockRejectedValueOnce(new Error('native rejected'))
    await chat.toggleDock()
    expect(chat.docked.value).toBe(false)
    expect(chat.docking.value).toBe(false)
    expect(chat.errorText.value).toContain('贴靠未能完成')
    setDocked.mockResolvedValueOnce(true)
    await chat.toggleDock()
    expect(chat.docked.value).toBe(true)
  })

  it('serializes undocking before dragging and never starts a late drag after unmount', async () => {
    let acknowledge!: (value: boolean) => void
    const setDocked = vi.fn(() => new Promise<boolean>(resolve => { acknowledge = resolve }))
    const drag = vi.fn().mockResolvedValue(undefined)
    desktopFixture.current!.setChatDocked = setDocked
    desktopFixture.current!.startDragging = drag
    setup(); await flushPromises()
    const pending = chat.startWindowDrag(new MouseEvent('mousedown', { button: 0 }))
    await chat.toggleDock()
    await chat.startWindowDrag(new MouseEvent('mousedown', { button: 0 }))
    expect(setDocked).toHaveBeenCalledExactlyOnceWith(false)
    expect(drag).not.toHaveBeenCalled()
    wrapper!.unmount(); wrapper = undefined
    acknowledge(false); await pending
    expect(drag).not.toHaveBeenCalled()
    expect(chat.docked.value).toBe(true)
  })
})
