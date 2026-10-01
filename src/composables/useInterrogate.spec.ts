import { afterEach, expect, it, vi } from 'vitest'
import { useInterrogate } from './useInterrogate'

vi.mock('@/composables/useTaskCenter', () => ({ useTrackedTask: vi.fn() }))
const file = () => new File(['image'], 'test.png', { type: 'image/png' })
const result = {
  ok: true, engine: 'pixai', model: 'pixai-tagger-v1.0', mode: 'tag', threshold: 0.17,
  tags: ['smile'], scores: { smile: 0.91 }, characterTags: ['fixture_character'],
  rating: { general: 0.95, sensitive: 0.04, questionable: 0.01, explicit: 0 }, caption: 'smile',
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

it.each([12 * 1024 * 1024 + 1, 20 * 1024 * 1024])('posts an image of %i bytes within the 20MB limit', async bytes => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(result)))
  vi.stubGlobal('fetch', fetchMock)
  const task = useInterrogate()
  const image = new File([new Uint8Array(bytes)], 'large.png', { type: 'image/png' })
  expect(await task.interrogate(image)).toMatchObject({ engine: 'pixai', characterTags: ['fixture_character'] })
  expect(fetchMock).toHaveBeenCalledOnce()
  const [url, options] = fetchMock.mock.calls[0]!
  expect(url).toBe('/api/interrogate')
  const body = JSON.parse(options.body)
  expect(body.threshold).toBe(0.17)
  expect(body.image).toHaveLength('data:image/png;base64,'.length + Math.ceil(bytes / 3) * 4)
  expect(task.busy.value).toBe(false)
})

it('rejects an image one byte over 20MB before reading or posting it', async () => {
  const read = vi.fn()
  const fetchMock = vi.fn()
  vi.stubGlobal('FileReader', read)
  vi.stubGlobal('fetch', fetchMock)
  const task = useInterrogate()
  const image = new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' })
  await expect(task.interrogate(image)).rejects.toThrow('图片超过 20MB 限制')
  expect(read).not.toHaveBeenCalled()
  expect(fetchMock).not.toHaveBeenCalled()
  expect(task.busy.value).toBe(false)
  expect(task.lastResult.value).toBeNull()
})

it('applies the 20MB limit to a downloaded current image before posting it', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array(20 * 1024 * 1024 + 1), {
    headers: { 'Content-Type': 'image/png' },
  }))
  vi.stubGlobal('fetch', fetchMock)
  const task = useInterrogate()
  await expect(task.interrogate('/current.png')).rejects.toThrow('图片超过 20MB 限制')
  expect(fetchMock).toHaveBeenCalledOnce()
  expect(fetchMock.mock.calls[0]?.[0]).toBe('/current.png')
  expect(task.busy.value).toBe(false)
})

it('continues rejecting files that are not images', async () => {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  const task = useInterrogate()
  await expect(task.interrogate(new File(['not an image'], 'test.txt', { type: 'text/plain' }))).rejects.toThrow('仅支持图片文件')
  expect(fetchMock).not.toHaveBeenCalled()
  expect(task.busy.value).toBe(false)
})

it('allows only one pending request and preserves its busy state', async () => {
  let resolve!: (value: Response) => void
  const fetchMock = vi.fn(() => new Promise<Response>(done => { resolve = done }))
  vi.stubGlobal('fetch', fetchMock)
  const task = useInterrogate()
  const first = task.interrogate(file())
  expect(await task.interrogate(file())).toBeNull()
  expect(task.busy.value).toBe(true)
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
  resolve(new Response(JSON.stringify(result)))
  expect(await first).toMatchObject({ engine: 'pixai', tags: ['smile'], characterTags: ['fixture_character'] })
  expect(task.busy.value).toBe(false)
})

it('rejects demo fallback and clears an older successful result', async () => {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(result)))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ...result, engine: 'heuristic' }))))
  const task = useInterrogate()
  await task.interrogate(file())
  await expect(task.interrogate(file())).rejects.toThrow('演示标签未写入')
  expect(task.lastResult.value).toBeNull()
  expect(task.busy.value).toBe(false)
})

