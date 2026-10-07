import { runtimeFetch } from '../platform/runtimeUrl.ts'
import { isLocalStudioHost } from '../utils/runtimeEnvironment'
import type { Router } from 'vue-router'
import { DATA_VERSION } from 'virtual:data-version'

const CORE_RESOURCE_ROUTES = new Set(['/scene-explorer', '/popular-scenes'])
const CORE_RESOURCE_FILES = ['curation.json', 'scenes-core.json', 'scenes-shared.json']
const BLUEPRINT_RESOURCE_FILES = ['curation.json', 'popular-characters.json']
let activeResourcePrefetch: { path: string; controller: AbortController } | null = null

async function prefetchCoreResources(signal: AbortSignal, path: string): Promise<void> {
  const files = path === '/popular-scenes'
    ? [...BLUEPRINT_RESOURCE_FILES, ...(isLocalStudioHost() ? [] : ['scene-blueprints.json'])]
    : CORE_RESOURCE_FILES
  await Promise.all(files.map(file =>
    runtimeFetch(`/data/${file}?v=${DATA_VERSION}`, { cache: 'force-cache', credentials: 'same-origin', signal })
      .then(response => { if (!response.ok) throw new Error(`${file} HTTP ${response.status}`) }),
  ))
}

/** Warm only committed-intent resources; hover transit remains module-only. */
export function prefetchRouteResources(path: string): void {
  const routePath = path.split(/[?#]/, 1)[0] || ''
  // The showcase owns its fresh manifest and visible thumbnails; fetching a
  // second no-store manifest here cannot warm that request or its parsed result.
  if (!CORE_RESOURCE_ROUTES.has(routePath)) return
  if (activeResourcePrefetch?.path === routePath) return
  activeResourcePrefetch?.controller.abort()
  const controller = new AbortController()
  activeResourcePrefetch = { path: routePath, controller }
  const task = prefetchCoreResources(controller.signal, routePath)
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
