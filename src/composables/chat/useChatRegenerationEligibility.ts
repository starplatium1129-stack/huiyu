import { computed } from 'vue'
import type { ChatMessage } from './chatStorageTypes'

/** Scan once per history/variant change, rather than scanning for every row. */
export function useChatRegenerationEligibility(messages: () => readonly ChatMessage[]) {
  const eligible = computed(() => {
    const items = messages()
    const ids = new Set<string>()
    let hasUser = false
    for (let index = 0; index < items.length; index++) {
      const message = items[index]
      if (message.role === 'user') {
        hasUser = true
        if (index === items.length - 1) ids.add(message.mid)
      } else if (hasUser) ids.add(message.mid)
    }
    return ids
  })
  return (mid: string) => eligible.value.has(mid)
}
