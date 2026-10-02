import { expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import GalleryShowcase from './GalleryShowcase.vue'

const mocks = vi.hoisted(() => ({ read: vi.fn(), close: vi.fn() }))
vi.mock('@/storage/artworkRepository', () => ({ artworkRepository: { getImage: mocks.read } }))
vi.mock('@/composables/useFluidDialog', () => ({
  useFluidDialog: (dialog: { value: HTMLDialogElement }) => ({
    open() { dialog.value?.setAttribute('open', '') },
    close(done: () => void) { mocks.close(); dialog.value?.removeAttribute('open'); done() },
  }),
}))
const items = Array.from({ length: 6 }, (_, i) => ({ id: String(i), sceneTitle: `作品 ${i}`, image_id: `image-${i}` }))
const cached = Object.fromEntries(items.map(item => [item.id, `blob:cached-${item.id}`]))

it('uses cached images, renders only neighbors, bounds keyboard navigation and closes without mutating works', async () => {
  mocks.read.mockReset()
  const wrapper = mount(GalleryShowcase, { props: { items, title: '中性画册', cardUrls: cached, thumbUrls: {} }, global: { stubs: { Teleport: true } } })
  await flushPromises()
  expect(wrapper.findAll('img')).toHaveLength(2)
  expect(wrapper.get('[aria-label="上一幅"]').attributes('disabled')).toBeDefined()
  await wrapper.get('dialog').trigger('keydown', { key: 'ArrowRight' })
  expect(wrapper.findAll('img')).toHaveLength(3)
  expect(wrapper.get('[aria-current="true"] img').attributes('src')).toBe('blob:cached-1')
  await wrapper.get('dialog').trigger('keydown', { key: 'ArrowRight', ctrlKey: true })
  expect(wrapper.get('[aria-current="true"]').attributes('aria-label')).toBe('作品 1')
  for (let i = 0; i < 8; i++) await wrapper.get('[aria-label="下一幅"]').trigger('click')
  expect(wrapper.get('[aria-label="下一幅"]').attributes('disabled')).toBeDefined()
  expect(wrapper.findAll('img')).toHaveLength(2)
  expect(mocks.read).not.toHaveBeenCalled()
  await wrapper.get('dialog').trigger('cancel')
  expect(wrapper.emitted('close')).toHaveLength(1)
  expect(items[0]).toEqual({ id: '0', sceneTitle: '作品 0', image_id: 'image-0' })
  wrapper.unmount()
})

it('handles a single unavailable image and cancels outstanding reads on exit', async () => {
  let finish!: (blob: Blob) => void
  mocks.read.mockReset().mockImplementation(() => new Promise<Blob>(resolve => { finish = resolve }))
  const create = vi.spyOn(URL, 'createObjectURL')
  const wrapper = mount(GalleryShowcase, { props: { items: items.slice(0, 1), title: '中性画册', cardUrls: {}, thumbUrls: {} }, global: { stubs: { Teleport: true } } })
  await flushPromises()
  expect(wrapper.findAll('.showcase-work')).toHaveLength(1)
  expect(wrapper.get('[aria-label="下一幅"]').attributes('disabled')).toBeDefined()
  await wrapper.get('dialog').trigger('cancel')
  expect(mocks.read.mock.calls[0][1].aborted).toBe(true)
  finish(new Blob(['stale'])); await flushPromises()
  expect(create).not.toHaveBeenCalled()
  wrapper.unmount()
})
