import { effectScope, h, nextTick, reactive, ref } from 'vue'
import { expect, it, vi } from 'vitest'
import { chatApi } from '@/api/chatApi'
import { useChatProvider } from './useChatProvider'
import { useChatStorage } from './useChatStorage'
import { STORAGE_KEY } from '@/config/characters'
import { mount, flushPromises } from '@vue/test-utils'
import { createChatApiDrafts, rememberSavedChatApiDraft, CHAT_API_DRAFTS_KEY } from '@/utils/chatApiDrafts'
import type { CompanionDesktopBridge } from '@/types/desktop'

const archiveFixture = vi.hoisted(() => ({ gate: undefined as Promise<void> | undefined }))
const desktopFixture = vi.hoisted(() => ({ current: undefined as CompanionDesktopBridge | undefined }))
vi.mock('@/platform/desktop/capabilities.ts', () => ({ getDesktopCapabilities: () => desktopFixture.current }))
vi.mock('@/storage/chatArchiveRepository', () => ({ readChatArchive: async () => { await archiveFixture.gate; return { version: 1, archived: {}, revisions: {} } }, writeChatArchive: vi.fn(), withChatArchiveMutation: async (work: () => unknown) => work() }))

vi.mock('@/api/chatApi', () => ({ chatApi: { getStatus: vi.fn(), getHostConfig: vi.fn(), clearHostConfig: vi.fn(), saveHostConfig: vi.fn() } }))
it('reports only acknowledged host removal and rejects pre-acknowledgement reads', async () => {
  const scope = effectScope()
  const provider = scope.run(() => useChatProvider({ isBusy: ref(false), storage: {
    state: { settings: { provider: 'api', model: '', apiBaseUrl: 'https://example.test', apiModel: 'model', apiKey: '' } },
    neverConfigured: ref(true),
  } as never }))!
  try {
    vi.mocked(chatApi.getHostConfig).mockResolvedValue({ configured: true, model: 'host-model', baseUrl: 'https://example.test' })
    await provider.refreshHostConfig()
    vi.mocked(chatApi.clearHostConfig).mockRejectedValueOnce(new Error('transport unavailable'))
    expect(await provider.clearHostConfig()).toBe(false)
    expect(provider.hostApiConfigured.value).toBe(true)
    let publish!: (value: { configured: true; model: string; baseUrl: string }) => void
    vi.mocked(chatApi.getHostConfig).mockImplementationOnce(() => new Promise(resolve => { publish = resolve }))
    const pending = provider.refreshHostConfig()
    vi.mocked(chatApi.clearHostConfig).mockResolvedValueOnce({ ok: true, configured: false })
    expect(await provider.clearHostConfig()).toBe(true)
    publish({ configured: true, model: 'stale', baseUrl: 'https://example.test' })
    await pending
    expect(provider.hostApiConfigured.value).toBe(false)
    expect(provider.hostApiModel.value).toBe('')
    expect(provider.hostApiBaseUrl.value).toBe('')
  } finally { scope.stop() }
})

