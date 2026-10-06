import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { usePromptBuilderStore } from './promptBuilderStore'
import { useSceneStore } from './sceneStore'
import { deferred, fullRoutes, response } from './sceneStoreTestFixtures'
import { resolveModelProfile } from '@/utils/promptPolicy'

beforeEach(() => { setActivePinia(createPinia()); localStorage.clear() })
afterEach(() => { vi.unstubAllGlobals() })

const catalog = { model_profiles: [{ id: 'anima_miaomiao_v12', engine: 'anima', model_id: 'anima-miaomiao-v1.2' }], presets: [] }

it('waits for a delayed model catalog before declaring the drawing data ready', async () => {
  const pending = deferred<Response>()
  const routes = fullRoutes() as Record<string, unknown>
  const fetcher = vi.fn(async (input: string | URL) => {
    const file = String(input).split('/data/')[1]!.split('?')[0]!
    return file === 'presets.json' ? pending.promise : response(routes[file] ?? [])
  })
  vi.stubGlobal('fetch', fetcher)
  const store = usePromptBuilderStore()
  const loading = store.loadData()
  await flushPromises()
  expect(useSceneStore().loaded).toBe(true)
  expect(store.dataReady).toBe(false)
  pending.resolve(response(catalog))
  await loading
  expect(store.dataReady).toBe(true)
  expect(resolveModelProfile(store.modelProfiles, 'anima-miaomiao-v1.2', 'anima')?.id).toBe('anima_miaomiao_v12')
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes('presets.json'))).toHaveLength(1)
})

it('reports a failed model catalog and can retry without retaining an empty snapshot', async () => {
  const routes = fullRoutes() as Record<string, unknown>
  let unavailable = true
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const file = String(input).split('/data/')[1]!.split('?')[0]!
    if (file === 'presets.json') return unavailable ? { ok: false, status: 503 } as Response : response(catalog)
    return response(routes[file] ?? [])
  }))
  const store = usePromptBuilderStore()
  await expect(store.loadData()).rejects.toThrow('presets.json HTTP 503')
  expect(store.dataReady).toBe(false)
  unavailable = false
  await store.loadData()
  expect(store.modelProfiles).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'anima_miaomiao_v12' }),
    expect.objectContaining({ model_id: 'anima-miaomiao-2.9b-beta1.1' }),
  ]))
  expect(store.dataReady).toBe(true)
})

it('fills newly bundled model profiles while preserving personal profiles and presets', async () => {
  const personal = { model_profiles: [{ id: 'my-miaomiao', engine: 'anima', model_id: 'anima-miaomiao-v1.6', cfg: 3.8,
    quality_prefix: 'user quality' }], presets: [{ id: 'my-preset', name: 'My preset' }] }
  const routes = fullRoutes() as Record<string, unknown>
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const file = String(input).split('/data/')[1]!.split('?')[0]!
    return response(file === 'presets.json' ? personal : routes[file] ?? [])
  }))
  const store = usePromptBuilderStore()
  await store.loadData()
  expect(store.modelProfiles.find(profile => profile.model_id === 'anima-miaomiao-v1.6')).toMatchObject({ id: 'my-miaomiao', cfg: 3.8, quality_prefix: 'user quality' })
  expect(store.modelProfiles.filter(profile => profile.model_id === 'anima-miaomiao-v1.6')).toHaveLength(1)
  expect(resolveModelProfile(store.modelProfiles, 'anima-miaomiao-2.9b-beta1.1', 'anima')).toMatchObject({ id: 'anima_miaomiao_29b_beta11', capabilities: { noLora: true, lora: false } })
  expect(store.presets).toEqual([expect.objectContaining({ id: 'my-preset' })])
  expect(useSceneStore().presets).toEqual(personal)
})
