import type { CompanionDesktopBridge } from '@/types/desktop'
import { CHAT_RELAY_RECEIPT_KEY as CHAT_RELAY_RECEIPT } from '@/utils/storageKeys'
import type { CompanionChatSendOptions } from '@/types/companionDrawing'
export { CHAT_RELAY_RECEIPT }

export function publishChatReceipt(requestId: string | undefined, accepted: boolean) {
  if (!requestId) return true
  try { localStorage.setItem(CHAT_RELAY_RECEIPT, JSON.stringify({ requestId, accepted, ts: Date.now() })); return true }
  catch { return false }
}

/** IPC delivery alone is not acceptance: keep the draft until the runtime owns the turn. */
export function relayChatTurn(bridge: CompanionDesktopBridge, text: string, character: string, imageUrl?: string, signal?: AbortSignal, options: CompanionChatSendOptions = {}): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  const requestId = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    let finished = false
    const finish = (accepted: boolean) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      window.removeEventListener('storage', receive)
      signal?.removeEventListener('abort', abort)
      if (accepted) resolve(); else reject(new Error('chat turn not accepted'))
    }
    const abort = () => finish(false)
    const receive = (event: StorageEvent) => {
      if (event.key !== CHAT_RELAY_RECEIPT) return
      try { const result = JSON.parse(event.newValue || 'null'); if (result?.requestId === requestId) finish(result.accepted === true) } catch { /* unrelated receipt */ }
    }
    const timer = window.setTimeout(() => finish(false), 8000)
    window.addEventListener('storage', receive)
    signal?.addEventListener('abort', abort, { once: true })
    void bridge.chatRelay({ command: 'send', text, character, requestId, ...(imageUrl ? { imageUrl } : {}), ...options }).then(result => { if (result === false) finish(false) }).catch(() => finish(false))
  })
}
