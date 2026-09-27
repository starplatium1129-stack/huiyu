import { registerMaintenanceParticipant } from '@/platform/maintenanceParticipants'

/** Preserve the character captured by the input event, even if selection changes. */
export function createChatDraftPersistence(save: (character: string, value: string) => void) {
  let timer = 0, pending: [string, string] | undefined
  function clear() { clearTimeout(timer); timer = 0; pending = undefined }
  function flush() { const value = pending; clear(); if (value) save(...value) }
  const unregister = registerMaintenanceParticipant(flush)
  return {
    schedule(character: string, value: string) { clear(); pending = [character, value]; timer = window.setTimeout(flush, 240) },
    clear, flush, dispose() { clear(); unregister() },
  }
}
