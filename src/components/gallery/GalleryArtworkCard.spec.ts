import { defineComponent, h, nextTick, reactive } from 'vue'
import { mount } from '@vue/test-utils'
import { expect, it, vi } from 'vitest'
import GalleryArtworkCard from './GalleryArtworkCard.vue'
import type { ArtworkRecord } from '@/types/artwork'

function mountCard(imageUrl: string, thumbUrl = '') {
  return mount(GalleryArtworkCard, {
    attachTo: document.body,
    props: { item: { id: 'recovery' } as ArtworkRecord, title: '午后，和你', character: '宁宁', formattedDate: '10月3日', ratio: 0.75,
      imageUrl, thumbUrl, missing: false, selectionMode: false, selected: false, confirmingDelete: false, deleting: false },
    global: { stubs: { StudioTooltip: { template: '<slot />' }, ArchiveIcon: true, RouterLink: { template: '<a><slot /></a>' } } },
  })
}

it('keeps a decoded thumbnail when the original fails and accepts a replacement original', async () => {
  const wrapper = mountCard('/original.jpg', '/thumb.jpg')
  try {
    await wrapper.get('.artwork-image:not(.artwork-image-hd)').trigger('load')
    await wrapper.get('.artwork-image-hd').trigger('error')
    expect(wrapper.find('.artwork-image-hd').exists()).toBe(false)
    expect(wrapper.get('.artwork-image').attributes('src')).toBe('/thumb.jpg')
    expect(wrapper.find('.artwork-recovery').exists()).toBe(false)
    expect(wrapper.find('.artwork-skeleton').exists()).toBe(false)
    await wrapper.setProps({ imageUrl: '/restored.jpg' })
    await wrapper.get('.artwork-image-hd').trigger('load')
    expect(wrapper.emitted('measure')).toHaveLength(1)
    expect(wrapper.emitted('load')).toHaveLength(1)
    expect(wrapper.get('.artwork-image-hd').attributes('src')).toBe('/restored.jpg')
  } finally { wrapper.unmount() }
})

it('explains failed previews and retries without losing keyboard focus or nesting buttons', async () => {
  const wrapper = mountCard('/original.jpg', '/thumb.jpg')
  try {
    await wrapper.get('.artwork-image:not(.artwork-image-hd)').trigger('error')
    expect(wrapper.find('.artwork-recovery').exists()).toBe(false)
    await wrapper.get('.artwork-image-hd').trigger('error')
    expect(wrapper.get('[role="status"]').text()).toContain('作品图片暂时无法读取')
    expect(wrapper.find('.artwork-button button').exists()).toBe(false)
    expect(wrapper.find('.artwork-skeleton').exists()).toBe(false)
    const retry = wrapper.get('button[aria-label="重新读取图片：午后，和你"]')
    ;(retry.element as HTMLButtonElement).focus()
    await retry.trigger('click')
    await nextTick()
    expect(document.activeElement).toBe(wrapper.get('.artwork-button').element)
    expect(wrapper.find('.artwork-recovery').exists()).toBe(false)
    expect(wrapper.findAll('.artwork-image')).toHaveLength(2)
    expect(wrapper.find('.artwork-skeleton').exists()).toBe(true)
    await wrapper.get('.artwork-image-hd').trigger('load')
    expect(wrapper.find('.artwork-skeleton').exists()).toBe(false)
    // HD is the first decoded preview: reveal it in the same patch that removes
    // the placeholder, not two animation frames later over a black stage.
    expect(wrapper.get('.artwork-image-hd').classes()).toContain('is-loaded')
    expect(wrapper.get('.artwork-image-hd').classes()).not.toContain('artwork-image-hd-crossfade')
    expect(wrapper.attributes('data-reveal-ready')).toBe('true')
    expect(wrapper.emitted('load')).toHaveLength(1)

    await wrapper.setProps({ imageUrl: '/broken-replacement.jpg', thumbUrl: '' })
    await wrapper.get('.artwork-image-hd').trigger('error')
    expect(wrapper.find('.artwork-recovery').exists()).toBe(true)
    await wrapper.setProps({ imageUrl: '/fresh-replacement.jpg' })
    expect(wrapper.find('.artwork-recovery').exists()).toBe(false)
    expect(wrapper.get('.artwork-image-hd').attributes('src')).toBe('/fresh-replacement.jpg')
  } finally { wrapper.unmount() }
})

it('updates a completed image without rendering unchanged sibling cards', async () => {
  const items = [{ id: 'a' }, { id: 'b' }] as ArtworkRecord[]
  const urls = reactive({ a: '', b: '' })
  const updated = [vi.fn(), vi.fn()]
  const host = defineComponent({ setup: () => () => h('div', items.map((item, index) => h(GalleryArtworkCard, {
    key: item.id, item, title: String(item.id), character: '角色', formattedDate: '10月3日', ratio: 0.75,
    thumbUrl: '', imageUrl: urls[item.id as 'a' | 'b'], missing: false, selectionMode: false,
    selected: false, confirmingDelete: false, deleting: false, onVnodeUpdated: updated[index],
  }))) })
  const wrapper = mount(host, { global: { stubs: { StudioTooltip: { template: '<slot />' }, ArchiveIcon: true,
    RouterLink: { template: '<a><slot /></a>' } } } })
  try {
    urls.a = 'blob:completed-a'
    await nextTick()
    expect(wrapper.find('[data-card-id="a"] .artwork-image-hd').attributes('src')).toBe('blob:completed-a')
    expect(wrapper.find('[data-card-id="b"] .artwork-image-hd').exists()).toBe(false)
    expect(updated[0]).toHaveBeenCalledOnce()
    expect(updated[1]).not.toHaveBeenCalled()
  } finally { wrapper.unmount() }
})
