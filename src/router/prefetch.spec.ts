import { expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createRoutePrefetcher } from './prefetch'

it('deduplicates concurrent intent across query strings and shared layout imports', async () => {
  const layout = vi.fn(async () => ({})), page = vi.fn(async () => ({}))
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/', component: layout, children: [{ path: 'page', component: page }] },
  ] })
  const warm = createRoutePrefetcher(router)
  expect(await Promise.all([warm('/page?a=1'), warm('/page?a=2')])).toEqual([true, true])
  await warm('/page')
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
