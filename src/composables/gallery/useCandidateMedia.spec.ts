import { expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { useCandidateMedia } from './useCandidateMedia'
const mocks = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('@/storage/artworkRepository', () => ({ artworkRepository: { getImage: mocks.read } }))

it('bounds reads across changing candidate sets and revokes all owned URLs', async () => {
  const pending: Array<(blob: Blob) => void> = []
  mocks.read.mockImplementation(() => new Promise(resolve => pending.push(resolve)))
  const create = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${Math.random()}`)
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const media = useCandidateMedia()
  media.load(Array.from({ length: 6 }, (_, id) => ({ id, image_id: `image-${id}` })))
  expect(mocks.read).toHaveBeenCalledTimes(2)
  pending.shift()!(new Blob(['one'])); await flushPromises()
  expect(mocks.read).toHaveBeenCalledTimes(3)
  const previousSignals = mocks.read.mock.calls.map(call => call[1] as AbortSignal)
  media.load([{ id: 'new-a', image_id: 'new-a' }, { id: 'new-b', image_id: 'new-b' }])
  expect(previousSignals.every(signal => signal.aborted)).toBe(true)
  expect(mocks.read).toHaveBeenCalledTimes(3)
  pending.splice(0).forEach(resolve => resolve(new Blob(['stale']))); await flushPromises()
  expect(mocks.read).toHaveBeenCalledTimes(5)
  expect(create).toHaveBeenCalledTimes(1)
  expect(revoke).toHaveBeenCalledTimes(1)
  pending.splice(0).forEach(resolve => resolve(new Blob(['new']))); await flushPromises()
  expect(Object.keys(media.urls)).toEqual(['new-a', 'new-b'])
  expect(media.loading.value).toBe(false)
  media.release()
  expect(revoke).toHaveBeenCalledTimes(3)
  expect(media.urls).toEqual({})
})
