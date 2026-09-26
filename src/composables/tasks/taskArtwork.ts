import { artworkRepository } from '@/storage/artworkRepository'
import { saveTaskResult } from '@/application/artwork/saveTaskResult'
import { getRuntimeTask, markRuntimeTask } from '@/api/runtimeTasks'
export async function archiveTaskResult(taskId: string, index = 0) {
  const task = await getRuntimeTask(taskId)
  return saveTaskResult(task, index, { repository: artworkRepository, markSaved: id => markRuntimeTask(id, 'saved') })
}
