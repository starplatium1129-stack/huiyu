let installed: (() => void) | undefined

/** Light mode has no canvas maps, SVG filters, surface observers or continuous frame loop. */
export function installFluidGlass(): () => void {
  if (installed) return installed
  if (typeof window === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
  const root = document.documentElement
  const queries = ['(forced-colors: active)', '(prefers-contrast: more)', '(prefers-reduced-transparency: reduce)']
    .map(query => window.matchMedia(query))
  let stop: (() => void) | undefined
  let disposed = false
  let mount: (() => () => void) | undefined
  let loading = false
  function reconcile() {
    if (disposed) return
    const enabled = root.dataset.glassMaterial === 'liquid' && root.dataset.fluidEffects !== 'low'
      && root.dataset.reducedGlass !== 'true' && !document.hidden && !queries.some(query => query.matches)
    if (enabled && mount) stop ??= mount()
    else if (enabled && !loading) {
      loading = true
      void Promise.all([import('./fluidGlassRenderer'), import('../assets/css/glass-materials.css')]).then(([renderer]) => {
        mount = renderer.mountFluidGlass; loading = false; reconcile()
      }).catch(() => { loading = false /* Keep the existing frosted fallback if the optional chunk fails. */ })
    }
    else { stop?.(); stop = undefined }
  }
  const preferences = new MutationObserver(reconcile)
  preferences.observe(root, { attributes: true, attributeFilter: ['data-glass-material', 'data-fluid-effects', 'data-reduced-glass'] })
  queries.forEach(query => query.addEventListener('change', reconcile))
  document.addEventListener('visibilitychange', reconcile)
  reconcile()
  installed = () => {
    if (disposed) return
    disposed = true
    preferences.disconnect()
    queries.forEach(query => query.removeEventListener('change', reconcile))
    document.removeEventListener('visibilitychange', reconcile)
    stop?.(); stop = undefined; installed = undefined
  }
  return installed
}