it('keeps a newer personal editor intact when old save or clear work completes', async () => {
  const scope = effectScope()
  const state = reactive({ settings: { provider: 'api', model: '', apiBaseUrl: 'https://example.test', apiModel: 'first', apiKey: 'fixture-a' } })
  let finish!: () => void
  const setApiSettings = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  const provider = scope.run(() => useChatProvider({ isBusy: ref(false), storage: { state, setApiSettings, neverConfigured: ref(false) } as never }))!
  try {
    provider.apiSettingsOpen.value = true
    const save = provider.saveApiSettings()
    provider.apiModel.value = 'new-draft'
    provider.apiKey.value = 'fixture-b'
    state.settings.apiKey = 'stored-old-result'
    await nextTick()
    finish(); await save
    expect(provider.apiSettingsOpen.value).toBe(true)
    expect(provider.apiModel.value).toBe('new-draft')
    expect(provider.apiKey.value).toBe('fixture-b')
    expect(provider.apiConfigHint.value).toBe('')
    const clear = provider.clearApiCredential()
    provider.apiBaseUrl.value = 'https://other.example.test'
    provider.apiKey.value = 'fixture-c'
    state.settings.apiKey = ''
    await nextTick()
    finish(); await clear
    expect(provider.apiKey.value).toBe('fixture-c')
    expect(provider.apiConfigHint.value).toBe('')
    const current = provider.clearApiCredential()
    finish(); await current
    expect(provider.apiKey.value).toBe('')
    expect(provider.apiConfigHint.value).toBe('个人密钥已清除。')
    let finishA!: () => void, finishB!: () => void
    setApiSettings.mockImplementationOnce(() => new Promise(resolve => { finishA = resolve }))
      .mockImplementationOnce(() => new Promise(resolve => { finishB = resolve }))
    provider.apiVendor.value = 'custom'; provider.apiBaseUrl.value = 'https://api.deepseek.com'; provider.apiModel.value = 'A'
    const a = provider.saveApiSettings()
    provider.apiVendor.value = 'deepseek'; provider.apiBaseUrl.value = 'https://proxy.example.test'; provider.apiModel.value = 'B'; provider.apiKey.value = 'fixture-B'
    const b = provider.saveApiSettings()
    Object.assign(state.settings, { apiBaseUrl: provider.apiBaseUrl.value, apiModel: 'B', apiKey: 'fixture-B' })
    finishB(); await b; finishA(); await a; await nextTick()
    state.settings.apiModel = 'remote-after-B'; await nextTick()
    expect(provider.apiModel.value).toBe('remote-after-B')
    expect(provider.apiVendor.value).toBe('deepseek')

  } finally { scope.stop() }
})

it.each(['success', 'failure'])('a disposed provider releases reads without publishing late %s or persisting a fallback model', async outcome => {
  vi.mocked(chatApi.getStatus).mockReset()
  vi.mocked(chatApi.getHostConfig).mockReset()
  let finishStatus!: (value: { online: boolean; model: string; models: { name: string }[] }) => void
  let finishHost!: (value: { configured: true; model: string; baseUrl: string }) => void
  let failStatus!: (error: Error) => void, failHost!: (error: Error) => void
  vi.mocked(chatApi.getStatus).mockImplementation(() => new Promise((resolve, reject) => { finishStatus = resolve; failStatus = reject }))
  vi.mocked(chatApi.getHostConfig).mockImplementation(() => new Promise((resolve, reject) => { finishHost = resolve; failHost = reject }))
  const scope = effectScope(), setModel = vi.fn()
  const provider = scope.run(() => useChatProvider({ isBusy: ref(false), storage: {
    state: { settings: { provider: 'local', model: 'selected', apiBaseUrl: '', apiModel: '', apiKey: '' } },
    setModel, neverConfigured: ref(false),
  } as never }))!
  try {
    provider.models.value = [{ name: 'selected' }]
    provider.ollamaOnline.value = true
    provider.hostApiConfigured.value = true
    provider.hostApiModel.value = 'selected-host'
    const pending = [provider.refreshChatStatus(), provider.refreshHostConfig()]
    scope.stop()
    if (outcome === 'success') {
      finishStatus({ online: true, model: 'late-model', models: [{ name: 'late-model' }] })
      finishHost({ configured: true, model: 'late-host', baseUrl: 'https://example.test' })
    } else {
      failStatus(new Error('cancelled')); failHost(new Error('cancelled'))
    }
    await Promise.all(pending)
    expect({ model: provider.currentModel.value, models: provider.models.value,
      online: provider.ollamaOnline.value, host: provider.hostApiConfigured.value,
      hostModel: provider.hostApiModel.value, writes: setModel.mock.calls }).toEqual({
      model: 'selected', models: [{ name: 'selected' }], online: true, host: true, hostModel: 'selected-host', writes: [],
    })
    const statusSignal = vi.mocked(chatApi.getStatus).mock.calls[0]![0]?.signal
    const hostSignal = vi.mocked(chatApi.getHostConfig).mock.calls[0]![0]?.signal
    expect(statusSignal?.aborted).toBe(true)
    expect(hostSignal).toBe(statusSignal)
    await provider.refreshChatStatus(); await provider.refreshHostConfig()
    expect(chatApi.getStatus).toHaveBeenCalledOnce()
    expect(chatApi.getHostConfig).toHaveBeenCalledOnce()
  } finally { scope.stop() }
})

