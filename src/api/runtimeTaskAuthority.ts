import { getDesktopRuntime } from '../platform/desktop/runtime.ts'
import { unresolvedTaskRequests, pendingTaskRequests } from './runtimeTaskState'
import type { TaskRecord } from '../../types/tasks'
/** Confirmed ownership survives a temporary disconnect; transport admission is separate. */
let confirmed = false
export function hasRuntimeTasks(): boolean {
  const state = getDesktopRuntime()
  if (state.connection === 'ready') confirmed = Boolean(state.bootstrap?.runtime?.workspace?.domains.includes('artwork'))
  return confirmed
}
export const isRuntimeTaskId = (id: string) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)
export function runtimeRequestKey(kind: TaskRecord['kind'], input: Record<string, unknown>): string {
  const fingerprint = JSON.stringify({ kind, input }), previous = unresolvedTaskRequests.get(fingerprint)
  if (previous) return previous.key
  const key = crypto.randomUUID()
  unresolvedTaskRequests.set(fingerprint, { key, kind }); pendingTaskRequests.value = [...unresolvedTaskRequests.values()]
  return key
}
