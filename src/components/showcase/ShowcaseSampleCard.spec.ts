import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { ShowcaseEntry } from '@/utils/showcaseManifest'
import ShowcaseSampleCard from './ShowcaseSampleCard.vue'

const entry: ShowcaseEntry = { id: 'scene', title: '窗边', char: 'nene', type: 'scene', rating: 'R18', category: '日常', story: '', attempt: 1, width: 800, height: 1200 }

describe('ShowcaseSampleCard', () => {
  it('retains decoded proportions across metadata refresh and resets only for a new image', async () => {
    const unmeasured = { ...entry, width: undefined, height: undefined }
    const wrapper = mount(ShowcaseSampleCard, { props: { entry: unmeasured, src: '/wide.jpg', featured: false, characterLabel: '宁宁', typeLabel: '场景样张', ratingLabel: 'R18' } })
    const image = wrapper.get('img')
    Object.defineProperties(image.element, { naturalWidth: { value: 1600 }, naturalHeight: { value: 900 } })
    await image.trigger('load')
    expect(wrapper.get('.sample-visual').attributes('style')).toContain('1600 / 900')
    await wrapper.setProps({ entry: { ...unmeasured, title: '更新说明' } })
    expect(wrapper.get('.sample-visual').attributes('style')).toContain('1600 / 900')
    await wrapper.setProps({ src: '/portrait.jpg' })
    expect(wrapper.get('.sample-visual').attributes('style')).toContain('3 / 4')
    await image.trigger('load')
    expect(wrapper.get('.sample-visual').attributes('style')).toContain('3 / 4')
    const next = wrapper.get('img')
    Object.defineProperties(next.element, { naturalWidth: { value: 800 }, naturalHeight: { value: 1200 } })
    await next.trigger('load')
    expect(wrapper.get('.sample-visual').attributes('style')).toContain('800 / 1200')
    wrapper.unmount()
  })

  it('keeps sensitive marking, source dimensions and explicit large-image navigation', async () => {
    const wrapper = mount(ShowcaseSampleCard, { props: { entry, src: '/scene-showcase/thumbs/scene.jpg', featured: true, characterLabel: '宁宁', typeLabel: '场景样张', ratingLabel: 'R18' } })
    expect(wrapper.classes()).toContain('sample-r18')
    expect(wrapper.get('.sample-sensitive').text()).toContain('R18')
    expect(wrapper.get('img').attributes('width')).toBe('800')
    expect(wrapper.get('img').attributes('height')).toBe('1200')
    expect(wrapper.get('.sample-visual').attributes('style')).toContain('800 / 1200')
    expect(wrapper.get('.sample-visual').find('.sample-title').exists()).toBe(false)
    expect(wrapper.get('.sample-caption').text()).toContain('窗边')
    await wrapper.get('[aria-label="查看 窗边 大图"]').trigger('click')
    expect(wrapper.emitted('open')).toEqual([['scene']])
    Object.defineProperties(wrapper.get('img').element, { naturalWidth: { value: 800 }, naturalHeight: { value: 1200 } })
    await wrapper.get('img').trigger('load')
    expect(wrapper.get('img').classes()).toContain('sample-image-ready')
    await wrapper.get('img').trigger('error')
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('.sample-image-fallback').exists()).toBe(true)
  })
})
