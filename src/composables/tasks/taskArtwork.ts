import { artworkRepository, type ArtworkRepository } from '@/storage/artworkRepository'
import { saveTaskResult } from '@/application/artwork/saveTaskResult'
import { getRuntimeTask, markRuntimeTask } from '@/api/runtimeTasks'
import { onDesktopRuntime } from '@/platform/desktop/runtime'
import { imageMediaSession } from '@/platform/imageMediaSession'

export async function archiveTaskResult(taskId: string, index = 0, repository: ArtworkRepository = artworkRepository) {
  const expected = imageMediaSession(), controller = new AbortController()
  const checkOwner = () => {
    if (repository !== artworkRepository || imageMediaSession() !== expected)
      controller.abort(new Error('作品库或任务会话已变化，请回到原工作区核对入册'))
  }
  const stopRuntime = onDesktopRuntime(checkOwner)
  const check = () => {
    checkOwner()
    controller.signal.throwIfAborted()
  }
  try {
    check()
    const task = await getRuntimeTask(taskId, controller.signal)
    check()
    const saved = await saveTaskResult(task, index, { repository, assertCurrent: check, markSaved: id => markRuntimeTask(id, 'saved') })
    check()
    return saved
  } finally { stopRuntime() }
}
