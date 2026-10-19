import { computed, nextTick, onScopeDispose, ref, watch, type Ref } from 'vue'
import type { ChatMessage } from './chatStorageTypes'
import { useConversationReading } from './useConversationReading'

const WINDOW_SIZE = 120
const PAGE_SIZE = 60

/** Bound mounted rows without trimming the conversation used by export or story edits. */
export function useChatHistoryWindow(element: Ref<HTMLElement | undefined | null>, messages: Ref<ChatMessage[]>, context: Ref<string>) {
  const fixedStart = ref<number | null>(null)
  const tailStart = computed(() => Math.max(0, messages.value.length - WINDOW_SIZE))
  const start = computed(() => Math.min(fixedStart.value ?? tailStart.value, tailStart.value))
  const visibleMessages = computed(() => messages.value.slice(start.value, start.value + WINDOW_SIZE))
  const hasEarlier = computed(() => start.value > 0)
  const hasLater = computed(() => start.value + WINDOW_SIZE < messages.value.length)
  const reading = useConversationReading(element, () => messages.value, context)
  const paging = ref(false)
  let generation = 0
  watch(reading.following, following => {
    if (!following && fixedStart.value === null) fixedStart.value = start.value
    else if (following && !hasLater.value) fixedStart.value = null
  }, { flush: 'sync' })
  watch(context, () => { generation++; fixedStart.value = null; paging.value = false }, { flush: 'sync' })
  onScopeDispose(() => { generation++ })

  async function latest() {
    generation++
    paging.value = false
    fixedStart.value = null
    await reading.latest()
  }

  async function page(direction: -1 | 1) {
    const el = element.value
    if (!el || paging.value) return
    const nextStart = Math.max(0, Math.min(tailStart.value, start.value + direction * PAGE_SIZE))
    if (nextStart === start.value) return
    const revision = ++generation
    const retained = new Set(messages.value.slice(nextStart, nextStart + WINDOW_SIZE).map(message => message.mid))
    const rows = [...el.querySelectorAll<HTMLElement>('[data-mid]')].filter(row => retained.has(row.dataset.mid || ''))
    const top = el.getBoundingClientRect().top
    const anchor = rows.find(row => row.getBoundingClientRect().bottom > top) || rows.at(-1)
    const offset = anchor?.getBoundingClientRect().top
    const active = document.activeElement
    paging.value = true
    reading.pause()
    fixedStart.value = nextStart
    await nextTick()
    if (revision !== generation || element.value !== el) return
    if (anchor?.isConnected && offset !== undefined) el.scrollTo({ top: el.scrollTop + anchor.getBoundingClientRect().top - offset, behavior: 'instant' })
    paging.value = false
    await nextTick()
    if (revision !== generation || element.value !== el) return
    if (active instanceof HTMLElement && (!active.isConnected || document.activeElement === document.body)) {
      (active.isConnected ? active : anchor)?.focus({ preventScroll: true })
    }
  }

  return { visibleMessages, hasEarlier, hasLater, paging, latest,
    showLatest: computed(() => hasLater.value || reading.showLatest.value),
    loadEarlier: () => page(-1), loadLater: () => page(1) }
}
