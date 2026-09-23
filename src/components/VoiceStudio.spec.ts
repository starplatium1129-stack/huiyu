import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import VoiceStudio from './VoiceStudio.vue'
import StudioSelect from '@/components/ui/StudioSelect.vue'
import { voiceApi, type VoiceAudioResult } from '@/api/voiceApi'
import type { TtsStatus, TranslateResult } from '@/types/api'

const toast = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn(), success: vi.fn() }))
vi.mock('@/composables/useToast', () => ({ useToast: () => toast }))
vi.mock('@/api/voiceApi', () => ({ voiceApi: {
  getStatus: vi.fn(), prepare: vi.fn(), translate: vi.fn(), synthesize: vi.fn(),
} }))

const ready = { online: true, voices: { nene: true, natsume: true } } as TtsStatus

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

/**
 * 配音面板的四个下拉已从原生 <select> 换成 StudioSelect（2026-09-22 去原生化）。
 * 取值列表在弹层里，而 happy-dom 不会展开弹层，所以直接走组件的 update:modelValue
 * 契约——这与用户点选后在组件内部产生的回写是同一条路径。
 * 顺序：0 角色 / 1 语言 / 2 情绪 / 3 语速。
 */
async function chooseField(wrapper: VueWrapper, index: number, value: string | number) {
  wrapper.findAllComponents(StudioSelect)[index].vm.$emit('update:modelValue', value)
  await flushPromises()
}

async function openStudio() {
  const wrapper = mount(VoiceStudio, {
    props: { initialVoice: 'nene', suggestedCaption: '你好' },
    global: { stubs: { RouterLink: true, ArchiveIcon: true } },
  })
  await flushPromises()
  await chooseField(wrapper, 1, 'zh')
  return wrapper
}

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  vi.mocked(voiceApi.getStatus).mockResolvedValue(ready)
  vi.mocked(voiceApi.prepare).mockResolvedValue({ ok: true, voice: 'nene', translation: false })
  vi.mocked(voiceApi.synthesize).mockResolvedValue({ blob: new Blob(['audio']), queueWaitMs: 0 })
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:voice-test')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('VoiceStudio 异步操作生命周期', () => {
  it('生成时冻结声线、语言、情绪和速度，下载文件名沿用生成设置', async () => {
    const wrapper = await openStudio()
    const status = deferred<TtsStatus>()
    vi.mocked(voiceApi.getStatus).mockReturnValueOnce(status.promise)
    await wrapper.find('button.btn-primary').trigger('click')
    await chooseField(wrapper, 0, 'natsume')
    await chooseField(wrapper, 1, 'ja')
    await chooseField(wrapper, 2, 'happy')
    await chooseField(wrapper, 3, 1.15)
    status.resolve(ready)
    await flushPromises()
    expect(voiceApi.synthesize).toHaveBeenCalledWith({
      voice: 'nene', text: '你好', language: 'zh', emotion: 'neutral',
      referenceEmotion: 'neutral', consistency: 'locked', speed: 1,
    }, { signal: expect.any(AbortSignal) })
    expect(wrapper.find('a.voice-download').attributes('download')).toMatch(/^aics_voice_nene_zh_/)
    wrapper.unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:voice-test')
  })

  it('合成期间卸载会取消请求，迟到响应不能创建 object URL 或弹成功提示', async () => {
    const wrapper = await openStudio()
    const audio = deferred<VoiceAudioResult>()
    vi.mocked(voiceApi.synthesize).mockReturnValueOnce(audio.promise)
    await wrapper.find('button.btn-primary').trigger('click')
    await flushPromises()
    const signal = vi.mocked(voiceApi.synthesize).mock.calls[0][1]?.signal
    wrapper.unmount()
    expect(signal?.aborted).toBe(true)
    audio.resolve({ blob: new Blob(['late audio']), queueWaitMs: 0 })
    await flushPromises()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('状态检测期间卸载会阻止后续准备和合成', async () => {
    const wrapper = await openStudio()
    const status = deferred<TtsStatus>()
    vi.mocked(voiceApi.getStatus).mockReturnValueOnce(status.promise)
    vi.mocked(voiceApi.prepare).mockClear()
    await wrapper.find('button.btn-primary').trigger('click')
    wrapper.unmount()
    status.resolve(ready)
    await flushPromises()
    expect(voiceApi.prepare).not.toHaveBeenCalled()
    expect(voiceApi.synthesize).not.toHaveBeenCalled()
  })

  it('翻译期间用户修改字幕时保留新稿，不填回旧字幕的译文', async () => {
    const wrapper = await openStudio()
    await chooseField(wrapper, 1, 'ja')
    const translation = deferred<TranslateResult>()
    vi.mocked(voiceApi.translate).mockReturnValueOnce(translation.promise)
    const translateButton = wrapper.findAll('button').find(button => button.text() === '翻译成日文')!
    await translateButton.trigger('click')
    await wrapper.find('textarea.voice-caption-text').setValue('新的字幕')
    translation.resolve({ translation: 'こんにちは' } as TranslateResult)
    await flushPromises()
    expect((wrapper.findAll('textarea')[1].element as HTMLTextAreaElement).value).toBe('')
    expect(wrapper.text()).toContain('字幕已修改，请重新翻译')
    wrapper.unmount()
  })
})
