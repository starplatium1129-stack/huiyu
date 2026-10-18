import { artworkRepository, type ArtworkRepository } from '@/storage/artworkRepository'
import { saveTaskResult } from '@/application/artwork/saveTaskResult'
import { getRuntimeTask, markRuntimeTask } from '@/api/runtimeTasks'
import { getDesktopRuntime } from '@/platform/desktop/runtime'

export async function archiveTaskResult(taskId: string, index = 0, repository: ArtworkRepository = artworkRepository) {
  const session = () => {
    const runtime = getDesktopRuntime().bootstrap?.runtime, workspace = runtime?.workspace
    return JSON.stringify([runtime?.origin, runtime?.runtimeEpoch, workspace?.workspaceId, workspace?.principalId,
      workspace?.runtimeEpoch, workspace?.generation])
  }
  const expected = session()
  const check = () => {
    if (repository !== artworkRepository || session() !== expected) throw new Error('作品库或任务会话已变化，请回到原工作区核对入册')
  }
  check()
  const task = await getRuntimeTask(taskId)
  check()
  const saved = await saveTaskResult(task, index, { repository, assertCurrent: check, markSaved: id => markRuntimeTask(id, 'saved') })
  check()
  return saved
}
