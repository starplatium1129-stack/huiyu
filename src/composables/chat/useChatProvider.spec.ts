import { effectScope, nextTick, reactive, ref } from 'vue'
import { expect, it, vi } from 'vitest'
import { chatApi } from '@/api/chatApi'
import { useChatProvider } from './useChatProvider'
import { useChatStorage } from './useChatStorage'
import { STORAGE_KEY } from '@/config/characters'
import { flushPromises } from '@vue/test-utils'
import type { CompanionDesktopBridge } from '@/types/desktop'

const desktopFixture = vi.hoisted(() => ({ current: undefined as CompanionDesktopBridge | undefined }))
vi.mock('@/platform/desktop/capabilities.ts', () => ({ getDesktopCapabilities: () => desktopFixture.current }))
vi.mock('@/storage/chatArchiveRepository', () => ({ readChatArchive: async () => ({ version: 1, archived: {}, revisions: {} }), writeChatArchive: vi.fn(), withChatArchiveMutation: async (work: () => unknown) => work() }))

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
