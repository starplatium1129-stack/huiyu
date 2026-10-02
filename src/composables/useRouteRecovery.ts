import { shallowRef } from 'vue'
import type { Router } from 'vue-router'

export const routeRecovery = shallowRef<{ target: string } | null>(null)

export function installRouteRecovery(router: Router) {
  router.onError((_error, to, from) => {
    // A superseded lazy import can reject after another destination has opened.
    // Its recovery action must not replace the user's newer navigation choice.
    if (router.currentRoute.value !== from) return
    routeRecovery.value = { target: to.fullPath }
  })
  router.afterEach((_to, _from, failure) => {
    if (!failure) routeRecovery.value = null
  })
}
