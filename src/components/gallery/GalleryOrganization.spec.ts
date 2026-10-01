import { expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import GalleryOrganization from './GalleryOrganization.vue'
const mocks = vi.hoisted(() => ({ organize: vi.fn(), undo: vi.fn(), create: vi.fn() }))
vi.mock('@/storage/artworkRepository', () => ({ artworkRepository: { organizeArtworks: mocks.organize, undoArtworkOrganization: mocks.undo, createProject: mocks.create } }))

it('creates an album from selected existing artwork and retains it if organization needs a retry', async () => {
  vi.clearAllMocks()
  mocks.create.mockImplementation(async draft => ({ ...draft, history_ids: [] }))
  mocks.organize.mockRejectedValueOnce(new Error('organize offline')).mockImplementationOnce(async input => ({ operationId: 'members', changes: input.ids.map((id: string) => ({ id, before: {}, after: {} })) }))
  const wrapper = mount(GalleryOrganization, { props: { active: true, ids: ['one', 'two'], projects: [] }, global: { stubs: { StudioSelect: true } } })
  await wrapper.findAll('button').find(button => button.text() === '新建画册')!.trigger('click')
  const name = wrapper.get('input[placeholder="例如：秋日手记"]')
  await name.setValue('新画册')
  await wrapper.get('form').trigger('submit'); await flushPromises()
  expect(mocks.create).toHaveBeenCalledTimes(1)
  expect(wrapper.text()).toContain('organize offline')
  expect(wrapper.find('input[placeholder="例如：秋日手记"]').exists()).toBe(false)
  await wrapper.get('form').trigger('submit'); await flushPromises()
  expect(mocks.create).toHaveBeenCalledTimes(1)
  expect(mocks.organize).toHaveBeenLastCalledWith({ ids: ['one', 'two'], projectId: mocks.create.mock.calls[0][0].id })
  expect(wrapper.text()).toContain('已整理 2 幅作品')
  wrapper.unmount()
  vi.clearAllMocks()
})

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
