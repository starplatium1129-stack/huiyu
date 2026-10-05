import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), render: vi.fn(), runtime: { runtimeEpoch: 'one', workspace: { generation: 1 } } }))
vi.mock('./runtime.ts', () => ({ desktopRuntimeFetch: mocks.fetch, getDesktopRuntime: () => ({ bootstrap: { runtime: mocks.runtime } }) }))
vi.mock('../../utils/imageThumb.ts', () => ({ blobThumbDataUrl: mocks.render }))
import { createDesktopArtworkMedia } from './artworkMedia'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const mediaResponse = (blob = new Blob(['image']), offset = 0, total = blob.size, hash = 'fixture') => ({
  ok: true, status: 200, blob: async () => blob,
  headers: new Headers({ 'X-Workspace-Media-Mime': 'image/png', 'X-Workspace-Media-Offset': String(offset),
    'X-Workspace-Media-Total-Bytes': String(total), 'X-Workspace-Media-Sha256': hash }),
})
const create = () => createDesktopArtworkMedia(() => {}, async () => null)
beforeEach(() => { mocks.fetch.mockReset(); mocks.render.mockReset(); mocks.runtime.runtimeEpoch = 'one'; mocks.runtime.workspace.generation = 1 })
afterEach(() => { vi.useRealTimers() })

it('one reader can cancel while another shares the original transfer; results are not cached', async () => {
  const transfer = deferred<ReturnType<typeof mediaResponse>>()
  mocks.fetch.mockReturnValueOnce(transfer.promise)
  const repository = create(), controller = new AbortController()
  const first = repository.getImage('a', controller.signal)
  const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
  const second = repository.getImage('a')
  await flushPromises()
  const signal = mocks.fetch.mock.calls[0][1].signal as AbortSignal
  controller.abort()
  await rejected
  expect(signal.aborted).toBe(false)
  const blob = new Blob(['shared'])
  transfer.resolve(mediaResponse(blob))
  expect(await (await second)!.text()).toBe('shared')
  mocks.fetch.mockResolvedValueOnce(mediaResponse())
  await repository.getImage('a')
  expect(mocks.fetch).toHaveBeenCalledTimes(2)
})

it('the last cancellation aborts the transfer and old completion cannot remove its replacement', async () => {
  const old = deferred<ReturnType<typeof mediaResponse>>(), replacement = deferred<ReturnType<typeof mediaResponse>>()
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
  old.resolve(mediaResponse()); await flushPromises()
  const fourth = repository.getImage('a')
  expect(mocks.fetch.mock.calls.filter(([url]) => String(url).includes('/chunks?'))).toHaveLength(2)
  replacement.resolve(mediaResponse())
  await Promise.all([third, fourth])
})

