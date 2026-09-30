import { expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import GalleryOrganization from './GalleryOrganization.vue'
const mocks = vi.hoisted(() => ({ organize: vi.fn(), undo: vi.fn() }))
vi.mock('@/storage/artworkRepository', () => ({ artworkRepository: { organizeArtworks: mocks.organize, undoArtworkOrganization: mocks.undo } }))

it('keeps the undo action after selection mode is finished', async () => {
  mocks.organize.mockResolvedValue({ operationId: 'tags', changes: [{ id: 'one', before: {}, after: {} }] })
  mocks.undo.mockResolvedValue({ restored: 1, skipped: 0 })
  const wrapper = mount(GalleryOrganization, { props: { active: true, ids: ['one'], projects: [] },
    global: { stubs: { StudioSelect: true } } })
  await wrapper.get('.organization-actions button').trigger('click')
  await wrapper.findAll('input')[0].setValue('cover')
  await wrapper.get('form').trigger('submit'); await flushPromises()
  expect(mocks.organize).toHaveBeenCalledExactlyOnceWith({ ids: ['one'], collectionTags: { add: ['cover'], remove: [] } })
  await wrapper.setProps({ active: false, ids: [] })
  expect(wrapper.find('form').exists()).toBe(false)
  const undo = wrapper.findAll('button').find(button => button.text().includes('撤销本次整理'))!
  expect(undo.exists()).toBe(true)
  await undo.trigger('click'); await flushPromises()
  expect(mocks.undo).toHaveBeenCalledOnce()
  expect(wrapper.text()).toContain('已撤销 1 幅作品')
  wrapper.unmount()
})
