import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import StudioMediaPlayer from './StudioMediaPlayer.vue'

let wrapper: ReturnType<typeof mount> | undefined
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks() })

describe('StudioMediaPlayer', () => {
  it('stops playback and releases its media source before removal', () => {
    wrapper = mount(StudioMediaPlayer, { props: { src: '/media/clip.mp4', label: '任务结果' } })
    const element = wrapper.get('video').element
    const pause = vi.spyOn(element, 'pause')
    const load = vi.spyOn(element, 'load')
    wrapper.unmount()
    expect(pause).toHaveBeenCalledOnce()
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
  })

})
