import { shallowRef } from 'vue'
import { isNavigationFailure, NavigationFailureType, type Router, type RouteLocationNormalized } from 'vue-router'

export const routeRecovery = shallowRef<{ target: string } | null>(null)

export function installRouteRecovery(router: Router) {
  let latestTarget: RouteLocationNormalized | null = null
  router.beforeEach(to => { latestTarget = to })
  router.onError((_error, to, from) => {
    // A superseded import can reject while the newer destination is still
    // loading, with the old current route unchanged. Recover only the latest.
    if (latestTarget !== to || router.currentRoute.value !== from) return
    routeRecovery.value = { target: to.fullPath }
  })
  router.afterEach((to, _from, failure) => {
    // Returning to the current page cancels a pending destination without
    // running beforeEach, but its late import must still be ignored.
    if (isNavigationFailure(failure, NavigationFailureType.duplicated)) latestTarget = to
    if (!failure) routeRecovery.value = null
  })
}
