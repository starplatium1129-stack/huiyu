import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { useCompareSnapshots } from './useCompareSnapshots'

type Snapshot = { url: string }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const cleanup: Array<() => void> = []
function setup(build: (url: string) => Snapshot | Promise<Snapshot> = url => ({ url })) {
  let snapshots!: ReturnType<typeof useCompareSnapshots<Snapshot>>
  const wrapper = mount(defineComponent({
    setup() { snapshots = useCompareSnapshots({ build }); return () => null },
  }))
  cleanup.push(() => wrapper.unmount())
  return { snapshots, wrapper }
}
beforeEach(() => {
  let id = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:clone-${++id}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['image']) })))
})
afterEach(() => { cleanup.splice(0).forEach(dispose => dispose()); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('does not allocate or build snapshots when a blob read finishes after unmount', async () => {
  const read = deferred<Blob>()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: () => read.promise })))
  const build = vi.fn((url: string) => ({ url }))
  const { snapshots, wrapper } = setup(build)
  snapshots.rotate('blob:source')
  await flushPromises()
  wrapper.unmount()
  read.resolve(new Blob(['image']))
  await flushPromises()
  expect(URL.createObjectURL).not.toHaveBeenCalled()
  expect(build).not.toHaveBeenCalled()
  expect(snapshots.lastResult.value).toBeNull()
})

it('releases in-flight clones on unmount and ignores their late build results', async () => {
  const build = deferred<Snapshot>()
  const { snapshots, wrapper } = setup(() => build.promise)
  snapshots.rotate('blob:source')
  await flushPromises()
  wrapper.unmount()
  build.resolve({ url: 'blob:clone-1' })
  await flushPromises()
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:clone-1')
  expect(snapshots.lastResult.value).toBeNull()
})

it('discards stale unpublished clones immediately even with the comparison open', async () => {
  const slow = deferred<Snapshot>()
  const { snapshots } = setup(url => url === 'blob:clone-1' ? slow.promise : { url })
  snapshots.compareOpen.value = true
  snapshots.rotate('blob:slow')
  await flushPromises()
  snapshots.rotate('blob:fast')
  await flushPromises()
  slow.resolve({ url: 'blob:clone-1' })
  await flushPromises()
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:clone-1')
  expect(snapshots.lastResult.value?.url).toBe('blob:clone-2')
})

it('keeps the valid pair when a new build rejects and releases its clone', async () => {
  const { snapshots } = setup(url => {
    if (url === 'blob:clone-3') throw new Error('metadata unavailable')
    return { url }
  })
  for (const source of ['blob:first', 'blob:second', 'blob:failed']) {
    snapshots.rotate(source)
    await flushPromises()
  }
  expect(snapshots.prevResult.value?.url).toBe('blob:clone-1')
  expect(snapshots.lastResult.value?.url).toBe('blob:clone-2')
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:clone-3')
})

it('keeps the displayed last image alive during overlapping rotations', async () => {
  const slow = deferred<Snapshot>()
  const fast = deferred<Snapshot>()
  const { snapshots } = setup(url => url === 'blob:clone-2' ? slow.promise
    : url === 'blob:clone-3' ? fast.promise : { url })
  snapshots.rotate('blob:first')
  await flushPromises()
  snapshots.rotate('blob:slow')
  await flushPromises()
  snapshots.rotate('blob:fast')
  await flushPromises()
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:clone-1')
  fast.resolve({ url: 'blob:clone-3' })
  slow.resolve({ url: 'blob:clone-2' })
  await flushPromises()
  expect(snapshots.prevResult.value?.url).toBe('blob:clone-1')
  expect(snapshots.lastResult.value?.url).toBe('blob:clone-3')
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:clone-2')
})

it.each(['rejected', 'empty', 'http-error'])('retains the valid pair when the new image clone is %s', async failure => {
  const build = vi.fn((url: string) => ({ url }))
  const { snapshots } = setup(build)
  snapshots.rotate('blob:first'); await flushPromises()
  snapshots.rotate('blob:second'); await flushPromises()
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (failure === 'rejected') throw new Error('source revoked')
    return { ok: failure !== 'http-error', blob: async () => new Blob(failure === 'empty' ? [] : ['error response']) }
  }))
  snapshots.rotate('blob:unreadable'); await flushPromises()
  expect(build).toHaveBeenCalledTimes(2)
  expect(snapshots.prevResult.value?.url).toBe('blob:clone-1')
  expect(snapshots.lastResult.value?.url).toBe('blob:clone-2')
  expect(URL.createObjectURL).toHaveBeenCalledTimes(2)
  expect(URL.revokeObjectURL).not.toHaveBeenCalled()
})

it('handles a later asynchronous build rejection without losing the previous pair', async () => {
  const failed = deferred<Snapshot>()
  const { snapshots } = setup(url => url === 'blob:clone-3' ? failed.promise : { url })
  for (const source of ['blob:first', 'blob:second', 'blob:third']) { snapshots.rotate(source); await flushPromises() }
  failed.reject(new Error('async metadata failure')); await flushPromises()
  expect(snapshots.prevResult.value?.url).toBe('blob:clone-1')
  expect(snapshots.lastResult.value?.url).toBe('blob:clone-2')
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:clone-3')
})

it('releases replaced displayed clones on close while keeping the current pair readable', async () => {
  const { snapshots, wrapper } = setup()
  for (const source of ['blob:first', 'blob:second']) { snapshots.rotate(source); await flushPromises() }
  snapshots.compareOpen.value = true
  snapshots.rotate('blob:third'); await flushPromises()
  expect(URL.revokeObjectURL).not.toHaveBeenCalled()
  snapshots.close()
  expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:clone-1')
  expect(snapshots.prevResult.value?.url).toBe('blob:clone-2')
  expect(snapshots.lastResult.value?.url).toBe('blob:clone-3')
  wrapper.unmount()
  expect(vi.mocked(URL.revokeObjectURL).mock.calls.map(([url]) => url).sort()).toEqual(['blob:clone-1', 'blob:clone-2', 'blob:clone-3'])
})
