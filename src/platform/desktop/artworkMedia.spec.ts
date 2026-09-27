import { afterEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), runtime: { runtimeEpoch: 'epoch-1', workspace: { generation: 1 } } }))
vi.mock('./runtime', () => ({ desktopRuntimeFetch: mocks.fetch, getDesktopRuntime: () => ({ bootstrap: { runtime: mocks.runtime } }) }))
import { createDesktopArtworkMedia } from './artworkMedia'

afterEach(() => { mocks.fetch.mockReset(); mocks.runtime.runtimeEpoch = 'epoch-1'; mocks.runtime.workspace.generation = 1 })

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

it('coalesces concurrent original reads and releases the completed blob from its request map', async () => {
  const blob = new Blob(['fixture'], { type: 'image/png' })
  mocks.fetch.mockImplementation(async (url: string) => url.endsWith('/media-capabilities')
    ? { status: 200, ok: true, json: async () => ({ url: '/api/workspace/media-content/a?cap=fixture' }) }
    : { ok: true, blob: async () => blob })
  const media = createDesktopArtworkMedia(() => {}, vi.fn())
  expect(await Promise.all([media.getImage('a'), media.getImage('a')])).toEqual([blob, blob])
  expect(mocks.fetch).toHaveBeenCalledTimes(2)
  expect(await media.getImage('a')).toBe(blob)
  expect(mocks.fetch).toHaveBeenCalledTimes(4)
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
