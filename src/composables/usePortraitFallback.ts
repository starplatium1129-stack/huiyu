import { computed, ref, watch, type Ref } from 'vue'

export interface PortraitSources { id: string; main: string; thumb: string }

/** Each source configuration gets one bounded attempt chain; event tokens exclude stale DOM events. */
export function usePortraitFallback(sources: Readonly<Ref<PortraitSources>>) {
  const generation = ref(0)
  const failed = ref(new Set<string>())
  const loadedToken = ref('')
  const ratio = ref(0.7)
  watch(() => [sources.value.id, sources.value.main, sources.value.thumb], () => {
    generation.value += 1
    failed.value = new Set()
    loadedToken.value = ''
    ratio.value = 0.7
  }, { immediate: true, flush: 'sync' })

  const view = computed(() => {
    const { main, thumb } = sources.value
    const fallback = thumb && thumb !== main ? thumb : ''
    const state = main && !failed.value.has(main) ? 'main'
      : fallback && !failed.value.has(fallback) ? 'fallback' : 'missing'
    const src = state === 'main' ? main : state === 'fallback' ? fallback : ''
    const reason = !main && !fallback ? 'empty' : fallback ? 'broken' : 'nothumb'
    return { state, src, reason, token: `${generation.value}:${state}:${src}` }
  })
  function fail(token: string) {
    if (token !== view.value.token || view.value.state === 'missing') return
    failed.value = new Set(failed.value).add(view.value.src)
    loadedToken.value = ''
  }
  function loaded(token: string, width: number, height: number) {
    if (token !== view.value.token || view.value.state === 'missing' || width <= 0 || height <= 0) return
    loadedToken.value = token
    ratio.value = width / height
  }
  return { view, ratio, fail, loaded, isLoaded: computed(() => loadedToken.value === view.value.token) }
}
