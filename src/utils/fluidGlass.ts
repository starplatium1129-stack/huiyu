import { observeWindowVisibility } from '@/platform/windowVisibility'

let installed: (() => void) | undefined

/** Painted mode has no pointer-light subscriptions or continuous frame loop. */
export function installFluidGlass(): () => void {
  if (installed) return installed
  if (typeof window === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
  const root = document.documentElement
  const queries = ['(forced-colors: active)', '(prefers-contrast: more)', '(prefers-reduced-transparency: reduce)']
    .map(query => window.matchMedia(query))
  let renderer: ReturnType<typeof import('./fluidGlassRenderer').mountFluidGlass> | undefined
  let disposed = false
  let visible = !document.hidden
  let mount: typeof import('./fluidGlassRenderer').mountFluidGlass | undefined
  let loading = false
  function reconcile() {
    if (disposed) return
    const enabled = root.dataset.glassMaterial === 'liquid' && root.dataset.fluidEffects !== 'low'
      && root.dataset.reducedGlass !== 'true' && !queries.some(query => query.matches)
    if (!enabled) { renderer?.stop(); renderer = undefined; return }
    if (mount) {
      if (visible) renderer ??= mount()
      renderer?.setPaused(!visible)
    } else if (visible && !loading) {
      loading = true
      void Promise.all([import('./fluidGlassRenderer'), import('../assets/css/glass-materials.css')]).then(([renderer]) => {
        mount = renderer.mountFluidGlass; loading = false; reconcile()
      }).catch(() => { loading = false /* Keep the existing frosted fallback if the optional chunk fails. */ })
    }
  }
  const preferences = new MutationObserver(reconcile)
  preferences.observe(root, { attributes: true, attributeFilter: ['data-glass-material', 'data-fluid-effects', 'data-reduced-glass'] })
  queries.forEach(query => query.addEventListener('change', reconcile))
  const stopVisibility = observeWindowVisibility(value => { visible = value; reconcile() })
  installed = () => {
    if (disposed) return
    disposed = true
    preferences.disconnect()
    queries.forEach(query => query.removeEventListener('change', reconcile))
    stopVisibility()
    renderer?.stop(); renderer = undefined; installed = undefined
  }
  return installed
}
