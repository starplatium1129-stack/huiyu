import type { CompanionDesktopBridge } from '@/types/desktop'
import { CHAT_RELAY_RECEIPT_KEY as CHAT_RELAY_RECEIPT } from '@/utils/storageKeys'
export { CHAT_RELAY_RECEIPT }

export function publishChatReceipt(requestId: string | undefined, accepted: boolean) {
  if (!requestId) return true
  try { localStorage.setItem(CHAT_RELAY_RECEIPT, JSON.stringify({ requestId, accepted, ts: Date.now() })); return true }
  catch { return false }
}

/** IPC delivery alone is not acceptance: keep the draft until the runtime owns the turn. */
export function relayChatTurn(bridge: CompanionDesktopBridge, text: string, character: string): Promise<void> {
  const requestId = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const finish = (accepted: boolean) => {
      clearTimeout(timer)
      window.removeEventListener('storage', receive)
      if (accepted) resolve(); else reject(new Error('chat turn not accepted'))
    }
    const receive = (event: StorageEvent) => {
      if (event.key !== CHAT_RELAY_RECEIPT) return
      try { const result = JSON.parse(event.newValue || 'null'); if (result?.requestId === requestId) finish(result.accepted === true) } catch { /* unrelated receipt */ }
    }
    const timer = window.setTimeout(() => finish(false), 8000)
    window.addEventListener('storage', receive)
    void bridge.chatRelay({ command: 'send', text, character, requestId }).then(result => { if (result === false) finish(false) }).catch(() => finish(false))
  })
}
