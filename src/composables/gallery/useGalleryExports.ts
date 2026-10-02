import { runtimeFetch } from '../../platform/runtimeUrl.ts'
import { getDesktopCapabilities } from '../../platform/desktop/capabilities.ts'
import { artworkRepository } from '../../storage/artworkRepository.ts'
import { buildArtworkFileName } from '../../utils/artworkFileName.ts'
import { formatA1111Parameters, injectPngMetadata, isPng } from '../../utils/pngMetadata.ts'
import { safeImageUrl } from './galleryHelpers.ts'
import type { useGalleryWorkspace } from './useGalleryWorkspace.ts'
import { getCurrentInstance, getCurrentScope, onActivated, onDeactivated, onScopeDispose, ref, type Ref } from 'vue'
import { copyWithFeedback } from '../useCopyFeedback.ts'

type Context = Pick<ReturnType<typeof useGalleryWorkspace>, 'current' | 'stamp' | 'sceneTitle' | 'characterName' | 'showToast'>

function imageFormat(buffer: ArrayBuffer): { ext: string; mime: string } {
  if (isPng(buffer)) return { ext: 'png', mime: 'image/png' }
  const bytes = new Uint8Array(buffer)
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { ext: 'jpg', mime: 'image/jpeg' }
  const text = new TextDecoder().decode(bytes.subarray(0, 12))
  if (text.startsWith('RIFF') && text.slice(8) === 'WEBP') return { ext: 'webp', mime: 'image/webp' }
  if (/^GIF8[79]a/.test(text)) return { ext: 'gif', mime: 'image/gif' }
  if (text.startsWith('BM')) return { ext: 'bmp', mime: 'image/bmp' }
  if (text.slice(4, 8) === 'ftyp' && /^avi[fs]$/.test(text.slice(8, 12))) return { ext: 'avif', mime: 'image/avif' }
  throw new Error('原图格式无法识别，请重新导入有效图片')
}

export function useGalleryExports({ current, stamp, sceneTitle, characterName, showToast }: Context): { downloadCurrent: () => Promise<void>; copyPrompt: () => Promise<void>; copiedPrompt: Ref<boolean> } {
  const copiedPrompt = ref(false)
  let copyTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false, viewActive = true
  let downloadController: AbortController | null = null
  const downloadUrls = new Map<string, number>()
  function releaseDownloadUrl(url: string) {
    window.clearTimeout(downloadUrls.get(url))
    downloadUrls.delete(url)
    URL.revokeObjectURL(url)
  }
  function stopDownloads() {
    downloadController?.abort()
    for (const url of downloadUrls.keys()) releaseDownloadUrl(url)
  }
  if (getCurrentInstance()) {
    onActivated(() => { viewActive = true })
    onDeactivated(() => { viewActive = false; stopDownloads() })
  }
  if (getCurrentScope()) onScopeDispose(() => { disposed = true; clearTimeout(copyTimer); stopDownloads() })
  async function copyPrompt() {
    const item = current.value
    if (!item?.prompt) return
    if (await copyWithFeedback(item.prompt, 'Prompt 已复制') && !disposed && current.value?.id === item.id) {
      copiedPrompt.value = true
      clearTimeout(copyTimer)
      copyTimer = setTimeout(() => { copiedPrompt.value = false }, 2000)
    }
  }
  let downloading = false
  async function downloadCurrent() {
    const item = current.value
    if (!item || downloading || disposed || !viewActive) return
    downloading = true
    const controller = new AbortController()
    downloadController = controller
    try {
      // 捕获作品记录；翻页后也不能拿另一张图的查看器 URL 配上本图文件名。
      let rawBlob: Blob | null = null
      try { rawBlob = await artworkRepository.getImage(String(item.image_id || item.id), controller.signal) }
      catch { controller.signal.throwIfAborted() /* 读取失败可尝试记录内原图；取消不能再回退 */ }
      controller.signal.throwIfAborted()
      if (!rawBlob) {
        const source = safeImageUrl(item.image_url) || (item.image_data?.startsWith('data:image/') ? item.image_data : '')
        if (!source) throw new Error('原图已丢失，无法下载；缩略图不能替代原图')
        const response = await runtimeFetch(source, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) })
        if (!response.ok) throw new Error(`原图读取失败（${response.status}），请稍后重试`)
        rawBlob = await response.blob()
      }
      controller.signal.throwIfAborted()
      const buffer = await rawBlob.arrayBuffer()
      controller.signal.throwIfAborted()
      const format = imageFormat(buffer)
      const ts = stamp(item)
      const fileName = buildArtworkFileName({
        title: sceneTitle(item.scene, item),
        character: item.character ? characterName(item.character, item) : undefined,
        timestamp: ts > 0 ? ts : undefined, seed: item.seed, id: item.id, ext: format.ext,
      })
      const metaText = formatA1111Parameters({
        prompt: item.prompt ? String(item.prompt) : undefined,
        negative: item.negative ? String(item.negative) : undefined,
        steps: item.steps != null ? Number(item.steps) : undefined,
        sampler: item.sampler ? String(item.sampler) : undefined,
        cfg: item.cfg != null ? Number(item.cfg) : undefined,
        seed: item.seed ?? undefined,
        size: item.size ? String(item.size) : undefined,
        model: item.model ? String(item.model) : undefined,
        character: item.character ? String(item.character) : undefined,
      })
      let data = new Uint8Array(buffer)
      let metadataWritten = false
      if (format.ext === 'png' && metaText) {
        try { data = new Uint8Array(injectPngMetadata(buffer, metaText)); metadataWritten = true } catch { /* 原始字节仍可保存 */ }
      }
      const detail = metadataWritten ? '（已嵌入生成参数）' : '（保留原始格式）'
      if (getDesktopCapabilities()) {
        try {
          const result = await getDesktopCapabilities()!.saveImage({ data, name: fileName })
          if (controller.signal.aborted) return
          if (result.saved) showToast(`已保存到 ${result.filePath || '所选位置'}${detail}`)
          else if (result.error) showToast(`保存失败：${result.error}`, 'warning')
          return
        } catch { controller.signal.throwIfAborted() /* 原生对话框失败可回退；取消不能再下载 */ }
      }
      const url = URL.createObjectURL(new Blob([data], { type: format.mime }))
      let anchor: HTMLAnchorElement | undefined
      let started = false
      try {
        anchor = document.createElement('a')
        anchor.href = url
        anchor.download = fileName
        document.body.appendChild(anchor)
        anchor.click()
        started = true
        showToast(`已发起原图下载${detail}`)
      } finally {
        try { anchor?.remove() } finally {
          if (started && !controller.signal.aborted) downloadUrls.set(url, window.setTimeout(() => releaseDownloadUrl(url), 60_000))
          else URL.revokeObjectURL(url)
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) showToast(error instanceof Error ? error.message : '原图下载失败，请重试', 'warning')
    } finally {
      downloadController = null
      downloading = false
    }
  }
  return { downloadCurrent, copyPrompt, copiedPrompt }
}
