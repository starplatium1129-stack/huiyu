import type { CompanionDesktopBridge } from '@/types/desktop'
import { CHAT_RELAY_RECEIPT_KEY as CHAT_RELAY_RECEIPT } from '@/utils/storageKeys'
import type { CompanionChatCommand, CompanionChatSendOptions } from '@/types/companionDrawing'

const cancellationPrefix = `${CHAT_RELAY_RECEIPT}:cancelled:`

function cancelChatRelay(requestId: string) {
  const now = Date.now()
  localStorage.setItem(cancellationPrefix + requestId, String(now))
  // Keep independent cancellation markers across later receipts and window delays.
  for (let index = localStorage.length - 1; index >= 0; index--) {
    const key = localStorage.key(index)
    if (key?.startsWith(cancellationPrefix) && Number(localStorage.getItem(key)) < now - 86_400_000) localStorage.removeItem(key)
  }
}

export function publishChatReceipt(requestId: string | undefined, accepted: boolean) {
  if (!requestId) return true
  if (accepted && isChatRelayCancelled(requestId)) return false
  try { localStorage.setItem(CHAT_RELAY_RECEIPT, JSON.stringify({ requestId, accepted, ts: Date.now() })); return true }
  catch { return false }
}

export function isChatRelayCancelled(requestId: string | undefined): boolean {
  if (!requestId) return false
  try { return localStorage.getItem(cancellationPrefix + requestId) !== null }
  catch { return true }
}

/** IPC delivery alone is not acceptance: keep the draft until the runtime owns the turn. */
export function relayChatTurn(bridge: CompanionDesktopBridge, text: string, character: string, imageUrl?: string, signal?: AbortSignal, options: CompanionChatSendOptions = {}): Promise<void> {
  return relayChatCommand(bridge, { command: 'send', text, character, ...(imageUrl ? { imageUrl } : {}), ...options }, signal)
}

export function relayChatCommand(bridge: CompanionDesktopBridge, payload: CompanionChatCommand, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  const requestId = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    let finished = false
    const finish = (accepted: boolean, cancelled = false) => {
      if (finished) return
      finished = true
      if (cancelled) {
        try { cancelChatRelay(requestId) } catch { /* The receiver also checks its current story. */ }
      }
      clearTimeout(timer)
      window.removeEventListener('storage', receive)
      signal?.removeEventListener('abort', abort)
      if (accepted) resolve(); else reject(new Error('chat turn not accepted'))
    }
    const abort = () => finish(false, true)
    const receive = (event: StorageEvent) => {
      if (event.key !== CHAT_RELAY_RECEIPT) return
      try { const result = JSON.parse(event.newValue || 'null'); if (result?.requestId === requestId) finish(result.accepted === true) } catch { /* unrelated receipt */ }
    }
    const timer = window.setTimeout(() => finish(false, true), 8000)
    window.addEventListener('storage', receive)
    signal?.addEventListener('abort', abort, { once: true })
    void bridge.chatRelay({ ...payload, requestId }).then(result => { if (result === false) finish(false) }).catch(() => finish(false))
  })
}
