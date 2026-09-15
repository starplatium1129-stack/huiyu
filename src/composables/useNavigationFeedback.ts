import { computed, readonly, ref, shallowRef } from 'vue'
import { isNavigationFailure, NavigationFailureType, type Router, type RouteLocationNormalized } from 'vue-router'

const target = shallowRef<RouteLocationNormalized | null>(null)
const loading = ref(false)
const pendingPath = computed(() => target.value?.path ?? '')

export function useNavigationFeedback() {
  return { pendingPath, loading: readonly(loading) }
}

/** An older cancelled navigation must not clear the newest destination's feedback. */
export function installNavigationFeedback(router: Router) {
  let timer: ReturnType<typeof setTimeout> | undefined
  function finish() {
    clearTimeout(timer)
    target.value = null
    loading.value = false
  }
  const before = router.beforeEach((to, from) => {
    finish()
    if (!from.matched.length) return
    target.value = to
    timer = setTimeout(() => { if (target.value === to) loading.value = true }, 180)
  })
  const after = router.afterEach((to, _from, failure) => {
    if (target.value === to || isNavigationFailure(failure, NavigationFailureType.duplicated)) finish()
  })
  const error = router.onError((_error, to) => { if (target.value === to) finish() })
  return () => { finish(); before(); after(); error() }
}
