import { afterEach, expect, it, vi } from 'vitest'
import { useInterrogate } from './useInterrogate'
import { effectScope } from 'vue'
import { apiClient } from '@/api/client'
import { decodeInterrogateReadiness, useInterrogateReadiness } from './useInterrogateReadiness'

vi.mock('@/composables/useTaskCenter', () => ({ useTrackedTask: vi.fn() }))
const status = { ok: true, local: true, defaultEngine: 'pixai', pixai: {
  engine: 'pixai', model: 'pixai-tagger-v1.0', available: true, modelPresent: true, dependencyPresent: true, reason: null,
} }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('rejects legacy or incomplete status and never treats file evidence as GPU validation', () => {
  for (const invalid of [{ ok: true }, { ...status, defaultEngine: 'wd14' }, { ...status, pixai: { ...status.pixai, modelPresent: undefined } }]) {
    expect(() => decodeInterrogateReadiness(invalid)).toThrow('状态返回无效')
  }
  expect(decodeInterrogateReadiness({ ...status, pixai: { ...status.pixai, cached: true, reason: '上次 CUDA 显存不足' } }).message).toContain('模型缓存已建立。上次运行信息：上次 CUDA 显存不足')
  expect(decodeInterrogateReadiness(status)).toMatchObject({ state: 'ready', message: expect.stringContaining('实际加载、CUDA 与反推效果仍需在使用时验证') })
})

it('does not let a superseded check or disposed response resurrect readiness', async () => {
  const responses: Array<{ signal: AbortSignal; resolve(value: typeof status): void }> = []
  vi.spyOn(apiClient, 'request').mockImplementation((_path, options) => new Promise(resolve => { responses.push({ signal: options!.signal!, resolve }) }))
  const scope = effectScope(), readiness = scope.run(useInterrogateReadiness)!
  const older = readiness.refresh(), current = readiness.refresh()
  expect(responses[0].signal.aborted).toBe(true)
  responses[1].resolve(status); expect(await current).toBe(true)
  responses[0].resolve({ ...status, pixai: { ...status.pixai, available: false } })
  expect(await older).toBe(false); expect(readiness.available.value).toBe(true)
  const final = readiness.refresh(); scope.stop()
  expect(responses[2].signal.aborted).toBe(true)
  responses[2].resolve(status); expect(await final).toBe(false)
  expect(readiness.available.value).toBe(false)
})


it('keeps File and URL reads behind real readiness and uploads only after files become available', async () => {
  const order: string[] = [], read = vi.fn()
  let available = false
  vi.spyOn(apiClient, 'request').mockImplementation(async path => {
    expect(path).toBe('/api/interrogate/status'); order.push('status')
    return { ...status, pixai: { ...status.pixai, available, modelPresent: available } }
  })
  const upload = vi.fn(async () => {
    order.push('upload')
    return new Response(JSON.stringify({ ok: true, engine: 'pixai', model: 'pixai-tagger-v1.0', mode: 'tag', threshold: .17,
      tags: ['jacket'], scores: { jacket: .9 }, characterTags: [], caption: 'jacket',
      rating: { general: 1, sensitive: 0, questionable: 0, explicit: 0 } }))
  })
  vi.stubGlobal('fetch', upload)
  const task = useInterrogate()
  const originalReader = globalThis.FileReader
  vi.stubGlobal('FileReader', class extends originalReader { override readAsDataURL(blob: Blob) { read(); super.readAsDataURL(blob) } })
  await expect(task.interrogate(new File(['image'], 'source.png', { type: 'image/png' }))).rejects.toThrow('缺少完整 PixAI')
  await expect(task.interrogate('/current.png')).rejects.toThrow('缺少完整 PixAI')
  expect(read).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled()
  available = true
  await expect(task.interrogate(new File(['image'], 'source.png', { type: 'image/png' }))).resolves.toMatchObject({ tags: ['jacket'] })
  expect(read).toHaveBeenCalledOnce()
  expect(order).toEqual(['status', 'status', 'status', 'upload'])
})
