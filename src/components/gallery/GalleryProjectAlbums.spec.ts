import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import GalleryProjectAlbums from './GalleryProjectAlbums.vue'
import { setRuntimeOrigin } from '@/platform/runtimeUrl'

const album = { id: 'rain', title: '雨后的来信', count: 3, covers: [{ id: 1, src: 'blob:one' }] }
afterEach(() => setRuntimeOrigin(null, false))

describe('project album navigation', () => {
  it('selects projects and exposes selection and return-to-all to keyboard users', async () => {
    const wrapper = mount(GalleryProjectAlbums, { props: { albums: [album], selectedId: '' } })
    const card = wrapper.get('button.gallery-album')
    expect(card.attributes('aria-label')).toBe('雨后的来信，3 幅作品')
    expect(card.attributes('aria-pressed')).toBe('false')
    await card.trigger('click')
    expect(wrapper.emitted('select')).toEqual([['rain']])
    await wrapper.setProps({ selectedId: 'rain' })
    expect(card.attributes('aria-pressed')).toBe('true')
    await card.trigger('click')
    await wrapper.get('.gallery-albums-all').trigger('click')
    expect(wrapper.emitted('select')).toEqual([['rain'], [''], ['']])
    wrapper.unmount()
  })

  it('keeps a usable placeholder after decode failure and retries a replacement URL', async () => {
    const wrapper = mount(GalleryProjectAlbums, { props: { albums: [album], selectedId: '' } })
    await wrapper.get('img').trigger('error')
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.get('.gallery-album-picture [data-icon]').attributes('data-icon')).toBe('image')
    await wrapper.setProps({ albums: [{ ...album, covers: [{ id: 1, src: 'blob:replacement' }] }] })
    expect(wrapper.get('img').attributes('src')).toBe('blob:replacement')
    wrapper.unmount()
  })

  it('does not show a project shelf for an empty collection', () => {
    const wrapper = mount(GalleryProjectAlbums, { props: { albums: [], selectedId: '' } })
    expect(wrapper.find('section').exists()).toBe(false)
    wrapper.unmount()
  })

  it('resolves runtime resources and keeps disconnected desktop covers as placeholders', async () => {
    setRuntimeOrigin(null, true)
    const wrapper = mount(GalleryProjectAlbums, { props: { albums: [{ ...album, covers: [{ id: 1, src: '/assets/cover.webp' }] }], selectedId: '' } })
    expect(wrapper.find('img').exists()).toBe(false)
    setRuntimeOrigin('http://127.0.0.1:4300', true)
    await wrapper.vm.$nextTick()
    expect(wrapper.get('img').attributes('src')).toBe('http://127.0.0.1:4300/assets/cover.webp')
    wrapper.unmount()
  })

  it.each(['http://127.0.0.1:4300', 'http://127.0.0.1:4400'])('retries failed covers after disconnecting and reconnecting to %s', async origin => {
    setRuntimeOrigin('http://127.0.0.1:4300', true)
    const wrapper = mount(GalleryProjectAlbums, { props: { albums: [{ ...album, covers: [{ id: 1, src: '/assets/cover.webp' }] }], selectedId: '' } })
    expect(wrapper.get('img').attributes('crossorigin')).toBe('anonymous')
    await wrapper.get('img').trigger('error')
    expect(wrapper.find('img').exists()).toBe(false)
    setRuntimeOrigin(null, true)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('img').exists()).toBe(false)
    setRuntimeOrigin(origin, true)
    await wrapper.vm.$nextTick()
    expect(wrapper.get('img').attributes('src')).toBe(`${origin}/assets/cover.webp`)
    wrapper.unmount()
  })

  it('retries a same-address reconnect even when it occurs within one render tick', async () => {
    const origin = 'http://127.0.0.1:4300'
    setRuntimeOrigin(origin, true)
    const wrapper = mount(GalleryProjectAlbums, { props: { albums: [{ ...album, covers: [{ id: 1, src: '/assets/cover.webp' }] }], selectedId: '' } })
    await wrapper.get('img').trigger('error')
    setRuntimeOrigin(null, true)
    setRuntimeOrigin(origin, true)
    await wrapper.vm.$nextTick()
    expect(wrapper.get('img').attributes('src')).toBe(`${origin}/assets/cover.webp`)
    wrapper.unmount()
  })
})
