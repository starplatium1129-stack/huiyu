import { kvGet, kvUpdate } from '@/composables/useKVStore'
import { TASK_CENTER_KV_KEY } from '@/utils/storageKeys'

/** Active Web history port: the fixed task key shares the proven atomic KV transaction. */
export function readTaskHistory(): Promise<unknown> { return kvGet(TASK_CENTER_KV_KEY) }
export function updateTaskHistory<T>(merge: (current: unknown) => T): Promise<T> {
  return kvUpdate(TASK_CENTER_KV_KEY, merge)
}