it('rehydrates cross-window connections, defers an event during model writes, and preserves an edited draft during secure reads', async () => {
  localStorage.clear()
  let saved = 'neutral-first', blocked: Promise<void> | undefined
  let readGate: Promise<string> | undefined
  const secureWrite = vi.fn(async (_endpoint: string, secret: string) => { saved = secret })
  desktopFixture.current = { readChatCredential: async () => readGate || saved, writeChatCredential: secureWrite } as unknown as CompanionDesktopBridge
  const lockDescriptor = Object.getOwnPropertyDescriptor(navigator, 'locks')
  let queue = Promise.resolve()
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (_name: string, work: () => unknown) => {
    const waiting = blocked
    const next = queue.then(async () => { await waiting; return work() }); queue = next.then(() => undefined, () => undefined); return next
  } } })
  const scope = effectScope()
  const storage = scope.run(() => useChatStorage())!
  let provider!: ReturnType<typeof useChatProvider>
  const peer = (revision: string, model: string) => {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY)!)
    value.settings.apiSettingsRevision = revision; value.settings.apiModel = model
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  }
  try {
    await storage.setApiSettings({ baseUrl: 'https://example.test', model: 'first', apiKey: saved })
    provider = scope.run(() => useChatProvider({ storage, isBusy: ref(false) }))!
    storage.setDraft('nene', 'local message draft')
    const history = storage.state.histories.nene
    saved = 'neutral-peer'; peer('peer-1', 'first')
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, storageArea: localStorage }))
    await flushPromises()
    expect(provider.apiKey.value).toBe('neutral-peer')
    expect(storage.state.histories.nene).toBe(history)
    expect(storage.draft('nene')).toBe('local message draft')
    let release!: () => void
    blocked = new Promise(resolve => { release = resolve })
    provider.apiModel.value = 'canonical'
    const modelWrite = storage.setApiSettings({ baseUrl: provider.apiBaseUrl.value, model: 'canonical', apiKey: provider.apiKey.value }, 'model')
    await nextTick()
    saved = 'neutral-next'; peer('peer-2', 'peer-model')
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }))
    await flushPromises()
    blocked = undefined; release(); await modelWrite; await flushPromises()
    expect(provider.apiModel.value).toBe('peer-model')
    expect(provider.apiKey.value).toBe('neutral-next')
    expect(secureWrite).toHaveBeenCalledOnce()
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).settings.apiSettingsRevision).toBe('peer-2')
    let finishRead!: (secret: string) => void
    readGate = new Promise(resolve => { finishRead = resolve })
    peer('peer-3', 'remote-newer')
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }))
    await flushPromises()
    provider.apiModel.value = 'unsaved-model'; provider.apiKey.value = 'unsaved-key'
    finishRead('remote-key'); await flushPromises()
    expect(provider.apiModel.value).toBe('unsaved-model')
    expect(provider.apiKey.value).toBe('unsaved-key')
    expect(storage.state.settings.apiModel).toBe('remote-newer')
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain('remote-key')
  } finally {
    scope.stop(); desktopFixture.current = undefined; localStorage.clear()
    if (lockDescriptor) Object.defineProperty(navigator, 'locks', lockDescriptor)
    else Reflect.deleteProperty(navigator, 'locks')
  }
})

it('recognizes new provider bindings and distinguishes an empty Ollama service from a stopped service', async () => {
  const scope = effectScope()
  const state = reactive({ settings: { provider: 'local', model: '', apiBaseUrl: 'http://127.0.0.1:1234/v1', apiModel: 'installed-chat', apiKey: '' } })
  const provider = scope.run(() => useChatProvider({ isBusy: ref(false), storage: { state, setModel: vi.fn(), neverConfigured: ref(false) } as never }))!
  try {
    expect(provider.apiVendor.value).toBe('lmstudio')
    expect(provider.apiConfigured.value).toBe(true)
    vi.mocked(chatApi.getStatus).mockResolvedValueOnce({ online: true, model: '', models: [] })
    await provider.refreshChatStatus()
    expect(provider.ollamaOnline.value).toBe(false)
    expect(provider.localStatusText.value).toContain('已启动，但没有可用聊天模型')
    vi.mocked(chatApi.getStatus).mockResolvedValueOnce({ online: false, model: '', models: [] })
    await provider.refreshChatStatus()
    expect(provider.localStatusText.value).toContain('启动 Ollama')
    expect(provider.checkingChatStatus.value).toBe(false)
  } finally { scope.stop() }
})


