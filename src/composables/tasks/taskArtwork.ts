import { artworkRepository, type ArtworkRepository } from '@/storage/artworkRepository'
import { saveTaskResult } from '@/application/artwork/saveTaskResult'
import { fetchRuntimeResult, getRuntimeTask, markRuntimeTask, runtimeResultPath } from '@/api/runtimeTasks'
import { onDesktopRuntime } from '@/platform/desktop/runtime'
import { imageMediaSession } from '@/platform/imageMediaSession'

export async function archiveTaskResult(taskId: string, index = 0, repository: ArtworkRepository = artworkRepository, signal?: AbortSignal) {
  const expected = imageMediaSession(), controller = new AbortController()
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  const checkOwner = () => {
    if (repository !== artworkRepository || imageMediaSession() !== expected)
      controller.abort(new Error('作品库或任务会话已变化，请回到原工作区核对入册'))
  }
  const stopRuntime = onDesktopRuntime(checkOwner)
  const check = () => {
    checkOwner()
    requestSignal.throwIfAborted()
  }
  try {
    check()
    const task = await getRuntimeTask(taskId, requestSignal)
    check()
    const copyResult = repository.getWorkspaceMediaReference ? undefined
      : () => fetchRuntimeResult(runtimeResultPath(task, index), requestSignal, task)
    const saved = await saveTaskResult(task, index, { repository, copyResult, assertCurrent: check, markSaved: id => markRuntimeTask(id, 'saved') })
    check()
    return saved
  } finally { stopRuntime() }
}
