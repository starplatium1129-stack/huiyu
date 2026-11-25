import { getDesktopRuntime } from '../platform/desktop/runtime.ts'
import { COMPANION_TASK_DRAFT_PREFIX } from '../utils/storageKeys.ts'
import type { TaskSummary } from '../../types/tasks'
/** Confirmed ownership survives a temporary disconnect; transport admission is separate. */
let confirmed = false
export function hasRuntimeTasks(): boolean {
  const state = getDesktopRuntime()
  if (state.connection === 'ready') confirmed = Boolean(state.bootstrap?.runtime?.workspace?.domains.includes('artwork'))
  return confirmed
}
export function hasRuntimeTaskSession(): boolean {
  const state = getDesktopRuntime()
  return state.connection === 'ready' && Boolean(state.bootstrap?.runtime?.workspace)
}
export function runtimeTaskDraftSlot(slot: string): string {
  const workspace = getDesktopRuntime().bootstrap?.runtime?.workspace
  if (!workspace || !hasRuntimeTaskSession()) throw new Error('本机任务队列暂未连接，请重启绘遇后重试。')
  return workspace.domains.includes('artwork') ? slot : `${COMPANION_TASK_DRAFT_PREFIX}${workspace.workspaceId}:${slot}`
}
export const isRuntimeTaskId = (id: string) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)
/** Commands derived from a read must still belong to that same task session. */
export function assertRuntimeTaskSession(task: TaskSummary): void {
  const workspace = getDesktopRuntime().bootstrap?.runtime?.workspace
  if (!workspace || task.runtimeEpoch !== workspace.runtimeEpoch || task.workspaceId !== workspace.workspaceId
    || task.principalId !== workspace.principalId) throw new Error('任务工作区或运行时已更换，请重新读取原任务')
}