it('only treats the selected personal or host route as ready and reopens invalid personal settings', async () => {
  const scope = effectScope()
  const neverConfigured = ref(false)
  const state = reactive({ settings: { provider: 'local', model: '', apiBaseUrl: 'https://api.deepseek.com', apiModel: 'saved-model', apiKey: '' } })
  const provider = scope.run(() => useChatProvider({ isBusy: ref(false), storage: {
    state, neverConfigured, setProvider: (value: string) => { state.settings.provider = value },
    setApiSettings: async (value: { apiKey: string }) => { state.settings.apiKey = value.apiKey; neverConfigured.value = false },
  } as never }))!
  try {
    provider.hostApiConfigured.value = true
    provider.setChatProvider('api')
    expect(provider.useHostConfig.value).toBe(false)
    expect(provider.chatReady.value).toBe(false)
    expect(provider.apiSettingsOpen.value).toBe(true)
    expect(provider.statusKind.value).toBe('')
    provider.apiKey.value = 'neutral-personal-key'
    expect(provider.chatReady.value).toBe(true)
    await provider.clearApiCredential()
    expect(provider.chatReady.value).toBe(false)
    provider.setBusy(false)
    expect(provider.statusKind.value).toBe('')
    expect(provider.apiBaseUrl.value).toBe('https://api.deepseek.com')
    neverConfigured.value = true
    expect(provider.useHostConfig.value).toBe(true)
    expect(provider.chatReady.value).toBe(true)
  } finally { scope.stop() }
})


it.each(['edited', 'cleared'])('does not replace a newer provider draft when an earlier save completes (%s)', async action => {
  localStorage.clear()
  const original = { baseUrl: 'https://neutral-save-race.example/v1', model: 'original-model', apiKey: 'neutral-original-key' }
  await rememberSavedChatApiDraft('custom', original)
  const editor = createChatApiDrafts(vi.fn()); await editor.ready
  const scope = effectScope()
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  const state = reactive({ settings: { provider: 'api', model: '', apiBaseUrl: original.baseUrl, apiModel: original.model, apiKey: original.apiKey } })
  const provider = scope.run(() => useChatProvider({ isBusy: ref(false), storage: {
    state, neverConfigured: ref(false), setApiSettings: async () => { await gate },
  } as never }))!
  try {
    const pending = provider.saveApiSettings()
    const expected = action === 'edited' ? { ...original, model: 'newer-model', apiKey: 'neutral-newer-key' }
      : { ...original, apiKey: '', keyCleared: true as const }
    if (action === 'edited') {
      provider.apiModel.value = expected.model; provider.apiKey.value = expected.apiKey
      editor.set('custom', expected)
    } else await editor.clear('custom', original)
    // Switching out publishes the new draft, but is not another save request.
    provider.apiVendor.value = 'openai'; provider.apiBaseUrl.value = 'https://api.openai.com/v1'
    provider.apiModel.value = 'other-model'; provider.apiKey.value = 'neutral-other-key'
    finish(); await pending
    const reopened = createChatApiDrafts(vi.fn()); await reopened.ready
    expect(editor.drafts.value.custom).toEqual(expected)
    expect(reopened.drafts.value.custom).toEqual(expected)
    expect(JSON.parse(localStorage.getItem(CHAT_API_DRAFTS_KEY)!).custom.model).toBe(expected.model)
    expect(localStorage.getItem(CHAT_API_DRAFTS_KEY)).not.toContain(original.apiKey)
    expect(localStorage.getItem(CHAT_API_DRAFTS_KEY)).not.toContain('neutral-newer-key')
    expect(provider.apiModel.value).toBe('other-model')
    expect(state.settings.apiKey).toBe(original.apiKey)
  } finally { scope.stop(); localStorage.clear() }
})


