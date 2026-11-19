import { onScopeDispose, shallowRef, watch } from 'vue'
import type { ChatMessage } from './chatStorageTypes'

/** Only a live tail gets an arrival. Opening a branch or loading history stays still. */
export function useChatMessageArrival(messages: () => readonly ChatMessage[], thread: () => string, live: () => boolean) {
  const arriving = shallowRef(new Set<string>())
  let timer: ReturnType<typeof setTimeout> | undefined
  watch(() => [thread(), messages().slice(-6).map(message => message.mid)] as const, ([key, ids], [previousKey, previousIds]) => {
    if (key !== previousKey) {
      clearTimeout(timer)
      arriving.value = new Set()
      return
    }
    if (!live() || ids.at(-1) === previousIds.at(-1)) return
    const tail = previousIds.at(-1)
    const anchor = tail ? ids.lastIndexOf(tail) : -1
    // Regenerating the last reply may replace its ID in place.
    const start = anchor >= 0 ? anchor + 1 : tail ? ids.length - 1 : 0
    const added = ids.slice(Math.max(0, start)).filter(id => !previousIds.includes(id))
    if (!added.length || added.length > 2) return
    clearTimeout(timer)
    arriving.value = new Set([...arriving.value, ...added])
    timer = setTimeout(() => { arriving.value = new Set() }, 650)
  })
  onScopeDispose(() => clearTimeout(timer))
  return arriving
}
