import { nextTick, onBeforeUnmount, ref, watch, type Ref } from 'vue'

/** Keep a reader's position while replies stream; only follow when already at the end. */
export function useConversationReading(element: Ref<HTMLElement | undefined | null>, revision: () => unknown, character: Ref<string>) {
  const following = ref(true)
  const hasNew = ref(false)
  function onScroll() {
    const el = element.value
    if (!el) return
    following.value = el.scrollHeight - el.scrollTop - el.clientHeight < 96
    if (following.value) hasNew.value = false
  }
  async function latest() {
    following.value = true
    hasNew.value = false
    await nextTick()
    const el = element.value
    if (el) { const items = revision(); el.scrollTop = Array.isArray(items) && !items.length ? 0 : el.scrollHeight }
  }
  watch(element, (el, old) => {
    old?.removeEventListener('scroll', onScroll)
    el?.addEventListener('scroll', onScroll, { passive: true })
  }, { flush: 'post' })
  watch(revision, () => { if (following.value) void latest(); else hasNew.value = true }, { deep: true })
  watch(character, latest)
  onBeforeUnmount(() => element.value?.removeEventListener('scroll', onScroll))
  return { hasNew, latest }
}
