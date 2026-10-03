import { defineComponent, h, nextTick, reactive } from 'vue'
import { mount } from '@vue/test-utils'
import { expect, it, vi } from 'vitest'
import GalleryArtworkCard from './GalleryArtworkCard.vue'
import type { ArtworkRecord } from '@/types/artwork'

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
