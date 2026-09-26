import { runtimeFetch } from '../platform/runtimeUrl.ts'
import type { Router } from 'vue-router'
import { DATA_VERSION } from 'virtual:data-version'

const CORE_RESOURCE_ROUTES = new Set(['/scene-explorer', '/popular-scenes'])
const CORE_RESOURCE_FILES = [
  'curation.json', 'characters.json', 'popular-characters.json', 'scene-blueprints.json',
  'scenes-core.json', 'scenes-shared.json',
]
const SHOWCASE_THUMB_LIMIT = 4
let activeResourcePrefetch: { path: string; controller: AbortController } | null = null

function safeShowcaseUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const raw = value.trim()
    const path = raw.startsWith('/') ? raw : `/scene-showcase/${raw.replace(/^\/+/, '')}`
    const url = new URL(path, location.origin)
    return url.origin === location.origin && url.pathname.startsWith('/scene-showcase/') ? url.pathname + url.search : null
  } catch { return null }
}

async function prefetchCoreResources(signal: AbortSignal): Promise<void> {
  await Promise.all(CORE_RESOURCE_FILES.map(file =>
    runtimeFetch(`/data/${file}?v=${DATA_VERSION}`, { cache: 'force-cache', credentials: 'same-origin', signal })
      .then(response => { if (!response.ok) throw new Error(`${file} HTTP ${response.status}`) }),
  ))
}

async function prefetchShowcaseResources(signal: AbortSignal): Promise<void> {
  const response = await runtimeFetch('/scene-showcase/manifest.json', { cache: 'no-store', credentials: 'same-origin', signal })
  if (!response.ok) throw new Error(`showcase HTTP ${response.status}`)
  const raw = await response.json() as { entries?: Array<{ id?: unknown; thumb?: unknown; rating?: unknown }> }
  const urls = (Array.isArray(raw.entries) ? raw.entries : [])
    .filter(entry => entry.rating !== 'R18')
    .map(entry => safeShowcaseUrl(entry.thumb) || (typeof entry.id === 'string'
      ? safeShowcaseUrl(`/scene-showcase/thumbs/${encodeURIComponent(entry.id)}.jpg`)
      : null))
    .filter((url): url is string => Boolean(url))
    .slice(0, SHOWCASE_THUMB_LIMIT)
  await Promise.all(urls.map(url => runtimeFetch(url, { cache: 'force-cache', credentials: 'same-origin', signal })
    .then(response => { if (!response.ok) throw new Error(`thumbnail HTTP ${response.status}`) })))
}

/** Warm only committed-intent resources; hover transit remains module-only. */
export function prefetchRouteResources(path: string): void {
  const routePath = path.split(/[?#]/, 1)[0] || ''
  if (!CORE_RESOURCE_ROUTES.has(routePath) && routePath !== '/showcase') return
  if (activeResourcePrefetch?.path === routePath) return
  activeResourcePrefetch?.controller.abort()
  const controller = new AbortController()
  activeResourcePrefetch = { path: routePath, controller }
  const task = routePath === '/showcase'
    ? prefetchShowcaseResources(controller.signal)
    : prefetchCoreResources(controller.signal)
  void task.catch(error => {
    if (!controller.signal.aborted) console.warn(`[route-prefetch] ${routePath}`, error)
  }).finally(() => {
    if (activeResourcePrefetch?.controller === controller) activeResourcePrefetch = null
  })
}

/** Share imports across links while allowing failed attempts to be warmed again. */
export function createRoutePrefetcher(router: Router) {
  const warmed = new WeakMap<() => Promise<unknown>, Promise<boolean>>()
  return async (path: string): Promise<boolean> => {
    const route = router.resolve(path)
    if (!route.matched.length || route.name === 'not-found') return false
    const results = await Promise.all(route.matched.map(record => {
      const component = record.components?.default
      if (typeof component !== 'function') return true
      const loader = component as () => Promise<unknown>
      let pending = warmed.get(loader)
      if (!pending) {
        pending = Promise.resolve().then(loader).then(() => true, () => {
          warmed.delete(loader)
          return false
        })
        warmed.set(loader, pending)
      }
      return pending
    }))
    return results.every(Boolean)
  }
}
