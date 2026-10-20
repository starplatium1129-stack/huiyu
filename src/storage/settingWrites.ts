import { shallowRef } from 'vue'
import { flushProfileWrites, profileLocalStorage } from '@/platform/web/profileStorage'
import { getDesktopRuntime } from '@/platform/desktop/runtime'
import { registerMaintenanceParticipant } from '@/platform/maintenanceParticipants'

interface Write { key: string; value: string; owner: string; queued: boolean; error: string; flight?: Promise<boolean> }
const writes = new Map<string, Write>()
export const settingWriteState = shallowRef({ pending: false, error: '' })
function owner() {
  const bootstrap = getDesktopRuntime().bootstrap, workspace = bootstrap?.runtime?.workspace
  return JSON.stringify([location.origin, bootstrap?.sourceProfileId, workspace?.workspaceId, workspace?.principalId])
}
function publish() {
  settingWriteState.value = { pending: writes.size > 0, error: [...writes.values()].find(write => write.error)?.error || '' }
}
function attempt(write: Write): Promise<boolean> {
  if (write.flight) return write.flight
  write.flight = (async () => {
    try {
      if (owner() !== write.owner) throw new Error('设置属于原工作区，请恢复原连接后重试保存。')
      if (!write.queued) { profileLocalStorage.setItem(write.key, write.value); write.queued = true }
      await flushProfileWrites()
      if (owner() !== write.owner) throw new Error('设置保存期间工作区已变化，请核对原工作区。')
      if (writes.get(write.key) === write) writes.delete(write.key)
      return true
    } catch (error) {
      write.error = error instanceof Error ? error.message : '设置尚未保存，请重试。'
      return false
    } finally { publish() }
  })()
  void write.flight.finally(() => { write.flight = undefined })
  return write.flight
}
/** Preferences update immediately; the returned result confirms durable storage. */
export function saveSettingValue(key: string, value: string): Promise<boolean> {
  const write: Write = { key, value, owner: owner(), queued: false, error: '' }
  writes.set(key, write); publish()
  return attempt(write)
}
export async function retrySettingWrites(): Promise<boolean> {
  for (const write of [...writes.values()]) if (!await attempt(write)) return false
  return !writes.size
}
registerMaintenanceParticipant(async () => {
  if (!await retrySettingWrites()) throw new Error('设置尚未保存，请先重试保存。')
})
if (typeof window !== 'undefined') window.addEventListener('beforeunload', event => {
  if (writes.size) { event.preventDefault(); event.returnValue = '' }
})
