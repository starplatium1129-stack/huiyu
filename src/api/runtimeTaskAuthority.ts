import { getDesktopRuntime } from '../platform/desktop/runtime.ts'
import type { TaskSummary } from '../../types/tasks'
/** Confirmed ownership survives a temporary disconnect; transport admission is separate. */
let confirmed = false
export function hasRuntimeTasks(): boolean {
  const state = getDesktopRuntime()
  if (state.connection === 'ready') confirmed = Boolean(state.bootstrap?.runtime?.workspace?.domains.includes('artwork'))
  return confirmed
}
export const isRuntimeTaskId = (id: string) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)
/** Commands derived from a read must still belong to that same task session. */
export function assertRuntimeTaskSession(task: TaskSummary): void {
  const workspace = getDesktopRuntime().bootstrap?.runtime?.workspace
  if (!workspace || task.runtimeEpoch !== workspace.runtimeEpoch || task.workspaceId !== workspace.workspaceId
    || task.principalId !== workspace.principalId) throw new Error('任务工作区或运行时已更换，请重新读取原任务')
}