it('aborts a stalled request and exposes the same readable error to its caller', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('FileReader', class {
    result = 'data:image/png;base64,aW1hZ2U='
    onload?: () => void
    readAsDataURL() { this.onload?.() }
  })
  vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
  })))
  const task = useInterrogate()
  const pending = expect(task.interrogate(file())).rejects.toThrow('反推超时')
  await vi.advanceTimersByTimeAsync(120_000)
  await pending
  expect(task.error.value).toContain('反推超时')
  expect(task.busy.value).toBe(false)
})

it('locks and cancels current-image loading before the POST begins', async () => {
  let resolve!: (value: Response) => void
  const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>(done => { resolve = done }))
  vi.stubGlobal('fetch', fetchMock)
  const task = useInterrogate()
  const pending = task.interrogate('/result-a.png')
  expect(task.busy.value).toBe(true)
  expect(await task.interrogate('/result-a.png')).toBeNull()
  task.cancel()
  expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  resolve(new Response('image', { headers: { 'Content-Type': 'image/png' } }))
  expect(await pending).toBeNull()
  expect(fetchMock).toHaveBeenCalledOnce()
  expect(task.error.value).toBeNull()
})

it('ignores a cancelled response without clearing the newer request state', async () => {
  let resolveOld!: (value: Response) => void
  let resolveNew!: (value: Response) => void
  const fetchMock = vi.fn()
    .mockImplementationOnce(() => new Promise<Response>(done => { resolveOld = done }))
    .mockImplementationOnce(() => new Promise<Response>(done => { resolveNew = done }))
  vi.stubGlobal('fetch', fetchMock)
  const task = useInterrogate()
  const first = task.interrogate(file())
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  task.cancel()
  const second = task.interrogate(file())
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  resolveOld(new Response(JSON.stringify(result)))
  expect(await first).toBeNull()
  expect(task.busy.value).toBe(true)
  expect(task.lastResult.value).toBeNull()
  resolveNew(new Response(JSON.stringify({ ...result, tags: ['sky'], scores: { sky: 0.87 } })))
  expect(await second).toMatchObject({ tags: ['sky'] })
})

it('aborts file reading on disposal and never posts a late file', async () => {
  const { effectScope } = await import('vue')
  let reader!: { onload?: () => void; abort: ReturnType<typeof vi.fn> }
  vi.stubGlobal('FileReader', class {
    result = 'data:image/png;base64,aW1hZ2U='
    onload?: () => void
    abort = vi.fn()
    readAsDataURL() { reader = this }
  })
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  const scope = effectScope()
  const task = scope.run(() => useInterrogate())!
  const pending = task.interrogate(file())
  scope.stop()
  expect(reader.abort).toHaveBeenCalledOnce()
  reader.onload?.()
  expect(await pending).toBeNull()
  expect(fetchMock).not.toHaveBeenCalled()
  expect(await task.interrogate(file())).toBeNull()
})

it('rejects malformed scores, incomplete ratings and character names mixed into general tags', async () => {
  const tooManyTags = Array.from({ length: 101 }, (_, index) => `tag_${index}`)
  const invalid = [
    { ...result, scores: { smile: 1.1 } },
    { ...result, rating: { general: 0.99 } },
    { ...result, tags: ['fixture_character'], scores: { fixture_character: 0.91 } },
    { ...result, tags: tooManyTags, scores: Object.fromEntries(tooManyTags.map(tag => [tag, 0.9])) },
  ]
  for (const response of invalid) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(response))))
    const task = useInterrogate()
    await expect(task.interrogate(file())).rejects.toThrow('无效 PixAI 结果')
    expect(task.lastResult.value).toBeNull()
  }
})

it('retains a real GPU failure without converting it to CPU or demo results', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    ok: false, code: 'PIXAI_OUT_OF_MEMORY', error: 'PixAI GPU 显存不足，请停止占用显存的任务后重试',
  }), { status: 503 }))
  vi.stubGlobal('fetch', fetchMock)
  const task = useInterrogate()
  await expect(task.interrogate(file())).rejects.toThrow('PixAI GPU 显存不足')
  expect(fetchMock).toHaveBeenCalledOnce()
  expect(task.lastResult.value).toBeNull()
  expect(task.busy.value).toBe(false)
})
