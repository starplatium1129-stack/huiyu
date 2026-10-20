import { computed, nextTick, onBeforeUnmount, ref, watch, type Ref } from 'vue'

/** Keep a reader's position while replies stream; only follow when already at the end. */
export function useConversationReading(element: Ref<HTMLElement | undefined | null>, revision: () => unknown, character: Ref<string>) {
  const following = ref(true)
  const hasNew = ref(false)
  let followFrame = 0
  function cancelFollow() { cancelAnimationFrame(followFrame); followFrame = 0 }
  function scrollLatest() {
    const el = element.value
    if (el) { const items = revision(); el.scrollTop = Array.isArray(items) && !items.length ? 0 : el.scrollHeight }
  }
  const changes = new MutationObserver(() => {
    if (!following.value || followFrame) return
    followFrame = requestAnimationFrame(() => {
      followFrame = 0
      if (following.value) scrollLatest()
    })
  })
  function onScroll() {
    const el = element.value
    if (!el) return
    following.value = el.scrollHeight - el.scrollTop - el.clientHeight < 96
    if (following.value) hasNew.value = false
    else cancelFollow()
  }
  function pause() { following.value = false; cancelFollow() }
  async function latest() {
    following.value = true
    hasNew.value = false
    await nextTick()
    cancelFollow()
    scrollLatest()
  }
  watch(element, (el, old) => {
    old?.removeEventListener('scroll', onScroll)
    changes.disconnect()
    cancelFollow()
    el?.addEventListener('scroll', onScroll, { passive: true })
    if (el) {
      changes.observe(el, { subtree: true, childList: true, characterData: true })
      void latest()
    }
  }, { flush: 'post' })
  // Only subscribe to message data until the first unread change. DOM updates
  // own following; local image/menu feedback must not mark messages unread.
  watch(() => following.value || hasNew.value ? null : revision(), (items, previous) => {
    if (items !== null && previous !== null) hasNew.value = true
  }, { deep: true })
  watch(character, latest)
  onBeforeUnmount(() => { element.value?.removeEventListener('scroll', onScroll); changes.disconnect(); cancelFollow() })
  return { hasNew, showLatest: computed(() => !following.value || hasNew.value), following, pause, latest }
}
