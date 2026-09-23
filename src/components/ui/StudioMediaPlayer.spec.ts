import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import StudioMediaPlayer from './StudioMediaPlayer.vue'

describe('StudioMediaPlayer', () => {
  it('replaces the browser media chrome with project controls', () => {
    const wrapper = mount(StudioMediaPlayer, { props: { src: '/media/clip.mp4', label: '生成的视频成片' } })
    const video = wrapper.find('video')
    expect(video.exists()).toBe(true)
    // 原生 controls 属性一旦出现，系统皮肤就会盖住整套自定义播放条。
    expect(video.attributes('controls')).toBeUndefined()
    expect(video.attributes('preload')).toBe('metadata')
    expect(wrapper.find('audio').exists()).toBe(false)
  })

  it('renders audio kind without a visible native element', () => {
    const wrapper = mount(StudioMediaPlayer, { props: { src: '/media/voice.wav', kind: 'audio', label: 'AI 声线试听' } })
    expect(wrapper.find('audio').exists()).toBe(true)
    expect(wrapper.find('audio').attributes('controls')).toBeUndefined()
    expect(wrapper.find('video').exists()).toBe(false)
    // 全屏只对画面有意义，音频不提供。
    expect(wrapper.find('[aria-label="全屏播放AI 声线试听"]').exists()).toBe(false)
  })

  it('exposes a labelled transport with keyboard-reachable seek', () => {
    const wrapper = mount(StudioMediaPlayer, { props: { src: '/media/clip.mp4', label: '生成的视频成片' } })
    expect(wrapper.find('[aria-label="播放生成的视频成片"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="静音生成的视频成片"]').exists()).toBe(true)
    const seek = wrapper.find('input[type="range"]')
    expect(seek.attributes('aria-label')).toBe('生成的视频成片播放进度')
    expect(seek.attributes('disabled')).toBeDefined()
  })

  it('resets progress and error state when the source changes', async () => {
    const wrapper = mount(StudioMediaPlayer, { props: { src: '/media/a.mp4', label: '镜头一' } })
    const seek = wrapper.find('input[type="range"]')
    await seek.setValue('3')
    expect(wrapper.find('.studio-media-time').text()).toBe('0:00 / 0:00')

    await wrapper.setProps({ src: '/media/b.mp4' })
    expect(wrapper.find('input[type="range"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.studio-media-error').exists()).toBe(false)
  })

  it('reports an unplayable source instead of leaving a broken native frame', async () => {
    const wrapper = mount(StudioMediaPlayer, { props: { src: '/media/broken.mp4', label: '镜头一' } })
    await wrapper.find('video').trigger('error')
    expect(wrapper.find('.studio-media-error').exists()).toBe(true)
    expect(wrapper.find('.studio-media-error').attributes('role')).toBe('status')
  })
})
