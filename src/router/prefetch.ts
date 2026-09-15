import type { Router } from 'vue-router'

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
