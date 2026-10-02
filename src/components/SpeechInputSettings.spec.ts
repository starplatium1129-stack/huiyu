import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, expect, it, vi } from 'vitest'
import SpeechInputSettings from './SpeechInputSettings.vue'
import { saveSpeechInputConfig } from '@/utils/speechInputConfig'
import { flushProfileWrites } from '@/platform/web/profileStorage'

vi.mock('@/platform/web/profileStorage', () => ({ profileLocalStorage: window.localStorage, flushProfileWrites: vi.fn() }))

vi.mock('@/utils/speechInputConfig', async importOriginal => {
  const actual = await importOriginal<typeof import('@/utils/speechInputConfig')>()
  return { ...actual, loadSpeechInputConfig: () => actual.normalizeSpeechInputConfig(null), saveSpeechInputConfig: vi.fn() }
})

beforeEach(() => {
  vi.mocked(saveSpeechInputConfig).mockReset()
  vi.mocked(flushProfileWrites).mockReset().mockResolvedValue(undefined)
})

it('keeps the speech draft visible after a failed save and allows a successful retry', async () => {
  vi.mocked(saveSpeechInputConfig).mockImplementationOnce(() => { throw new Error('fixture storage denied') })
  const wrapper = mount(SpeechInputSettings, { global: { stubs: { ToggleSwitch: true } } })
  try {
    const endpoint = wrapper.find('input[type="url"]')
    const model = wrapper.find('input[aria-label="识别模型"]')
    await endpoint.setValue('https://speech.example.test/v1')
    await model.setValue('fixture-model')
    await wrapper.find('form').trigger('submit')
    expect(wrapper.emitted('save')).toBeUndefined()
    expect(wrapper.find('[role="status"]').text()).toContain('配置保存尚未确认')
    expect((endpoint.element as HTMLInputElement).value).toBe('https://speech.example.test/v1')
    expect((model.element as HTMLInputElement).value).toBe('fixture-model')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(saveSpeechInputConfig).toHaveBeenCalledTimes(2)
    expect(vi.mocked(saveSpeechInputConfig).mock.calls[1]?.[0]).toMatchObject({
      endpoint: 'https://speech.example.test/v1', model: 'fixture-model',
    })
    expect(wrapper.emitted('save')).toHaveLength(1)
  } finally { wrapper.unmount() }
})

it('waits for durable confirmation and keeps newer word edits visible until they are saved', async () => {
  let fail!: (error: Error) => void
  vi.mocked(flushProfileWrites).mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject }))
  const wrapper = mount(SpeechInputSettings)
  try {
    const endpoint = wrapper.find('input[type="url"]')
    await endpoint.setValue('https://speech.example.test/v1')
    await wrapper.find('form').trigger('submit')
    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeDefined()
    expect(wrapper.emitted('save')).toBeUndefined()
    await wrapper.find('form').trigger('submit')
    expect(saveSpeechInputConfig).toHaveBeenCalledOnce()
    expect(flushProfileWrites).toHaveBeenCalledOnce()
    fail(new Error('fixture acknowledgement unavailable'))
    await flushPromises()
    expect(wrapper.emitted('save')).toBeUndefined()
    expect(wrapper.find('[role="status"]').text()).toContain('配置保存尚未确认')
    expect((endpoint.element as HTMLInputElement).value).toBe('https://speech.example.test/v1')
    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeUndefined()
    await wrapper.find('[aria-label="唤醒词连续对话"]').trigger('click')
    let confirm!: () => void
    vi.mocked(flushProfileWrites).mockImplementationOnce(() => new Promise<void>(resolve => { confirm = resolve }))
    await wrapper.find('form').trigger('submit')
    const words = wrapper.find('input[aria-label="唤醒词（逗号分隔）"]')
    await words.setValue('绘遇，听我说')
    confirm()
    await flushPromises()
    expect(saveSpeechInputConfig).toHaveBeenCalledTimes(2)
    expect(wrapper.emitted('save')).toBeUndefined()
    expect(wrapper.find('[role="status"]').text()).toContain('当前修改尚未保存')
    expect((words.element as HTMLInputElement).value).toBe('绘遇，听我说')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(vi.mocked(saveSpeechInputConfig).mock.calls[2]?.[0]).toMatchObject({ wakeWords: ['绘遇', '听我说'] })
    expect(wrapper.emitted('save')).toHaveLength(1)
  } finally { wrapper.unmount() }
})
