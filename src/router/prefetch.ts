import type { Router } from 'vue-router'
import { loadPromptDrawingWorkspace, prefetchDrawingResources } from './routeFeatures'
import { loadRoomComponent, type RoomPage } from './roomResources'

async function prefetchPrimaryRouteFeature(path: string): Promise<boolean> {
  if (['/chat', '/companion', '/companion-chat'].includes(path)) {
    try { await loadRoomComponent(path.slice(1) as RoomPage); return true }
    catch { return false }
  }
  if (path !== '/prompt-builder') return true
  try {
    await loadPromptDrawingWorkspace()
    return true
  } catch {
    return false
  }
}

/** Warm only committed-intent resources; hover transit remains module-only. */
export function prefetchRouteResources(path: string): void {
  const routePath = path.split(/[?#]/, 1)[0] || ''
  if (routePath === '/prompt-builder') {
    prefetchDrawingResources()
    return
  }
  if (routePath !== '/popular-scenes' && routePath !== '/scene-explorer') return
  void import('@/stores/sceneStore').then(({ useSceneStore }) => {
    const store = useSceneStore()
    return routePath === '/popular-scenes' ? store.loadCharacterDirectory() : store.prefetchCoreScenes()
  }).catch(error => console.warn(`[route-prefetch] ${routePath}`, error))
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
    return results.every(Boolean) && await prefetchPrimaryRouteFeature(route.path)
  }
}
