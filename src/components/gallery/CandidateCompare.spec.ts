import { expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import CandidateCompare from './CandidateCompare.vue'

const mocks = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('@/storage/artworkRepository', () => ({ artworkRepository: { getImage: mocks.read } }))
vi.mock('@/composables/useFluidDialog', () => ({
  useFluidDialog: () => ({ open() {}, close(done: () => void) { done() } }), isBackdropClick: () => false,
}))

it('closing a comparison cancels all reads and reopening cannot publish its old results', async () => {
  const finish: Array<(blob: Blob) => void> = []
  mocks.read.mockImplementation(() => new Promise<Blob>(resolve => finish.push(resolve)))
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:comparison')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const wrapper = mount(CandidateCompare, {
    props: { open: true, items: [{ id: 'a', image_id: 'a' }, { id: 'b', image_id: 'b' }] },
    global: { stubs: { Teleport: true, RouterLink: true } },
  })
  await flushPromises()
  const firstSignal = mocks.read.mock.calls[0][1] as AbortSignal
  expect(mocks.read.mock.calls[1][1]).toBe(firstSignal)
  await wrapper.setProps({ open: false })
  expect(firstSignal.aborted).toBe(true)
  await wrapper.setProps({ open: true }); await flushPromises()
  finish[0](new Blob(['stale'])); finish[1](new Blob(['stale']))
  await flushPromises()
  expect(create).not.toHaveBeenCalled()
  wrapper.unmount()
  expect(mocks.read.mock.calls[2][1].aborted).toBe(true)
  finish[2](new Blob(['unmounted'])); finish[3](new Blob(['unmounted']))
  await flushPromises()
  expect(create).not.toHaveBeenCalled()
})
