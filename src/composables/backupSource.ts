import { workspaceBackupActive } from '../platform/desktop/backupActions'
import { onDesktopRuntime } from '../platform/desktop/runtime'
import { imageMediaSession } from '../platform/imageMediaSession'
import { artworkRepository } from '../storage/artworkRepository'

/** Each backup operation retains its source until its own completion or cancellation. */
export function captureBackupSource(controller: AbortController, desktop: boolean) {
  const repository = artworkRepository, session = imageMediaSession()
  const checkOwner = () => {
    if (repository !== artworkRepository || session !== imageMediaSession() || desktop !== workspaceBackupActive())
      controller.abort(new Error('备份来源连接已变化，请回到原资料后重新操作'))
  }
  const release = onDesktopRuntime(checkOwner)
  return { repository, release, signal: controller.signal, check: () => { checkOwner(); controller.signal.throwIfAborted() } }
}
