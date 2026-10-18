import { artworkRepository } from '@/storage/artworkRepository'
import { parseCompanionChatImage, type CompanionChatImage } from '@/types/companionDrawing'
import type { MediaSource } from '@/platform/desktop/workspaceMediaSource'
import { onDesktopRuntime } from '@/platform/desktop/runtime'
import { imageMediaSession } from '@/platform/imageMediaSession'

/** A turn selects its reference now; later tool rounds only read that same owner. */
export function captureCompanionImageSource(raw: CompanionChatImage | undefined, expectedAuthority: string | undefined, controller: AbortController) {
  const image = parseCompanionChatImage(raw)
  if (!image) return undefined
  const repository = artworkRepository, session = imageMediaSession()
  const signal = controller.signal
  function checkOwner() {
    if (repository !== artworkRepository || session !== imageMediaSession()) controller.abort()
  }
  const stopRuntime = onDesktopRuntime(checkOwner)
  function check() {
    checkOwner()
    signal.throwIfAborted()
  }
  async function read(): Promise<string | Readonly<MediaSource>> {
    check()
    const { readCompanionImage } = await import('./companionChatTools')
    check()
    return readCompanionImage(image!, repository, expectedAuthority, signal, check)
  }
  return { read, release: () => { stopRuntime(); controller.abort() } }
}
