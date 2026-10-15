import { artworkRepository } from '@/storage/artworkRepository'
import { fetchRuntimeResult } from '@/api/runtimeTasks'
import { parseCompanionChatImage, type CompanionChatImage } from '@/types/companionDrawing'
import { readWorkspaceMediaSource, type MediaSource } from '@/platform/desktop/workspaceMediaSource'

/** Resolve a durable reference only when sending it to a model or tagger. */
export async function companionImageSource(raw: CompanionChatImage, signal: AbortSignal): Promise<string | Readonly<MediaSource>> {
  signal.throwIfAborted()
  const image = parseCompanionChatImage(raw)
  if (!image) throw new Error('图片引用无效，请重新选择图片。')
  if (image.imageId && artworkRepository.getWorkspaceMediaReference) {
    const { alias, authority } = artworkRepository.getWorkspaceMediaReference(image.imageId)
    return readWorkspaceMediaSource(alias, authority, signal)
  }
  const blob = image.imageId || !image.path.startsWith('/')
    ? await artworkRepository.getImage(image.imageId || image.path, signal)
    : await fetchRuntimeResult(image.path, signal)
  signal.throwIfAborted()
  if (!blob || !blob.size || !/^image\/(png|jpeg|webp|gif)$/.test(blob.type)) throw new Error('原图暂时无法读取，请重新选择图片。')
  if (blob.size > 20 * 1024 * 1024) throw new Error('图片超过 20 MB，请缩小后重试。')
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    const cleanup = () => signal.removeEventListener('abort', abort)
    const abort = () => { cleanup(); reader.abort(); reject(signal.reason || new DOMException('已取消', 'AbortError')) }
    reader.onload = () => { cleanup(); resolve(String(reader.result || '')) }
    reader.onerror = () => { cleanup(); reject(new Error('读取图片失败。')) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); return }
    reader.readAsDataURL(blob)
  })
}
