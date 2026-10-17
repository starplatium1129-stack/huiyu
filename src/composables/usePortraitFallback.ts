import { computed, onScopeDispose, readonly, ref, shallowRef, watch, type Ref } from 'vue'
import { runtimeResourceCors, runtimeResourceIdentity } from '@/platform/runtimeUrl'

export interface PortraitSources { id: string; main: string; thumb: string }
interface PortraitFrame {
  id: string; identity: string; src: string; source: string; token: string
  state: 'main' | 'fallback' | 'missing'; reason: 'empty' | 'broken' | 'nothumb'
  crossorigin?: 'anonymous'; continued?: boolean
}

/** Each source configuration gets one bounded attempt chain; event tokens exclude stale DOM events. */
export function usePortraitFallback(sources: Readonly<Ref<PortraitSources>>) {
  const generation = ref(0), retryVersion = ref(0)
  const failed = ref(new Set<string>())
  const painted = shallowRef<PortraitFrame | null>(null)
  let alive = true
  onScopeDispose(() => { alive = false; painted.value = null })
  function reset(manual = false) {
    generation.value += 1
    failed.value = new Set()
    retryVersion.value = manual ? generation.value : 0
  }
  // Only the same character in the same runtime may keep an already decoded frame.
  watch([() => sources.value.id, () => sources.value.main, () => sources.value.thumb, runtimeResourceIdentity], ([id, main, thumb, identity], previous) => {
    if (id !== previous?.[0] || identity !== previous?.[3] || (!main && !thumb)) painted.value = null
    reset()
  }, { immediate: true, flush: 'sync' })

  const view = computed<PortraitFrame>(() => {
    const { main, thumb } = sources.value
    const fallback = thumb && thumb !== main ? thumb : ''
    const state = main && !failed.value.has(main) ? 'main'
      : fallback && !failed.value.has(fallback) ? 'fallback' : 'missing'
    const source = state === 'main' ? main : state === 'fallback' ? fallback : ''
    let src = source
    if (src && retryVersion.value && !/^(data:|blob:)/.test(src)) {
      try { const url = new URL(src, location.href); url.searchParams.set('_portraitRetry', String(retryVersion.value)); src = url.href }
      catch { /* Invalid URLs still reach the bounded native image-error path. */ }
    }
    const reason = !main && !fallback ? 'empty' : fallback ? 'broken' : 'nothumb'
    return { id: sources.value.id, identity: runtimeResourceIdentity(), state, src, source, reason,
      crossorigin: runtimeResourceCors(), token: `${generation.value}:${state}:${src}` }
  })
  // A decoded candidate keeps its keyed DOM node when it becomes the painted frame.
  const frames = computed(() => [
    ...(painted.value ? [painted.value] : []),
    ...(view.value.src && view.value.token !== painted.value?.token ? [view.value] : []),
  ])
  const pending = computed(() => !!view.value.src && view.value.token !== painted.value?.token)
  const error = computed(() => view.value.state === 'missing' && view.value.reason !== 'empty')
  function current(token: string, image: HTMLImageElement) {
    const frame = frames.value.find(item => item.token === token)
    return alive && frame && frame.id === sources.value.id && frame.identity === runtimeResourceIdentity()
      && image.isConnected && image.dataset.attemptToken === token && image.getAttribute('src') === frame.src ? frame : null
  }
  function fail(token: string, image: HTMLImageElement) {
    if (!current(token, image)) return
    if (painted.value?.token === token) painted.value = null
    if (token === view.value.token && view.value.state !== 'missing')
      failed.value = new Set(failed.value).add(view.value.source)
  }
  async function loaded(token: string, image: HTMLImageElement) {
    if (token !== view.value.token || painted.value?.token === token || !current(token, image) || !image.naturalWidth || !image.naturalHeight) return
    try { if (typeof image.decode === 'function') await image.decode() }
    catch { fail(token, image); return }
    if (token === view.value.token && current(token, image) && image.complete && image.naturalWidth && image.naturalHeight) {
      painted.value = { ...view.value, continued: !!painted.value }
    }
  }
  function retry() { if (alive) reset(true) }
  return { view, frames, painted: readonly(painted), pending, error, fail, loaded, retry }
}
