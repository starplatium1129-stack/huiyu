import { artworkRepository } from '@/storage/artworkRepository'
import { assertWorkspaceMediaAuthority, workspaceMediaSource } from '@/platform/desktop/workspaceMediaSource'
import type { CompanionChatImage } from '@/types/companionDrawing'
import { captureCompanionImageSource } from './companionChatImages'

/** Regeneration reads the original question's media, never later assistant images. */
export function captureRegenerationImages(images: CompanionChatImage[], controller: AbortController) {
  const repository = artworkRepository
  const sources = images.map(image => captureCompanionImageSource(image, undefined, controller))
  const signal = controller.signal
  return {
    async read(): Promise<string[]> {
      const urls: string[] = []
      for (const source of sources) {
        signal.throwIfAborted()
        if (!source) throw new Error('原消息的图片记录不完整，请重新发送图片后再生成回复。')
        const image = await source.read()
        signal.throwIfAborted()
        if (typeof image === 'string') { urls.push(image); continue }
        assertWorkspaceMediaAuthority(image.authority)
        const blob = await repository.getImage(image.alias, signal)
        signal.throwIfAborted()
        assertWorkspaceMediaAuthority(image.authority)
        if (!blob || !blob.size) throw new Error('原图暂时无法读取，请重新发送图片后再生成回复。')
        const loaded = workspaceMediaSource(blob)
        if (!loaded || loaded.sha256 !== image.sha256 || loaded.bytes !== image.bytes || loaded.mime !== image.mime) {
          throw new Error('原图在读取期间发生变化，请重新发送图片后再生成回复。')
        }
        urls.push(await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          const cleanup = () => signal.removeEventListener('abort', abort)
          const abort = () => { cleanup(); reader.abort(); reject(new DOMException('已取消', 'AbortError')) }
          reader.onload = () => {
            cleanup()
            try { signal.throwIfAborted(); assertWorkspaceMediaAuthority(image.authority); resolve(String(reader.result || '')) }
            catch (error) { reject(error) }
          }
          reader.onerror = () => { cleanup(); reject(new Error('读取原图失败，请重新发送图片后再生成回复。')) }
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) { abort(); return }
          reader.readAsDataURL(blob)
        }))
      }
      return urls
    },
    release() { sources.forEach(source => source?.release()) },
  }
}
