import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, KeepAlive, nextTick, ref } from 'vue'
import StudioMediaPlayer from './StudioMediaPlayer.vue'

let wrapper: ReturnType<typeof mount> | undefined
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks() })

describe('StudioMediaPlayer', () => {
  it('pauses cached playback and releases its media source before removal', async () => {
    const active = ref(true)
    wrapper = mount(defineComponent({ setup: () => () => h(KeepAlive, null, {
      default: () => active.value ? h(StudioMediaPlayer, { src: '/media/clip.mp4', label: '任务结果' }) : null,
    }) }))
    const element = wrapper.get('video').element
    const pause = vi.spyOn(element, 'pause')
    const load = vi.spyOn(element, 'load')
    const play = vi.spyOn(element, 'play').mockResolvedValue()
    element.currentTime = 42
    await wrapper.get('video').trigger('play')
    active.value = false; await nextTick()
    expect(pause).toHaveBeenCalledOnce()
    expect(element.hasAttribute('src')).toBe(true)
    expect(element.currentTime).toBe(42)
    expect(load).not.toHaveBeenCalled()
    active.value = true; await nextTick()
    expect(wrapper.get('video').element).toBe(element)
    expect(wrapper.find('[aria-label="播放任务结果"]').exists()).toBe(true)
    expect(play).not.toHaveBeenCalled()
    await wrapper.get('[aria-label="播放任务结果"]').trigger('click')
    expect(play).toHaveBeenCalledOnce()
    wrapper.unmount()
    expect(pause).toHaveBeenCalledTimes(2)
    expect(element.hasAttribute('src')).toBe(false)
    expect(load).toHaveBeenCalledOnce()
  })

  it('renders audio kind without a visible native element', () => {
    wrapper = mount(StudioMediaPlayer, { props: { src: '/media/voice.wav', kind: 'audio', label: 'AI 声线试听' } })
    expect(wrapper.find('audio').exists()).toBe(true)
    expect(wrapper.find('audio').attributes('controls')).toBeUndefined()
    expect(wrapper.find('video').exists()).toBe(false)
    // 全屏只对画面有意义，音频不提供。
    expect(wrapper.find('[aria-label="全屏播放AI 声线试听"]').exists()).toBe(false)
  })

  it('keeps video controls accessible and resets progress and failure when the source changes', async () => {
    wrapper = mount(StudioMediaPlayer, { props: {
      src: '/media/a.mp4', label: '镜头一', captionsSrc: '/media/clip.zh.vtt', transcript: '角色说出这一句台词。',
    } })
    const video = wrapper.get('video')
    let rejectPreviousPlay!: (reason: Error) => void
    vi.spyOn(video.element, 'play')
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectPreviousPlay = reject }))
      .mockRejectedValueOnce(new Error('Current playback failed'))
    await wrapper.get('[aria-label="播放镜头一"]').trigger('click')
    expect(video.attributes('controls')).toBeUndefined()
    expect(wrapper.get('[aria-label="播放镜头一"]').element.tagName).toBe('BUTTON')
    expect(wrapper.get('[aria-label="静音镜头一"]').element.tagName).toBe('BUTTON')
    const track = wrapper.get('track[kind="captions"]')
    expect(track.attributes('src')).toBe('/media/clip.zh.vtt')
    expect(track.attributes('srclang')).toBe('zh-CN')
    expect(wrapper.get('.studio-media-transcript').text()).toContain('角色说出这一句台词。')
    const seek = wrapper.get('input[type="range"]')
    expect(seek.attributes('aria-label')).toBe('镜头一播放进度')
    expect(seek.attributes('disabled')).toBeDefined()
    Object.defineProperty(video.element, 'duration', { configurable: true, value: 120 })
    await video.trigger('loadedmetadata')
    await seek.setValue('45')
    expect(wrapper.find('.studio-media-time').text()).toBe('0:45 / 2:00')
    await video.trigger('error')
    expect(wrapper.get('.studio-media-error').attributes('role')).toBe('status')

    await wrapper.setProps({ src: '/media/b.mp4' })
    expect(wrapper.find('.studio-media-time').text()).toBe('0:00 / 0:00')
    expect(wrapper.find('input[type="range"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.studio-media-error').exists()).toBe(false)
    // A new clip resets the native timeline before metadata arrives. Only a URL
    // renewal for the same clip may restore the previous playback position.
    video.element.currentTime = 0
    await video.trigger('loadedmetadata')
    expect(video.element.currentTime).toBe(0)
    rejectPreviousPlay(new DOMException('Loading a new clip interrupted playback', 'AbortError'))
    await flushPromises()
    expect(wrapper.find('.studio-media-error').exists()).toBe(false)
    await wrapper.get('[aria-label="播放镜头一"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('.studio-media-error').exists()).toBe(true)
  })

})


it('requests fullscreen on the player container so controls remain reachable', async () => {
  wrapper = mount(StudioMediaPlayer, { props: { src: '/media/clip.mp4', label: '结果' } })
  const container = wrapper.get('figure').element
  let fullscreenElement: Element | null = null
  const request = vi.fn(async () => { fullscreenElement = container })
  const keys = ['fullscreenEnabled', 'fullscreenElement', 'exitFullscreen'] as const
  const original = keys.map(key => Object.getOwnPropertyDescriptor(document, key))
  const exit = vi.fn(async () => { fullscreenElement = null })
  Object.defineProperties(document, {
    fullscreenEnabled: { configurable: true, value: true },
    fullscreenElement: { configurable: true, get: () => fullscreenElement },
    exitFullscreen: { configurable: true, value: exit },
  })
  Object.defineProperty(container, 'requestFullscreen', { configurable: true, value: request })
  try {
    await wrapper.get('[aria-label="全屏播放结果"]').trigger('click'); await flushPromises()
    document.dispatchEvent(new Event('fullscreenchange')); await nextTick()
    expect(request).toHaveBeenCalledOnce()
    expect(container.contains(wrapper.get('.studio-media-bar').element)).toBe(true)
    await wrapper.get('[aria-label="退出全屏结果"]').trigger('click'); await flushPromises()
    expect(exit).toHaveBeenCalledOnce()
  } finally {
    keys.forEach((key, index) => {
      if (original[index]) Object.defineProperty(document, key, original[index]!)
      else Reflect.deleteProperty(document, key)
    })
  }
})
