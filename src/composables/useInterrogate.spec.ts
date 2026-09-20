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
