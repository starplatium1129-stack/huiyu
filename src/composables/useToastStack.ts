import { computed, nextTick, onMounted, onScopeDispose, ref, watch, type Ref } from 'vue'
import { useToast } from '@/composables/useToast'
import { useMotionPreference } from '@/composables/useMotionPreference'

/** Lucian #070 · MIT (c) 2026 Seokwoooo. Stack geometry is independent of
 * each notice's entrance and pointer motion. No per-frame Vue updates. */
export function useToastStack(host: Ref<HTMLElement | null>) {
  const { toasts, coverToasts, pauseAll, resumeAll } = useToast()
  const expanded = ref(false), heights = ref<Record<number, number>>({})
  const announcement = ref({ id: 0, msg: '' })
  const reduced = useMotionPreference()
  const slots = new Map<number, HTMLElement>()
  let observer: ResizeObserver | undefined, hovered = false
  const newestFirst = computed(() => [...toasts.value].reverse())
  const positions = computed(() => {
    let offset = 0
    return new Map(newestFirst.value.map((item, index) => {
      const y = expanded.value ? offset : index * 10
      offset += (heights.value[item.id] ?? 64) + 8
      return [item.id, { y, index }]
    }))
  })
  const stackHeight = computed(() => Math.max(0, ...newestFirst.value.map(item =>
    (positions.value.get(item.id)?.y ?? 0) + (heights.value[item.id] ?? 64))))
  function bindSlot(value: unknown, id: number) {
    const previous = slots.get(id)
    if (previous === value) return
    if (previous) observer?.unobserve(previous)
    if (value instanceof HTMLElement) { slots.set(id, value); observer?.observe(value) }
    else { slots.delete(id); delete heights.value[id] }
  }
  function slotStyle(id: number) {
    const { y, index } = positions.value.get(id) ?? { y: 0, index: 0 }
    return { transform: `translateY(${-y}px) scale(${expanded.value ? 1 : Math.max(.88, 1 - index * .035)})`, zIndex: toasts.value.length - index, opacity: !expanded.value && index > 2 ? 0 : 1 }
  }
  function hidden(id: number) { return !expanded.value && id !== toasts.value.at(-1)?.id }
  function enter(event: PointerEvent) { if (event.pointerType !== 'mouse') return; hovered = true; expanded.value = true }
  function leave() { hovered = false; if (!host.value?.contains(document.activeElement)) expanded.value = false }
  function focusOut(event: FocusEvent) { if (!hovered && !host.value?.contains(event.relatedTarget as Node | null)) expanded.value = false }
  function outside(event: PointerEvent) { if (!host.value?.contains(event.target as Node)) expanded.value = false }
  watch([expanded, () => toasts.value.map(item => item.id)], () => {
    coverToasts(expanded.value ? [] : toasts.value.slice(0, -1).map(item => item.id))
    if (expanded.value) pauseAll('toast-stack')
    else resumeAll('toast-stack')
    const latest = toasts.value.at(-1)
    if (latest && latest.id > announcement.value.id) announcement.value = { id: latest.id, msg: latest.msg }
    // A removed focused button may not emit focusout; release that expansion too.
    void nextTick(() => { if (!toasts.value.length || !hovered && !host.value?.contains(document.activeElement)) expanded.value = false })
  }, { immediate: true })
  watch(expanded, async value => {
    if (!value) return
    await nextTick()
    if (host.value) host.value.scrollTop = host.value.scrollHeight
  })
  onMounted(() => {
    observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        const id = Number((entry.target as HTMLElement).dataset.toastId)
        heights.value[id] = entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height
      }
    })
    for (const element of slots.values()) observer.observe(element)
    document.addEventListener('pointerdown', outside, true)
  })
  onScopeDispose(() => {
    observer?.disconnect(); slots.clear()
    document.removeEventListener('pointerdown', outside, true)
    coverToasts([]); resumeAll('toast-stack')
  })
  return { expanded, reduced, announcement, stackHeight, bindSlot, slotStyle, hidden, enter, leave, focusOut }
}
