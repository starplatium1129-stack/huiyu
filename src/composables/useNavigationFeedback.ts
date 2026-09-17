import { computed, readonly, ref, shallowRef } from 'vue'
import { isNavigationFailure, NavigationFailureType, type Router, type RouteLocationNormalized } from 'vue-router'
import { beginUiFluidityNavigation, markUiFluidityNavigation } from '@/utils/uiFluidityMeasurement'

const target = shallowRef<RouteLocationNormalized | null>(null)
const loading = ref(false)
const pendingPath = computed(() => target.value?.path ?? '')
const intentPath = shallowRef('')
const intentRoutePath = computed(() => intentPath.value.split(/[?#]/, 1)[0] || '')
const navigationId = ref<number | null>(null)
const navigationPhase = ref<'idle' | 'intent' | 'pending' | 'loading' | 'completed' | 'cancelled' | 'failed'>('idle')

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
export function announceNavigationIntent(path: string): number | null {
  if (!path) return null
  if (intentPath.value === path && intentToken !== null) return intentToken
  const id = ++nextNavigationId
  intentPath.value = path
  intentToken = id
  navigationId.value = id
  navigationPhase.value = 'intent'
  clearTimeout(intentTimer)
  intentTimer = setTimeout(() => {
    if (intentToken !== id || navigationPhase.value !== 'intent') return
    clearIntent(path)
    if (navigationId.value === id) {
      navigationId.value = null
      navigationPhase.value = 'idle'
    }
  }, 1000)
  return id
}

export function useNavigationFeedback() {
  return {
    pendingPath,
    intentPath: readonly(intentPath),
    intentRoutePath,
    loading: readonly(loading),
    navigationId: readonly(navigationId),
    navigationPhase: readonly(navigationPhase),
  }
}

/** An older cancelled navigation must not clear the newest destination's feedback. */
export function installNavigationFeedback(router: Router) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let measurementNavigationId: number | null = null
  let activeNavigationId: number | null = null
  let activeRoutePath = ''
  function finish(outcome: 'completed' | 'cancelled' | 'failed' = 'completed') {
    clearTimeout(timer)
    target.value = null
    loading.value = false
    if (activeNavigationId !== null && navigationId.value === activeNavigationId) {
      clearIntent(activeRoutePath)
      navigationPhase.value = outcome
    }
    activeNavigationId = null
    activeRoutePath = ''
    measurementNavigationId = null
  }
  const before = router.beforeEach((to, from) => {
    finish('cancelled')
    if (!from.matched.length) return
    activeNavigationId = intentPath.value === to.fullPath && intentToken !== null
      ? intentToken
      : ++nextNavigationId
    activeRoutePath = to.fullPath
    clearTimeout(intentTimer)
    navigationId.value = activeNavigationId
    navigationPhase.value = 'pending'
    measurementNavigationId = beginUiFluidityNavigation(to.fullPath)
    target.value = to
    timer = setTimeout(() => {
      if (target.value === to) {
        loading.value = true
        navigationPhase.value = 'loading'
        markUiFluidityNavigation(measurementNavigationId, 'feedback-committed', to.fullPath)
      }
    }, 180)
  })
  const after = router.afterEach((to, _from, failure) => {
    if (target.value === to || isNavigationFailure(failure, NavigationFailureType.duplicated)) {
      if (failure) markUiFluidityNavigation(measurementNavigationId, 'cancelled', to.fullPath)
      finish(failure ? 'cancelled' : 'completed')
    }
  })
  const error = router.onError((_error, to) => {
    if (target.value === to) {
      markUiFluidityNavigation(measurementNavigationId, 'cancelled', to.fullPath)
      finish('failed')
    }
  })
  return () => { finish(); before(); after(); error() }
}
