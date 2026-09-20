import { expect, it, vi } from 'vitest'
import { relayChatTurn, CHAT_RELAY_RECEIPT } from './chatRelayReceipt'
import type { CompanionDesktopBridge } from '@/types/desktop'

it('waits for runtime acceptance and rejects a declined turn even if IPC delivery succeeded', async () => {
  let payload: Record<string, unknown> = {}
  const bridge = { chatRelay: vi.fn(async (value: Record<string, unknown>) => { payload = value; return true }) } as unknown as CompanionDesktopBridge
  const pending = relayChatTurn(bridge, 'a draft', 'nene')
  const rejected = expect(pending).rejects.toThrow('not accepted')
  window.dispatchEvent(new StorageEvent('storage', { key: CHAT_RELAY_RECEIPT, newValue: JSON.stringify({ requestId: payload.requestId, accepted: false }) }))
  await rejected
  const accepted = relayChatTurn(bridge, 'a draft', 'nene')
  window.dispatchEvent(new StorageEvent('storage', { key: CHAT_RELAY_RECEIPT, newValue: JSON.stringify({ requestId: payload.requestId, accepted: true }) }))
  await expect(accepted).resolves.toBeUndefined()
})
