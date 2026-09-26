import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { buildShowcaseAlbums } from '@/composables/showcase/useShowcaseAlbums'
import type { ShowcaseEntry } from '@/utils/showcaseManifest'
import ShowcaseAlbums from './ShowcaseAlbums.vue'

const entries: ShowcaseEntry[] = [
  { id: 'safe', title: '样张', char: 'nene', type: 'scene', rating: 'All', category: '', story: '', attempt: 1 },
  { id: 'adult', title: '样张', char: 'nene', type: 'lora', rating: 'R18', category: '', story: '', attempt: 1 },
]
function render() {
  return mount(ShowcaseAlbums, { props: { albums: buildShowcaseAlbums(entries), selected: 'all', brokenThumbs: new Set<string>(), thumbSrc: (entry: ShowcaseEntry) => `/scene-showcase/thumbs/${entry.id}.jpg` } })
}

describe('ShowcaseAlbums', () => {
  it('emits the existing type filter and lets the active album return to all', async () => {
    const wrapper = render()
    await wrapper.get('[aria-label="场景故事，1 幅样张"]').trigger('click')
    expect(wrapper.emitted('select')).toEqual([['scene']])
    await wrapper.setProps({ selected: 'scene' })
    expect(wrapper.get('[aria-label="场景故事，1 幅样张"]').attributes('aria-pressed')).toBe('true')
    await wrapper.get('[aria-label="场景故事，1 幅样张"]').trigger('click')
    expect(wrapper.emitted('select')?.at(-1)).toEqual(['all'])
    await wrapper.get('.albums-all').trigger('click')
    expect(wrapper.emitted('select')?.at(-1)).toEqual(['all'])
  })

  it('renders only a safe image and keeps albums without safe covers selectable', async () => {
    const wrapper = render()
    expect(wrapper.findAll('img')).toHaveLength(1)
    expect(wrapper.get('img').attributes('src')).toContain('/thumbs/safe.jpg')
    const adultAlbum = wrapper.get('[aria-label="LoRA 样张，1 幅样张"]')
    expect(adultAlbum.find('img').exists()).toBe(false)
    expect(adultAlbum.find('.album-placeholder').exists()).toBe(true)
    await adultAlbum.trigger('click')
    expect(wrapper.emitted('select')).toEqual([['lora']])
  })

  it('reports cover errors to the shared thumbnail lifecycle and renders its fallback', async () => {
    const wrapper = render()
    await wrapper.get('img').trigger('error')
    expect(wrapper.emitted('image-error')).toEqual([[entries[0]]])
    await wrapper.setProps({ brokenThumbs: new Set(['safe']) })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.findAll('.album-placeholder')).toHaveLength(2)
  })
})
