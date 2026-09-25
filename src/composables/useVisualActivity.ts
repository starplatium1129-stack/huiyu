import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, type Ref } from 'vue'
import { useDocumentVisibility, useIntersectionObserver, useMediaQuery, useMutationObserver } from '@vueuse/core'
import { prefersReducedMotion } from '@/utils/motionPreference'

/** Shared by the canvas effects and border beam; never starts a rendering loop itself. */
export function useVisualActivity(target: Ref<HTMLElement | null>) {
  const mounted = ref(false)
  const inViewport = ref(true)
  const appearanceRevision = ref(0)
  const visibility = useDocumentVisibility()
  const systemReduce = useMediaQuery('(prefers-reduced-motion: reduce)')

  // Watch only ancestors, not the animated element's per-frame style/class changes.
  const ancestors = computed(() => {
    const elements: HTMLElement[] = []
    let element = target.value?.parentElement ?? null
    while (element) {
      elements.push(element)
      element = element.parentElement
    }
    const root = target.value?.ownerDocument.documentElement
    if (root && !elements.includes(root)) elements.push(root)
    return elements
  })
  useMutationObserver(ancestors, () => { appearanceRevision.value += 1 }, {
    attributes: true,
    attributeFilter: ['data-motion', 'data-reduced-motion', 'data-theme', 'class', 'data-character',
      'data-power-mode', 'data-reduced-glass', 'data-fluid-effects'],
  })
  useIntersectionObserver(target, entries => {
    const entry = entries.find(item => item.target === target.value)
    if (entry) inViewport.value = entry.isIntersecting
  }, { rootMargin: '0px' })

  const reducedMotion = computed(() => {
    void systemReduce.value
    void appearanceRevision.value
    // The application's explicit full/reduce setting takes precedence over the OS.
    return prefersReducedMotion() || Boolean(target.value?.closest('[data-power-mode="efficiency"]'))
  })
  const lowEffects = computed(() => {
    void appearanceRevision.value
    return reducedMotion.value || Boolean(target.value?.closest('[data-reduced-glass="true"], [data-fluid-effects="low"]'))
  })
  const canPresent = computed(() => mounted.value && inViewport.value && visibility.value !== 'hidden')
  const canAnimate = computed(() => canPresent.value && !reducedMotion.value)

  onMounted(() => { mounted.value = true })
  onActivated(() => { mounted.value = true })
  onDeactivated(() => { mounted.value = false })
  onBeforeUnmount(() => { mounted.value = false })

  return { canPresent, canAnimate, reducedMotion, lowEffects, appearanceRevision }
}
