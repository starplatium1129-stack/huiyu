import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { ShowcaseEntry } from '@/utils/showcaseManifest'
import ShowcaseSampleCard from './ShowcaseSampleCard.vue'

const entry: ShowcaseEntry = { id: 'scene', title: '窗边', char: 'nene', type: 'scene', rating: 'R18', category: '日常', story: '', attempt: 1, width: 800, height: 1200 }

describe('ShowcaseSampleCard', () => {
  it('keeps sensitive marking, source dimensions and explicit large-image navigation', async () => {
    const wrapper = mount(ShowcaseSampleCard, { props: { entry, src: '/scene-showcase/thumbs/scene.jpg', loaded: true, broken: false, featured: true, characterLabel: '宁宁', typeLabel: '场景样张', ratingLabel: 'R18' } })
    expect(wrapper.classes()).toContain('sample-r18')
    expect(wrapper.get('.sample-sensitive').text()).toContain('R18')
    expect(wrapper.get('img').attributes('width')).toBe('800')
    expect(wrapper.get('img').attributes('height')).toBe('1200')
    expect(wrapper.get('.sample-visual').attributes('style')).toContain('800 / 1200')
    expect(wrapper.get('.sample-visual').find('.sample-title').exists()).toBe(false)
    expect(wrapper.get('.sample-caption').text()).toContain('窗边')
    await wrapper.get('[aria-label="查看 窗边 大图"]').trigger('click')
    expect(wrapper.emitted('open')).toEqual([['scene']])
    await wrapper.get('img').trigger('load')
    expect(wrapper.emitted('loaded')).toEqual([[entry]])
    await wrapper.get('img').trigger('error')
    expect(wrapper.emitted('error')).toEqual([[entry]])
    await wrapper.setProps({ broken: true })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('.sample-image-fallback').exists()).toBe(true)
  })
})
