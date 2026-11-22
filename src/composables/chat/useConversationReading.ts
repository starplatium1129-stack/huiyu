import { computed, nextTick, onBeforeUnmount, ref, watch, type Ref } from 'vue'

/** Keep a reader's position while replies stream; only follow when already at the end. */
export function useConversationReading(element: Ref<HTMLElement | undefined | null>, hasMessages: () => boolean, character: Ref<string>) {
  const following = ref(true)
  let followFrame = 0
  function cancelFollow() { cancelAnimationFrame(followFrame); followFrame = 0 }
  function scheduleFollow() {
    if (!element.value || document.hidden || !following.value || followFrame) return
    followFrame = requestAnimationFrame(() => {
      followFrame = 0
      const el = element.value
      if (el && following.value) el.scrollTop = hasMessages() ? el.scrollHeight : 0
    })
  }
  const changes = new MutationObserver(scheduleFollow)
  function onScroll() {
    const el = element.value
    if (!el) return
    following.value = el.scrollHeight - el.scrollTop - el.clientHeight < 96
    if (!following.value) cancelFollow()
  }
  function pause() { following.value = false; cancelFollow() }
  async function latest() {
    following.value = true
    await nextTick()
    scheduleFollow()
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
  watch(character, latest)
  document.addEventListener('visibilitychange', scheduleFollow)
  onBeforeUnmount(() => {
    element.value?.removeEventListener('scroll', onScroll)
    document.removeEventListener('visibilitychange', scheduleFollow)
    changes.disconnect()
    cancelFollow()
  })
  return { showLatest: computed(() => !following.value), following, pause, latest }
}
