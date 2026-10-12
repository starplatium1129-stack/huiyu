import { computed, readonly, ref, shallowRef } from 'vue'
import { isNavigationFailure, NavigationFailureType, type Router, type RouteLocationNormalized } from 'vue-router'
import { beginUiFluidityNavigation, markUiFluidityNavigation } from '@/utils/uiFluidityMeasurement'

const target = shallowRef<RouteLocationNormalized | null>(null)
const loading = ref(false)
const pendingPath = computed(() => target.value?.path ?? '')
const intentPath = shallowRef('')
const intentRoutePath = computed(() => intentPath.value.split(/[?#]/, 1)[0] || '')
let navigationId: number | null = null

let nextNavigationId = 0
let intentToken: number | null = null
let intentTimer: ReturnType<typeof setTimeout> | undefined

function clearIntent(path?: string) {
  if (path && intentPath.value !== path) return
  clearTimeout(intentTimer)
  intentTimer = undefined
  intentPath.value = ''
  intentToken = null
}

/** Record the activation before the router starts lazy resolution/re-rendering. */
export function announceNavigationIntent(path: string): void {
  if (!path || (intentPath.value === path && intentToken !== null)) return
  const id = ++nextNavigationId
  intentPath.value = path
  intentToken = id
  navigationId = id
  clearTimeout(intentTimer)
  intentTimer = setTimeout(() => {
    // A real navigation clears this timer in beforeEach. An older pending
    // route may still be loading; it does not own this intent.
    if (intentToken !== id) return
    clearIntent(path)
    if (navigationId === id) navigationId = null
  }, 1000)
}

export function useNavigationFeedback() {
  return {
    pendingPath,
    intentRoutePath,
    loading: readonly(loading),
  }
}

/** An older cancelled navigation must not clear the newest destination's feedback. */
export function installNavigationFeedback(router: Router) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let measurementNavigationId: number | null = null
  let activeNavigationId: number | null = null
  let activeRoutePath = ''
  function finish() {
    clearTimeout(timer)
    target.value = null
    loading.value = false
    if (activeNavigationId !== null && navigationId === activeNavigationId) {
      clearIntent(activeRoutePath)
    }
    activeNavigationId = null
    activeRoutePath = ''
    measurementNavigationId = null
  }
  const before = router.beforeEach((to, from) => {
    finish()
    if (!from.matched.length) return
    activeNavigationId = intentPath.value === to.fullPath && intentToken !== null
      ? intentToken
      : ++nextNavigationId
    activeRoutePath = to.fullPath
    clearTimeout(intentTimer)
    navigationId = activeNavigationId
    measurementNavigationId = beginUiFluidityNavigation(to.fullPath)
    target.value = to
    timer = setTimeout(() => {
      if (target.value === to) {
        loading.value = true
        markUiFluidityNavigation(measurementNavigationId, 'feedback-committed', to.fullPath)
      }
    }, 180)
  })
  const after = router.afterEach((to, _from, failure) => {
    if (target.value === to || isNavigationFailure(failure, NavigationFailureType.duplicated)) {
      if (failure) markUiFluidityNavigation(measurementNavigationId, 'cancelled', to.fullPath)
      finish()
    }
  })
  const error = router.onError((_error, to) => {
    if (target.value === to) {
      markUiFluidityNavigation(measurementNavigationId, 'cancelled', to.fullPath)
      finish()
    }
  })
  return () => { finish(); before(); after(); error() }
}
