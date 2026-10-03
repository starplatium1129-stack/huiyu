import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { ShowcaseEntry } from '@/utils/showcaseManifest'
import ShowcaseSampleCard from './ShowcaseSampleCard.vue'

const entry: ShowcaseEntry = { id: 'scene', title: '窗边', char: 'nene', type: 'scene', rating: 'R18', category: '日常', story: '', attempt: 1, width: 800, height: 1200 }

describe('ShowcaseSampleCard', () => {
  it('shows a repeated character prefix once while retaining the full accessible title', () => {
    const title = '周防有希 / 周防有希 · 学生会室'
    const wrapper = mount(ShowcaseSampleCard, { props: { entry: { ...entry, title }, src: '/scene.jpg', featured: false, characterLabel: '周防有希', ratingLabel: 'R18' } })
    expect(wrapper.get('.sample-title').text()).toBe('学生会室')
    expect(wrapper.get('.sample-kicker').text()).toContain('周防有希')
    expect(wrapper.get('img').attributes('alt')).toBe(title)
    expect(wrapper.get('.sample-visual').attributes('aria-label')).toContain(title)
    wrapper.unmount()
  })

  it('preserves a character name that is part of the actual artwork title', () => {
    const wrapper = mount(ShowcaseSampleCard, { props: { entry: { ...entry, title: '宁宁的放学路' }, src: '/scene.jpg', featured: false, characterLabel: '宁宁', ratingLabel: 'R18' } })
    expect(wrapper.get('.sample-title').text()).toBe('宁宁的放学路')
    wrapper.unmount()
  })

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
