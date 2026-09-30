import { afterEach, expect, it, vi } from 'vitest'
import { useInterrogate } from './useInterrogate'

vi.mock('@/composables/useTaskCenter', () => ({ useTrackedTask: vi.fn() }))
const file = () => new File(['image'], 'test.png', { type: 'image/png' })
const result = { ok: true, engine: 'wd14', tags: ['smile'], caption: 'smile' }
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

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
  expect(await first).toMatchObject({ engine: 'wd14' })
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
  resolveNew(new Response(JSON.stringify({ ...result, tags: ['sky'] })))
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
