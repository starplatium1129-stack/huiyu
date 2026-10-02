import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import SpeechInputSettings from './SpeechInputSettings.vue'
import { DEFAULT_SPEECH_INPUT_CONFIG, SPEECH_INPUT_KEY, saveSpeechInputConfig } from '@/utils/speechInputConfig'
import { flushProfileWrites, profileLocalStorage } from '@/platform/web/profileStorage'

vi.mock('@/platform/web/profileStorage', async importOriginal => ({
  ...await importOriginal<typeof import('@/platform/web/profileStorage')>(), flushProfileWrites: vi.fn(),
}))

vi.mock('@/utils/speechInputConfig', async importOriginal => {
  const actual = await importOriginal<typeof import('@/utils/speechInputConfig')>()
  return { ...actual, saveSpeechInputConfig: vi.fn() }
})

beforeEach(async () => {
  localStorage.clear()
  const actual = await vi.importActual<typeof import('@/utils/speechInputConfig')>('@/utils/speechInputConfig')
  vi.mocked(saveSpeechInputConfig).mockReset().mockImplementation(actual.saveSpeechInputConfig)
  vi.mocked(flushProfileWrites).mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function addressResponse(status: number, type: ResponseType = 'basic'): Response {
  return { status, type, ok: status >= 200 && status < 300 } as Response
}

it.each(['getItem', 'json'])('blocks edits and saves after a %s read failure, then restores the original draft on retry', async failure => {
  const saved = { ...DEFAULT_SPEECH_INPUT_CONFIG, enabled: true, endpoint: 'https://speech.example.test/v1',
    model: 'saved-model', apiKey: 'fixture-key', wakeEnabled: true, wakeWords: ['你好'], endWords: ['再见'] }
  const nativeGet = localStorage.getItem.bind(localStorage)
  localStorage.setItem(SPEECH_INPUT_KEY, JSON.stringify(saved))
  const read = vi.spyOn(profileLocalStorage, 'getItem').mockImplementation(key => {
    if (key !== SPEECH_INPUT_KEY) return nativeGet(key)
    if (failure === 'json') return '{broken'
    throw new DOMException('fixture read denied', 'SecurityError')
  })
  const writes = vi.spyOn(profileLocalStorage, 'setItem')
  const wrapper = mount(SpeechInputSettings)
  try {
    expect(wrapper.find('[aria-label="配置读取状态"]').text()).toContain('无法读取语音配置')
    expect(wrapper.find('input').exists()).toBe(false)
    await wrapper.find('form').trigger('submit')
    await wrapper.find('.speech-settings-buttons button').trigger('click')
    expect(wrapper.find('[aria-label="配置读取状态"]').exists()).toBe(true)
    expect(writes).not.toHaveBeenCalled()
    expect(saveSpeechInputConfig).not.toHaveBeenCalled()
    expect(flushProfileWrites).not.toHaveBeenCalled()
    expect(wrapper.emitted('save')).toBeUndefined()
    expect(nativeGet(SPEECH_INPUT_KEY)).toBe(JSON.stringify(saved))
    read.mockRestore()
    await wrapper.find('.speech-settings-buttons button').trigger('click')
    expect(wrapper.find('[aria-label="配置读取状态"]').exists()).toBe(false)
    expect((wrapper.find('input[type="url"]').element as HTMLInputElement).value).toBe(saved.endpoint)
    expect((wrapper.find('input[aria-label="唤醒词（逗号分隔）"]').element as HTMLInputElement).value).toBe('你好')
    expect(wrapper.emitted('save')).toBeUndefined()
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(saveSpeechInputConfig).toHaveBeenCalledWith(saved)
    expect(wrapper.emitted('save')).toEqual([[saved]])
  } finally { wrapper.unmount() }
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

it('retains the draft if the acknowledged result is unreadable and only emits the readable authoritative result', async () => {
  const wrapper = mount(SpeechInputSettings)
  const read = vi.spyOn(profileLocalStorage, 'getItem')
  try {
    await wrapper.find('input[type="url"]').setValue('https://speech.example.test/v1')
    read.mockImplementationOnce(() => { throw new Error('fixture acknowledged result unavailable') })
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(wrapper.emitted('save')).toBeUndefined()
    expect(wrapper.find('[aria-label="配置保存状态"]').text()).toContain('配置已保存，但无法读取应用结果')
    expect((wrapper.find('input[type="url"]').element as HTMLInputElement).value).toBe('https://speech.example.test/v1')
    const confirmed = { ...DEFAULT_SPEECH_INPUT_CONFIG, endpoint: 'https://speech.example.test/v1', model: 'remote-merged-model' }
    vi.mocked(flushProfileWrites).mockImplementationOnce(async () => {
      profileLocalStorage.setItem(SPEECH_INPUT_KEY, JSON.stringify(confirmed))
    })
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(wrapper.emitted('save')).toEqual([[confirmed]])
  } finally { wrapper.unmount() }
})

it.each([
  { response: addressResponse(200), message: 'HTTP 200', state: 'ok' },
  { response: addressResponse(404), message: 'HTTP 404', state: 'fail' },
  { response: addressResponse(0, 'opaque'), message: '响应不可读', state: 'idle' },
  { response: new TypeError('fixture network blocked'), message: '未能读取地址响应', state: 'fail' },
])('reports $message without claiming transcription readiness', async ({ response, message, state }) => {
  const fetchMock = vi.fn<typeof fetch>()
  if (response instanceof Error) fetchMock.mockRejectedValue(response)
  else fetchMock.mockResolvedValue(response)
  vi.stubGlobal('fetch', fetchMock)
  const wrapper = mount(SpeechInputSettings)
  try {
    await wrapper.find('input[type="url"]').setValue('https://speech.example.test/v1/')
    await wrapper.find('.speech-settings-buttons button').trigger('click')
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledWith('https://speech.example.test/v1', expect.objectContaining({
      method: 'GET', mode: 'cors', signal: expect.any(AbortSignal),
    }))
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    const status = wrapper.find('[aria-label="地址检测状态"]')
    expect(status.text()).toContain(message)
    expect(status.attributes('data-state')).toBe(state)
    expect(wrapper.text()).toContain('未验证语音转写、模型或密钥')
    expect(wrapper.text()).not.toContain('连接正常')
    expect(wrapper.find('.speech-settings-buttons button').attributes('disabled')).toBeUndefined()
  } finally { wrapper.unmount() }
})

it('aborts after ten seconds, permits retry, and ignores a late timeout response', async () => {
  vi.useFakeTimers()
  let complete!: (response: Response) => void
  const fetchMock = vi.fn<typeof fetch>()
    .mockImplementationOnce(() => new Promise<Response>(resolve => { complete = resolve }))
    .mockResolvedValueOnce(addressResponse(200))
  vi.stubGlobal('fetch', fetchMock)
  const wrapper = mount(SpeechInputSettings)
  try {
    await wrapper.find('input[type="url"]').setValue('https://speech.example.test/v1')
    const probe = wrapper.find('.speech-settings-buttons button')
    await probe.trigger('click')
    const signal = fetchMock.mock.calls[0]?.[1]?.signal
    await vi.advanceTimersByTimeAsync(9_999)
    expect(signal?.aborted).toBe(false)
    expect(probe.attributes('disabled')).toBeDefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(signal?.aborted).toBe(true)
    expect(wrapper.find('[aria-label="地址检测状态"]').text()).toContain('超时（10 秒）')
    expect(probe.attributes('disabled')).toBeUndefined()
    await probe.trigger('click')
    await flushPromises()
    complete(addressResponse(404))
    await flushPromises()
    expect(wrapper.find('[aria-label="地址检测状态"]').text()).toContain('HTTP 200')
    expect(vi.getTimerCount()).toBe(0)
  } finally { wrapper.unmount() }
})

it.each([
  { selector: 'input[type="url"]', value: 'https://other.example.test/v1' },
  { selector: 'input[aria-label="唤醒词（逗号分隔）"]', value: '绘遇，听我说' },
])('invalidates probes when editing $selector and preserves the newer pending probe', async ({ selector, value }) => {
  let first!: (response: Response) => void
  let second!: (response: Response) => void
  const fetchMock = vi.fn<typeof fetch>()
    .mockImplementationOnce(() => new Promise<Response>(resolve => { first = resolve }))
    .mockImplementationOnce(() => new Promise<Response>(resolve => { second = resolve }))
  vi.stubGlobal('fetch', fetchMock)
  const wrapper = mount(SpeechInputSettings)
  try {
    await wrapper.find('input[type="url"]').setValue('https://speech.example.test/v1')
    await wrapper.find('[aria-label="唤醒词连续对话"]').trigger('click')
    const probe = wrapper.find('.speech-settings-buttons button')
    await probe.trigger('click')
    await wrapper.find(selector).setValue(value)
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    expect(probe.attributes('disabled')).toBeUndefined()
    await probe.trigger('click')
    first(addressResponse(200))
    await flushPromises()
    expect(wrapper.find('[aria-label="地址检测状态"]').text()).toContain('正在检测')
    expect(probe.attributes('disabled')).toBeDefined()
    second(addressResponse(404))
    await flushPromises()
    expect(wrapper.find('[aria-label="地址检测状态"]').text()).toContain('HTTP 404')
  } finally { wrapper.unmount() }
})

it('cancels probes for save, disables detection while saving, and keeps save failures separate', async () => {
  let complete!: (response: Response) => void
  let failSave!: (error: Error) => void
  const fetchMock = vi.fn<typeof fetch>()
    .mockImplementationOnce(() => new Promise<Response>(resolve => { complete = resolve }))
    .mockResolvedValueOnce(addressResponse(200))
  vi.stubGlobal('fetch', fetchMock)
  vi.mocked(flushProfileWrites).mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { failSave = reject }))
  const wrapper = mount(SpeechInputSettings)
  try {
    await wrapper.find('input[type="url"]').setValue('https://speech.example.test/v1')
    const probe = wrapper.find('.speech-settings-buttons button')
    await probe.trigger('click')
    await wrapper.find('form').trigger('submit')
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    expect(probe.attributes('disabled')).toBeDefined()
    await probe.trigger('click')
    expect(fetchMock).toHaveBeenCalledOnce()
    complete(addressResponse(404))
    await flushPromises()
    expect(wrapper.find('[aria-label="配置保存状态"]').text()).toContain('正在保存')
    expect(wrapper.find('[aria-label="地址检测状态"]').text()).not.toContain('HTTP 404')
    failSave(new Error('fixture save acknowledgement unavailable'))
    await flushPromises()
    await probe.trigger('click')
    await flushPromises()
    expect(wrapper.find('[aria-label="地址检测状态"]').text()).toContain('HTTP 200')
    expect(wrapper.find('[aria-label="配置保存状态"]').text()).toContain('配置保存尚未确认')
    expect(wrapper.emitted('save')).toBeUndefined()
  } finally { wrapper.unmount() }
})

it.each(['close', 'unmount'])('aborts a pending probe on %s and releases its deadline', async action => {
  vi.useFakeTimers()
  let complete!: (response: Response) => void
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>(resolve => { complete = resolve }))
  vi.stubGlobal('fetch', fetchMock)
  const wrapper = mount(SpeechInputSettings)
  try {
    await wrapper.find('input[type="url"]').setValue('https://speech.example.test/v1')
    await wrapper.find('.speech-settings-buttons button').trigger('click')
    if (action === 'close') {
      await wrapper.findAll('.speech-settings-buttons button').at(-1)!.trigger('click')
      expect(wrapper.emitted('close')).toHaveLength(1)
    } else wrapper.unmount()
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    complete(addressResponse(200))
    await flushPromises()
    if (action === 'close') {
      expect(wrapper.find('[aria-label="地址检测状态"]').text()).not.toContain('HTTP 200')
    }
  } finally { if (action === 'close') wrapper.unmount() }
})
