import { expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import CandidateCompare from './CandidateCompare.vue'

const mocks = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('@/storage/artworkRepository', () => ({ artworkRepository: { getImage: mocks.read } }))
vi.mock('@/composables/useFluidDialog', () => ({
  useFluidDialog: (dialog: { value: HTMLDialogElement }) => ({ open() { dialog.value?.setAttribute('open', '') }, close(done: () => void) { dialog.value?.removeAttribute('open'); done() } }), isBackdropClick: () => false,
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
  expect(mocks.read).toHaveBeenCalledTimes(2)
  finish[0](new Blob(['stale'])); finish[1](new Blob(['stale']))
  await flushPromises()
  expect(create).not.toHaveBeenCalled()
  expect(mocks.read).toHaveBeenCalledTimes(4)
  wrapper.unmount()
  expect(mocks.read.mock.calls[2][1].aborted).toBe(true)
  finish[2](new Blob(['unmounted'])); finish[3](new Blob(['unmounted']))
  await flushPromises()
  expect(create).not.toHaveBeenCalled()
})

it('shows parameter differences and synchronizes keyboard zoom, movement and reset', async () => {
  mocks.read.mockReset().mockResolvedValue(new Blob(['fixture']))
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:comparison')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const wrapper = mount(CandidateCompare, {
    props: { open: true, items: [{ id: 'a', image_id: 'a', seed: 0, cfg: 0, steps: 20, model: 'same' },
      { id: 'b', image_id: 'b', seed: 1, cfg: 0, steps: 30, model: 'same' }] },
    global: { stubs: { Teleport: true, RouterLink: true } },
  })
  await flushPromises()
  const controls = () => wrapper.findAll('.candidate-controls button')
  expect(controls()[0].attributes('aria-pressed')).toBe('true')
  expect(wrapper.findAll('.candidate-parameters dt').map(item => item.text())).toEqual(['种子', '步数', '种子', '步数'])
  await controls()[0].trigger('click')
  expect(wrapper.findAll('.candidate-parameters dt').map(item => item.text())).toContain('CFG')
  const stages = () => wrapper.findAll('.candidate-viewport')
  await stages()[0].trigger('keydown', { key: '+' })
  expect(stages()[0].get('img').attributes('style')).toContain('scale(1.25)')
  expect(stages()[1].get('img').attributes('style')).toContain('scale(1.25)')
  await stages()[0].trigger('keydown', { key: 'ArrowRight' })
  expect(stages()[1].get('img').attributes('style')).toContain('translate(8%')
  await controls()[1].trigger('click')
  await stages()[0].trigger('keydown', { key: '+' })
  expect(stages()[0].get('img').attributes('style')).toContain('scale(1.5625)')
  expect(stages()[1].get('img').attributes('style')).toContain('scale(1.25)')
  await controls()[2].trigger('click')
  expect(stages()[0].get('img').attributes('style')).toContain('scale(1)')
  expect(stages()[1].get('img').attributes('style')).toContain('scale(1)')
  wrapper.unmount()
})


it('refreshes replaced candidate sources but retains images and zoom for metadata-only updates', async () => {
  mocks.read.mockReset().mockResolvedValue(null)
  const item = { id: 'a', image_id: 'missing-original', image_data: 'data:image/png;base64,first' }
  const wrapper = mount(CandidateCompare, {
    props: { open: true, items: [item] },
    global: { stubs: { Teleport: true, RouterLink: true } },
  })
  try {
    await flushPromises()
    expect(wrapper.get('.candidate-viewport img').attributes('src')).toBe(item.image_data)
    await wrapper.get('.candidate-viewport').trigger('keydown', { key: '+' })
    await wrapper.setProps({ items: [{ ...item, seed: 42 }] })
    await flushPromises()
    expect(mocks.read).toHaveBeenCalledOnce()
    expect(wrapper.get('.candidate-viewport img').attributes('style')).toContain('scale(1.25)')
    const replacement = { ...item, image_data: 'data:image/png;base64,replacement' }
    await wrapper.setProps({ items: [replacement] })
    await flushPromises()
    expect(mocks.read).toHaveBeenCalledTimes(2)
    expect(wrapper.get('.candidate-viewport img').attributes('src')).toBe(replacement.image_data)
    await wrapper.setProps({ items: [{ id: item.id, image_id: item.image_id, image_url: 'https://example.com/new.png' }] })
    await flushPromises()
    expect(wrapper.get('.candidate-viewport img').attributes('src')).toBe('https://example.com/new.png')
  } finally { wrapper.unmount() }
})
