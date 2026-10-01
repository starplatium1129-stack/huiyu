import { effectScope, ref } from 'vue'
import { expect, it, vi } from 'vitest'
import { chatApi } from '@/api/chatApi'
import { useChatProvider } from './useChatProvider'

vi.mock('@/api/chatApi', () => ({ chatApi: { getHostConfig: vi.fn(), clearHostConfig: vi.fn(), saveHostConfig: vi.fn() } }))
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
