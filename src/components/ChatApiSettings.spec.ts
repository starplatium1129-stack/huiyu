import { ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, expect, it, vi } from 'vitest'
import ChatApiSettings from './ChatApiSettings.vue'
import StudioSelect from './ui/StudioSelect.vue'
import { chatApi } from '@/api/chatApi'
import type { ChatApiDraft } from '@/utils/chatApiDrafts'

const clearDraft = vi.hoisted(() => vi.fn())
vi.mock('@/api/chatApi', () => ({ chatApi: { testProvider: vi.fn() } }))
vi.mock('@/utils/chatApiDrafts', () => ({ createChatApiDrafts: () => {
  const drafts = ref<Record<string, ChatApiDraft>>({})
  return { drafts, set: (vendor: string, draft: ChatApiDraft) => { drafts.value[vendor] = { ...draft } }, clear: clearDraft }
} }))
beforeEach(() => { vi.mocked(chatApi.testProvider).mockReset(); clearDraft.mockReset() })
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
    expect(wrapper.find('.api-discovered-models').exists()).toBe(false)
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

it('does not clear a different vendor after an earlier draft removal completes', async () => {
  let finish!: () => void
  clearDraft.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
  const wrapper = mount(ChatApiSettings, { props: { vendor: 'custom', baseUrl: 'https://example.test', model: 'first', apiKey: '', hint: '' },
    global: { stubs: { ArchiveIcon: true, StudioSelect: true } } })
  try {
    const clear = wrapper.findAll('button').find(button => button.text() === '清除个人密钥')!
    await clear.trigger('click')
    expect(clear.attributes('disabled')).toBeDefined()
    expect(clear.text()).toBe('清除中…')
    await wrapper.setProps({ vendor: 'deepseek', baseUrl: 'https://other.example.test', model: 'second' })
    finish(); await flushPromises()
    expect(wrapper.emitted('clear-key')).toBeUndefined()
    expect(wrapper.emitted('update:apiKey')).toBeUndefined()
    expect(clear.attributes('disabled')).toBeUndefined()
  } finally { wrapper.unmount() }
})

it('isolates provider credentials, restores each draft, and leaves the active provider unchanged', async () => {
  const wrapper = mount(ChatApiSettings, { props: { vendor: 'custom', baseUrl: 'https://custom.example.test/v1', model: 'custom-model', apiKey: 'custom-fixture-key' },
    global: { stubs: { ArchiveIcon: true, StudioSelect: true } } })
  async function choose(vendor: 'custom' | 'deepseek' | 'opencode') {
    await wrapper.get(`[data-vendor="${vendor}"]`).trigger('click')
    await wrapper.setProps({
      vendor,
      baseUrl: wrapper.emitted('update:baseUrl')!.at(-1)![0] as string,
      model: wrapper.emitted('update:model')!.at(-1)![0] as string,
      apiKey: wrapper.emitted('update:apiKey')!.at(-1)![0] as string,
    })
  }
  try {
    await wrapper.get('[data-vendor="custom"]').trigger('click')
    expect(wrapper.emitted('update:baseUrl')).toBeUndefined()
    expect(wrapper.emitted('update:model')).toBeUndefined()
    expect(wrapper.emitted('update:apiKey')).toBeUndefined()
    await wrapper.get('.api-key-field button').trigger('click')
    await choose('deepseek')
    expect(wrapper.props('apiKey')).toBe('')
    expect(wrapper.get('.api-key-field input').attributes('type')).toBe('password')
    await wrapper.setProps({ baseUrl: 'https://deepseek.example.test/v1', model: 'edited-deepseek', apiKey: 'deepseek-fixture-key' })
    const modelChanges = wrapper.emitted('update:model')!.length
    await wrapper.get('[data-vendor="deepseek"]').trigger('click')
    expect(wrapper.emitted('update:model')).toHaveLength(modelChanges)
    await choose('opencode')
    expect(wrapper.props('apiKey')).toBe('')
    await choose('deepseek')
    expect(wrapper.props()).toMatchObject({ baseUrl: 'https://deepseek.example.test/v1', model: 'edited-deepseek', apiKey: 'deepseek-fixture-key' })
    await choose('custom')
    expect(wrapper.props()).toMatchObject({ baseUrl: 'https://custom.example.test/v1', model: 'custom-model', apiKey: 'custom-fixture-key' })
  } finally { wrapper.unmount() }
})

