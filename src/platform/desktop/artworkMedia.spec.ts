import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), runtime: { runtimeEpoch: 'one', workspace: { generation: 1 } } }))
vi.mock('./runtime.ts', () => ({ desktopRuntimeFetch: mocks.fetch, getDesktopRuntime: () => ({ bootstrap: { runtime: mocks.runtime } }) }))
import { createDesktopArtworkMedia } from './artworkMedia'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const capability = () => ({ ok: true, status: 200, json: async () => ({ url: '/media/one' }) })
const mediaResponse = (blob = new Blob(['image'])) => ({ ok: true, blob: async () => blob })
const create = () => createDesktopArtworkMedia(() => {}, async () => null)
beforeEach(() => { mocks.fetch.mockReset(); mocks.runtime.runtimeEpoch = 'one'; mocks.runtime.workspace.generation = 1 })
afterEach(() => { vi.useRealTimers() })

it('one reader can cancel while another shares the original transfer; results are not cached', async () => {
  const transfer = deferred<ReturnType<typeof mediaResponse>>()
  mocks.fetch.mockResolvedValueOnce(capability()).mockReturnValueOnce(transfer.promise)
  const repository = create(), controller = new AbortController()
  const first = repository.getImage('a', controller.signal)
  const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
  const second = repository.getImage('a')
  await flushPromises()
  const signal = mocks.fetch.mock.calls[1][1].signal as AbortSignal
  controller.abort()
  await rejected
  expect(signal.aborted).toBe(false)
  const blob = new Blob(['shared'])
  transfer.resolve(mediaResponse(blob))
  expect(await second).toBe(blob)
  mocks.fetch.mockResolvedValueOnce(capability()).mockResolvedValueOnce(mediaResponse())
  await repository.getImage('a')
  expect(mocks.fetch).toHaveBeenCalledTimes(4)
})

it('the last cancellation aborts the transfer and old completion cannot remove its replacement', async () => {
  const old = deferred<ReturnType<typeof capability>>(), replacement = deferred<ReturnType<typeof capability>>()
  mocks.fetch.mockReturnValueOnce(old.promise).mockReturnValueOnce(replacement.promise)
    .mockResolvedValue(mediaResponse())
  const repository = create(), a = new AbortController(), b = new AbortController()
  const first = repository.getImage('a', a.signal), second = repository.getImage('a', b.signal)
  const done = Promise.all([expect(first).rejects.toMatchObject({ name: 'AbortError' }), expect(second).rejects.toMatchObject({ name: 'AbortError' })])
  const originalSignal = mocks.fetch.mock.calls[0][1].signal as AbortSignal
  a.abort(); expect(originalSignal.aborted).toBe(false)
  b.abort(); expect(originalSignal.aborted).toBe(true)
  await done
  const third = repository.getImage('a')
  old.resolve(capability()); await flushPromises()
  const fourth = repository.getImage('a')
  expect(mocks.fetch.mock.calls.filter(([url]) => url === '/api/workspace/media-capabilities')).toHaveLength(2)
  replacement.resolve(capability())
  await Promise.all([third, fourth])
})

it('uses one 35-second deadline across capability, body download and all readers', async () => {
  vi.useFakeTimers()
  const auth = deferred<ReturnType<typeof capability>>()
  mocks.fetch.mockReturnValueOnce(auth.promise).mockReturnValueOnce(new Promise(() => {}))
  const repository = create(), first = repository.getImage('a')
  const rejected = expect(first).rejects.toMatchObject({ name: 'TimeoutError' })
  await vi.advanceTimersByTimeAsync(30_000)
  auth.resolve(capability())
  await vi.advanceTimersByTimeAsync(0)
  const second = repository.getImage('a')
  const rejectedSecond = expect(second).rejects.toMatchObject({ name: 'TimeoutError' })
  await vi.advanceTimersByTimeAsync(5_000)
  await Promise.all([rejected, rejectedSecond])
  expect(mocks.fetch.mock.calls[1][1].signal.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it('rejects stale epoch results and does not share requests across epochs', async () => {
  const old = deferred<ReturnType<typeof capability>>()
  mocks.fetch.mockReturnValueOnce(old.promise).mockResolvedValueOnce(capability()).mockResolvedValue(mediaResponse())
  const repository = create(), first = repository.getImage('a')
  const rejected = expect(first).rejects.toThrow('连接已变化')
  mocks.runtime.runtimeEpoch = 'two'
  await repository.getImage('a')
  old.resolve(capability())
  await rejected
})

it('does not start a pre-canceled read, and clears the deadline after success or failure', async () => {
  vi.useFakeTimers()
  const repository = create(), controller = new AbortController()
  controller.abort()
  await expect(repository.getImage('a', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(mocks.fetch).not.toHaveBeenCalled()
  mocks.fetch.mockResolvedValueOnce(capability()).mockResolvedValueOnce(mediaResponse())
  await repository.getImage('a')
  expect(vi.getTimerCount()).toBe(0)
  mocks.fetch.mockRejectedValueOnce(new Error('network'))
  await expect(repository.getImage('a')).rejects.toThrow('network')
  expect(vi.getTimerCount()).toBe(0)
})

it('a cold thumbnail reads the derived preview once without fetching the original', async () => {
  let finish!: (value: string) => void
  const read = vi.fn(() => new Promise<string>(resolve => { finish = resolve }))
  const media = createDesktopArtworkMedia(() => {}, read)
  const first = media.getThumbnail('large-original'), second = media.getThumbnail('large-original')
  finish('data:image/jpeg;base64,fixture')
  expect(await first).toBe(await second)
  expect(await media.getThumbnail('large-original')).toBe('data:image/jpeg;base64,fixture')
  expect(read).toHaveBeenCalledTimes(1)
  expect(mocks.fetch).not.toHaveBeenCalled()
})

it('failed thumbnail work can retry, and a runtime change invalidates cached and pending previews', async () => {
  const read = vi.fn<(id: string) => Promise<string | null>>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('data:image/jpeg;base64,fixture')
  const media = createDesktopArtworkMedia(() => {}, read)
  await expect(media.getThumbnail('a')).rejects.toThrow('offline')
  await media.getThumbnail('a')
  mocks.runtime.runtimeEpoch = 'epoch-2'
  await media.getThumbnail('a')
  expect(read).toHaveBeenCalledTimes(3)
  let finish!: (value: string) => void
  read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const pending = media.getThumbnail('b')
  mocks.runtime.workspace.generation++
  finish('data:image/jpeg;base64,stale')
  await expect(pending).rejects.toThrow('连接已变化')
})

it('cached previews still require the active workspace authority', async () => {
  let allowed = true
  const media = createDesktopArtworkMedia(() => { if (!allowed) throw new Error('identity changed') }, vi.fn())
  await media.setThumbnail('a', 'data:image/jpeg;base64,fixture')
  allowed = false
  await expect(media.getThumbnail('a')).rejects.toThrow('identity changed')
})
