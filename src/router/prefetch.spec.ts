import { beforeEach, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createRoutePrefetcher, prefetchRouteResources } from './prefetch'

const access = vi.hoisted(() => ({ local: true }))
vi.mock('../utils/runtimeEnvironment', () => ({ isLocalStudioHost: () => access.local }))
beforeEach(() => { access.local = true })

it('warms only the data owned by the selected browsing route', async () => {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(new URL(url, location.origin).pathname.split('/').pop()!)
    return { ok: true }
  }))
  try {
    prefetchRouteResources('/scene-explorer')
    await vi.waitFor(() => expect(calls).toHaveLength(3))
    expect(calls.sort()).toEqual(['curation.json', 'scenes-core.json', 'scenes-shared.json'])
    calls.length = 0
    prefetchRouteResources('/popular-scenes')
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(calls.sort()).toEqual(['curation.json', 'popular-characters.json'])
  } finally { vi.unstubAllGlobals() }
})


it('retains the remote blueprint aggregate fallback', async () => {
  access.local = false
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(new URL(url, location.origin).pathname.split('/').pop()!)
    return { ok: true }
  }))
  try {
    prefetchRouteResources('/popular-scenes')
    await vi.waitFor(() => expect(calls).toHaveLength(3))
    expect(calls.sort()).toEqual(['curation.json', 'popular-characters.json', 'scene-blueprints.json'])
  } finally { vi.unstubAllGlobals() }
})

it('deduplicates concurrent intent across query strings and shared layout imports', async () => {
  const layout = vi.fn(async () => ({})), page = vi.fn(async () => ({}))
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/', component: layout, children: [{ path: 'chat', component: page }] },
  ] })
  const warm = createRoutePrefetcher(router)
  expect(await Promise.all([warm('/chat?a=1'), warm('/chat?a=2')])).toEqual([true, true])
  await warm('/chat')
  expect(layout).toHaveBeenCalledTimes(1)
  expect(page).toHaveBeenCalledTimes(1)
  expect(router.currentRoute.value.matched).toHaveLength(0)
})

it('retries failed imports while retaining a successfully warmed parent', async () => {
  const layout = vi.fn(async () => ({}))
  const page = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({})
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/', component: layout, children: [{ path: 'page', component: page }] },
  ] })
  const warm = createRoutePrefetcher(router)
  expect(await warm('/page')).toBe(false)
  expect(await warm('/page')).toBe(true)
  expect(layout).toHaveBeenCalledTimes(1)
  expect(page).toHaveBeenCalledTimes(2)
})

it('does not warm the catch-all page for downloads or documentation URLs', async () => {
  const missing = vi.fn(async () => ({}))
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/:pathMatch(.*)*', name: 'not-found', component: missing },
  ] })
  expect(await createRoutePrefetcher(router)('/docs/getting-started.html')).toBe(false)
  expect(missing).not.toHaveBeenCalled()
})