it.each(['success', 'failure', 'disposed'])('guards provider switching during actual credential hydration (%s)', async outcome => {
  const { default: ChatApiSettings } = await import('@/components/ChatApiSettings.vue')
  localStorage.clear()
  const saved = { baseUrl: 'https://neutral-hydration.example/v1', model: 'saved-model', apiKey: 'neutral-saved-key' }
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 3, settings: {
    provider: 'api', apiBaseUrl: saved.baseUrl, apiModel: saved.model, apiKey: '', apiConfiguredByUser: true,
  }, histories: {} }))
  localStorage.setItem(CHAT_API_DRAFTS_KEY, JSON.stringify({ custom: { baseUrl: saved.baseUrl, model: saved.model } }))
  let release!: () => void, failRead = false
  archiveFixture.gate = new Promise<void>(resolve => { release = resolve })
  const secureRead = vi.fn(async (endpoint: string) => {
    if (failRead) throw new Error('neutral-read-failure')
    return endpoint === saved.baseUrl ? saved.apiKey : null
  })
  desktopFixture.current = { readChatCredential: secureRead, writeChatCredential: vi.fn() } as unknown as CompanionDesktopBridge
  const lockDescriptor = Object.getOwnPropertyDescriptor(navigator, 'locks')
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_name: string, work: () => unknown) => work() } })
  const scope = effectScope(), onError = vi.fn(), showing = ref(true)
  const storage = scope.run(() => useChatStorage(onError))!
  const loading = storage.load()
  const provider = scope.run(() => useChatProvider({ storage, isBusy: ref(false) }))!
  const wrapper = mount({ setup: () => () => showing.value ? h(ChatApiSettings, {
    vendor: provider.apiVendor.value, baseUrl: provider.apiBaseUrl.value, model: provider.apiModel.value,
    apiKey: provider.apiKey.value, credentialsLoading: storage.credentialsLoading.value,
    'onUpdate:vendor': value => { provider.apiVendor.value = value },
    'onUpdate:baseUrl': value => { provider.apiBaseUrl.value = value },
    'onUpdate:model': value => { provider.apiModel.value = value },
    'onUpdate:apiKey': value => { provider.apiKey.value = value },
  }) : null }, { global: { stubs: { ArchiveIcon: true, StudioSelect: true } } })
  try {
    await flushPromises()
    expect(storage.credentialsLoading.value).toBe(true)
    expect(provider.apiKey.value).toBe('')
    expect(secureRead).toHaveBeenCalledWith(saved.baseUrl)
    const other = wrapper.get('[data-vendor="openai"]')
    expect(other.attributes('disabled')).toBeDefined()
    other.element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(provider.apiVendor.value).toBe('custom')
    if (outcome === 'disposed') { wrapper.unmount(); scope.stop() }
    if (outcome === 'failure') failRead = true
    release(); await loading; await flushPromises()
    expect(storage.credentialsLoading.value).toBe(false)
    if (outcome === 'disposed') return
    expect(wrapper.get('[data-vendor="openai"]').attributes('disabled')).toBeUndefined()
    if (outcome === 'failure') { expect(onError).toHaveBeenCalled(); return }
    expect(provider.apiKey.value).toBe(saved.apiKey)
    const roundTrip = async () => {
      await wrapper.get('[data-vendor="openai"]').trigger('click'); await flushPromises()
      await wrapper.get('[data-vendor="custom"]').trigger('click'); await flushPromises()
    }
    await roundTrip()
    expect(provider.apiKey.value).toBe(saved.apiKey)
    await wrapper.get('input[aria-label="API Key"]').setValue('')
    showing.value = false; await nextTick(); showing.value = true; await flushPromises()
    await roundTrip()
    expect(provider.apiKey.value).toBe('')
  } finally {
    release(); await loading; if (wrapper.exists()) wrapper.unmount(); scope.stop()
    archiveFixture.gate = undefined; desktopFixture.current = undefined; localStorage.clear()
    if (lockDescriptor) Object.defineProperty(navigator, 'locks', lockDescriptor)
    else Reflect.deleteProperty(navigator, 'locks')
  }
})