it('keeps discovered models while editing or selecting a model, and discards them when credentials change', async () => {
  vi.mocked(chatApi.testProvider).mockResolvedValue({ ok: true, models: ['first', 'other', 'other', ' '] })
  const wrapper = mount(ChatApiSettings, { props: { vendor: 'custom', baseUrl: 'https://custom.example.test/v1', model: 'first', apiKey: '' },
    global: { stubs: { ArchiveIcon: true, StudioSelect: true } } })
  try {
    await wrapper.findAll('button').find(button => button.text() === '测试连接')!.trigger('click')
    await flushPromises()
    const choices = wrapper.getComponent(StudioSelect)
    expect(choices.props('options')).toEqual([{ value: 'first', label: 'first' }, { value: 'other', label: 'other' }])
    expect(wrapper.find('datalist').exists()).toBe(false)
    await wrapper.get('input[aria-label="模型名"]').setValue('my-private-model')
    await wrapper.setProps({ model: 'my-private-model' })
    expect(choices.props('options')).toHaveLength(2)
    expect(wrapper.find('.api-test-status').text()).not.toContain('连接成功')
    choices.vm.$emit('update:modelValue', 'other')
    expect(wrapper.emitted('update:model')!.at(-1)).toEqual(['other'])
    await wrapper.setProps({ model: 'other' })
    expect(choices.props('options')).toHaveLength(2)
    await wrapper.setProps({ apiKey: 'replacement-fixture-key' })
    expect(wrapper.find('.api-discovered-models').exists()).toBe(false)
  } finally { wrapper.unmount() }
})

it('autofills a new official provider without carrying a key and keeps arbitrary saved model IDs editable', async () => {
  const wrapper = mount(ChatApiSettings, { props: { vendor: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'legacy-private-model', apiKey: 'fixture-secret' }, global: { stubs: { ArchiveIcon: true, StudioSelect: true } } })
  try {
    expect(wrapper.get<HTMLInputElement>('input[aria-label="模型名"]').element.value).toBe('legacy-private-model')
    expect(wrapper.get('input[aria-label="API Key"]').attributes('type')).toBe('password')
    await wrapper.get('[data-vendor="openai"]').trigger('click')
    expect(wrapper.emitted('update:baseUrl')!.at(-1)).toEqual(['https://api.openai.com/v1'])
    expect(wrapper.emitted('update:model')!.at(-1)).toEqual(['gpt-6-luna'])
    expect(wrapper.emitted('update:apiKey')!.at(-1)).toEqual([''])
    await wrapper.setProps({ vendor: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-luna', apiKey: '' })
    expect(wrapper.findAll('a').some(a => a.attributes('href') === 'https://platform.openai.com/api-keys')).toBe(true)
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined()
  } finally { wrapper.unmount() }
})

it('discovers local models without a model or key and distinguishes empty or mismatched catalogs', async () => {
  vi.mocked(chatApi.testProvider).mockResolvedValueOnce({ ok: true, models: [] })
    .mockResolvedValueOnce({ ok: true, models: ['installed-chat'] })
  const wrapper = mount(ChatApiSettings, { props: { vendor: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', model: '', apiKey: '' }, global: { stubs: { ArchiveIcon: true, StudioSelect: true } } })
  const test = () => wrapper.findAll('button').find(button => /测试连接|测试中/.test(button.text()))!
  try {
    expect(test().attributes('disabled')).toBeUndefined()
    expect(wrapper.text()).toContain('Developer')
    await test().trigger('click'); await flushPromises()
    expect(vi.mocked(chatApi.testProvider).mock.calls[0]![0]).toMatchObject({ model: '', apiKey: '' })
    expect(wrapper.get('.api-test-status').attributes('data-state')).toBe('warning')
    expect(wrapper.text()).toContain('模型列表为空')
    await wrapper.setProps({ model: 'not-installed' })
    await test().trigger('click'); await flushPromises()
    expect(wrapper.get('.api-test-status').attributes('data-state')).toBe('warning')
    wrapper.getComponent(StudioSelect).vm.$emit('update:modelValue', 'installed-chat')
    expect(wrapper.emitted('update:model')!.at(-1)).toEqual(['installed-chat'])
    await wrapper.setProps({ model: 'installed-chat' })
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeUndefined()
  } finally { wrapper.unmount() }
})

it('blocks credential-bearing URLs and reports actionable failures without rendering upstream secrets', async () => {
  const { ApiClientError } = await import('@/api/client')
  const wrapper = mount(ChatApiSettings, { props: { vendor: 'custom', baseUrl: 'https://example.test/v1?key=fixture', model: 'chat', apiKey: '' }, global: { stubs: { ArchiveIcon: true, StudioSelect: true } } })
  const test = () => wrapper.findAll('button').find(button => /测试连接|测试中/.test(button.text()))!
  try {
    expect(test().attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('地址不能带账号')
    await wrapper.setProps({ baseUrl: 'https://example.test/v1' })
    for (const [status, text] of [[401, '密钥校验失败'], [429, '额度受限'], [404, '模型目录不可用']] as const) {
      vi.mocked(chatApi.testProvider).mockRejectedValueOnce(new ApiClientError('SECRET_ECHO', { kind: 'http', status, detail: 'SECRET_ECHO' }))
      await test().trigger('click'); await flushPromises()
      expect(wrapper.get('.api-test-status').text()).toContain(text)
      expect(wrapper.text()).not.toContain('SECRET_ECHO')
    }
  } finally { wrapper.unmount() }
})
