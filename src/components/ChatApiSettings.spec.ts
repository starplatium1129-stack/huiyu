import { ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { expect, it, vi } from 'vitest'
import ChatApiSettings from './ChatApiSettings.vue'
import { chatApi } from '@/api/chatApi'

vi.mock('@/api/chatApi', () => ({ chatApi: { testProvider: vi.fn() } }))
vi.mock('@/utils/chatApiDrafts', () => ({ createChatApiDrafts: () => ({ drafts: ref({}), set: vi.fn(), clear: vi.fn() }) }))
it('ignores replaced draft results, owns the newer busy state and aborts on unmount', async () => {
  const pending: Array<{ resolve: (value: { ok: true; models: string[] }) => void; reject: (reason: Error) => void }> = []
  vi.mocked(chatApi.testProvider).mockImplementation(() => new Promise((resolve, reject) => { pending.push({ resolve, reject }) }))
  const wrapper = mount(ChatApiSettings, { props: { vendor: 'custom', baseUrl: 'https://example.test/v1', model: 'first', apiKey: '', hint: '' },
    global: { stubs: { ArchiveIcon: true, StudioSelect: true } } })
  const testButton = () => wrapper.findAll('button').find(button => /测试连接|测试中/.test(button.text()))!
  try {
    await testButton().trigger('click')
    const firstSignal = vi.mocked(chatApi.testProvider).mock.calls[0]![1]!.signal!
    await wrapper.setProps({ baseUrl: 'https://other.example.test/v1', model: 'second' })
    expect(firstSignal.aborted).toBe(true)
    await testButton().trigger('click')
    pending[0]!.resolve({ ok: true, models: ['stale-model'] }); await flushPromises()
    expect(testButton().attributes('disabled')).toBeDefined()
    expect(wrapper.findAll('datalist option')).toHaveLength(0)
    pending[1]!.reject(new Error('UNTRUSTED_PROVIDER_DETAIL')); await flushPromises()
    expect(wrapper.text()).not.toContain('UNTRUSTED_PROVIDER_DETAIL')
    expect(wrapper.text()).toContain('连接测试失败')
    await testButton().trigger('click')
    const lastSignal = vi.mocked(chatApi.testProvider).mock.calls[2]![1]!.signal!
    wrapper.unmount()
    expect(lastSignal.aborted).toBe(true)
    pending[2]!.resolve({ ok: true, models: ['late'] }); await flushPromises()
  } finally { if (wrapper.exists()) wrapper.unmount() }
})