it('uses one 35-second deadline across chunk headers, body download and all readers', async () => {
  vi.useFakeTimers()
  const headers = deferred<ReturnType<typeof mediaResponse>>()
  mocks.fetch.mockReturnValueOnce(headers.promise)
  const repository = create(), first = repository.getImage('a')
  const rejected = expect(first).rejects.toMatchObject({ name: 'TimeoutError' })
  await vi.advanceTimersByTimeAsync(30_000)
  headers.resolve({ ...mediaResponse(), blob: () => new Promise(() => {}) })
  await vi.advanceTimersByTimeAsync(0)
  const second = repository.getImage('a')
  const rejectedSecond = expect(second).rejects.toMatchObject({ name: 'TimeoutError' })
  await vi.advanceTimersByTimeAsync(5_000)
  await Promise.all([rejected, rejectedSecond])
  expect(mocks.fetch.mock.calls[0][1].signal.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it('rejects stale epoch results and does not share requests across epochs', async () => {
  const old = deferred<ReturnType<typeof mediaResponse>>()
  mocks.fetch.mockReturnValueOnce(old.promise).mockResolvedValue(mediaResponse())
  const repository = create(), first = repository.getImage('a')
  const rejected = expect(first).rejects.toThrow('连接已变化')
  mocks.runtime.runtimeEpoch = 'two'
  await repository.getImage('a')
  old.resolve(mediaResponse())
  await rejected
})

it('does not start a pre-canceled read, and clears the deadline after success or failure', async () => {
  vi.useFakeTimers()
  const repository = create(), controller = new AbortController()
  controller.abort()
  await expect(repository.getImage('a', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(mocks.fetch).not.toHaveBeenCalled()
  mocks.fetch.mockResolvedValueOnce(mediaResponse())
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


it('deleted thumbnails are not resurrected by a late background render', async () => {
  const rendered = deferred<string>()
  mocks.render.mockReturnValueOnce(rendered.promise)
  const read = vi.fn(async () => null)
  const media = createDesktopArtworkMedia(() => {}, read)
  const pending = media.cacheThumbnail('a', new Blob(['old']))
  media.forgetThumbnail('a')
  rendered.resolve('data:image/jpeg;base64,deleted')
  await pending
  expect(await media.getThumbnail('a')).toBeNull()
  expect(read).toHaveBeenCalledExactlyOnceWith('a')
})

it('explicit thumbnail publication wins over an earlier background render', async () => {
  const rendered = deferred<string>()
  mocks.render.mockReturnValueOnce(rendered.promise)
  const media = create()
  const pending = media.cacheThumbnail('a', new Blob(['old']))
  await media.setThumbnail('a', 'data:image/jpeg;base64,published')
  rendered.resolve('data:image/jpeg;base64,stale')
  await pending
  expect(await media.getThumbnail('a')).toBe('data:image/jpeg;base64,published')
})

it('the newest thumbnail render wins and failed work can retry', async () => {
  const old = deferred<string>(), latest = deferred<string>()
  mocks.render.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise)
  const media = create()
  const first = media.cacheThumbnail('a', new Blob(['old']))
  const second = media.cacheThumbnail('a', new Blob(['new']))
  latest.resolve('data:image/jpeg;base64,new')
  await second
  old.resolve('data:image/jpeg;base64,old')
  await first
  expect(await media.getThumbnail('a')).toBe('data:image/jpeg;base64,new')
  mocks.render.mockRejectedValueOnce(new Error('decode failed')).mockResolvedValueOnce('data:image/jpeg;base64,retry')
  await expect(media.cacheThumbnail('a', new Blob())).rejects.toThrow('decode failed')
  await media.cacheThumbnail('a', new Blob())
  expect(await media.getThumbnail('a')).toBe('data:image/jpeg;base64,retry')
})

it('reads 260 originals without consuming the 256 short-lived URL grants', async () => {
  let grants = 0
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url === '/api/workspace/media-capabilities') {
      grants++
      return grants > 256 ? { ok: false, status: 429 } : { ok: true, status: 200, json: async () => ({ url: '/media/fixture' }) }
    }
    return mediaResponse()
  })
  const repository = create()
  for (let i = 0; i < 260; i++) expect((await repository.getImage(`album/${i}`))?.size).toBe(5)
  expect(grants).toBe(0)
  expect(mocks.fetch.mock.calls[0][0]).toBe('/api/workspace/media/album%2F0/chunks?offset=0&length=1048576')
})

it('assembles bounded chunks and rejects changed identity, truncated tails, and unknown failures', async () => {
  const size = 1024 * 1024, first = new Blob([new Uint8Array(size)]), tail = new Blob(['end'])
  const repository = create()
  mocks.fetch.mockResolvedValueOnce(mediaResponse(first, 0, size + 3)).mockResolvedValueOnce(mediaResponse(tail, size, size + 3))
  const image = await repository.getImage('a')
  expect(image?.size).toBe(size + 3)
  expect(image?.type).toBe('image/png')
  expect(await image?.slice(size).text()).toBe('end')
  expect(mocks.fetch.mock.calls[1][0]).toContain(`offset=${size}&length=${size}`)
  for (const response of [mediaResponse(tail, size, size + 3, 'changed'), mediaResponse(new Blob(['x']), size, size + 3), { ok: false, status: 404 }]) {
    mocks.fetch.mockResolvedValueOnce(mediaResponse(first, 0, size + 3)).mockResolvedValueOnce(response)
    await expect(repository.getImage('a')).rejects.toThrow('作品原图')
  }
  mocks.fetch.mockResolvedValueOnce({ ok: false, status: 404 })
  expect(await repository.getImage('missing')).toBeNull()
  mocks.fetch.mockResolvedValueOnce({ ok: false, status: 500 })
  await expect(repository.getImage('unknown')).rejects.toThrow('作品原图')
})
