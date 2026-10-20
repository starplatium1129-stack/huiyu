import { runtimeFetch, runtimeResourceIdentity } from '../../platform/runtimeUrl.ts'
import { getDesktopCapabilities } from '../../platform/desktop/capabilities.ts'
import { onDesktopRuntime } from '../../platform/desktop/runtime.ts'
import { imageMediaSession } from '../../platform/imageMediaSession.ts'
import { artworkRepository } from '../../storage/artworkRepository.ts'
import { buildArtworkFileName } from '../../utils/artworkFileName.ts'
import { formatA1111Parameters, injectPngMetadata } from '../../utils/pngMetadata.ts'
import { imageFormat } from '../../utils/imageFormat.ts'
import { safeImageUrl } from './galleryHelpers.ts'
import type { useGalleryWorkspace } from './useGalleryWorkspace.ts'
import { getCurrentInstance, getCurrentScope, onActivated, onDeactivated, onScopeDispose, readonly, ref, watch, type Ref } from 'vue'
import { copyWithFeedback } from '../useCopyFeedback.ts'

type Context = Pick<ReturnType<typeof useGalleryWorkspace>, 'current' | 'stamp' | 'sceneTitle' | 'characterName' | 'showToast'>

export function useGalleryExports({ current, stamp, sceneTitle, characterName, showToast }: Context): { downloading: Readonly<Ref<boolean>>; downloadCurrent: () => Promise<void>; copyPrompt: () => Promise<boolean> } {
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
    downloadController = null
    for (const url of downloadUrls.keys()) releaseDownloadUrl(url)
  }
  if (getCurrentInstance()) {
    onActivated(() => { viewActive = true })
    onDeactivated(() => { viewActive = false; stopDownloads() })
  }
  if (getCurrentScope()) onScopeDispose(() => { disposed = true; stopDownloads() })
  async function copyPrompt() {
    const item = current.value
    if (!item?.prompt) return false
    return await copyWithFeedback(item.prompt, 'Prompt 已复制') && !disposed && viewActive && current.value?.id === item.id
  }
  const downloading = ref(false)
  async function downloadCurrent() {
    const selected = current.value
    if (!selected || downloading.value || disposed || !viewActive) return
    let item = { ...selected }
    downloading.value = true
    const controller = new AbortController()
    downloadController = controller
    const repository = artworkRepository, session = imageMediaSession(), desktop = getDesktopCapabilities()
    let sourceChanged = false
    function checkSource() {
      if (!controller.signal.aborted && (repository !== artworkRepository || session !== imageMediaSession())) {
        sourceChanged = true
        controller.abort(new Error('图片连接已变化，请重新下载原图'))
      }
    }
    const stopRuntime = onDesktopRuntime(checkSource)
    const stopResources = watch(runtimeResourceIdentity, checkSource, { flush: 'sync' })
    const check = () => { checkSource(); controller.signal.throwIfAborted() }
    const canNotify = () => !disposed && viewActive && downloadController === controller
    try {
      check()
      if (item._gallerySummary) {
        const complete = await repository.readArtwork(item.id, controller.signal)
        check()
        if (!complete) throw new Error('这幅作品已不在作品册')
        item = { ...complete }
      }
      // 捕获作品记录；翻页后也不能拿另一张图的查看器 URL 配上本图文件名。
      let rawBlob: Blob | null = null
      let readError: Error | undefined
      try { rawBlob = await repository.getImage(String(item.image_id || item.id), controller.signal) }
      catch (error) {
        check() // A cancelled source cannot start its fallback against a new runtime.
        readError = error instanceof Error ? error : new Error('原图暂时无法读取，请重试')
      }
      check()
      if (!rawBlob) {
        const source = safeImageUrl(item.image_url) || (item.image_data?.startsWith('data:image/') ? item.image_data : '')
        if (!source) throw readError ?? new Error('原图已丢失，无法下载；缩略图不能替代原图')
        const response = await runtimeFetch(source, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) })
        check()
        if (!response.ok) throw new Error(`原图读取失败（${response.status}），请稍后重试`)
        rawBlob = await response.blob()
      }
      check()
      const buffer = await rawBlob.arrayBuffer()
      check()
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
        try { data = injectPngMetadata(buffer, metaText); metadataWritten = true } catch { /* 原始字节仍可保存 */ }
      }
      const detail = metadataWritten ? '（已嵌入生成参数）' : '（保留原始格式）'
      check()
      if (desktop) {
        try {
          // The native handoff owns these bytes now; source invalidation cannot undo a file save.
          const result = await desktop.saveImage({ data, name: fileName })
          if (!canNotify()) return
          if (result.saved) showToast(`已保存到 ${result.filePath || '所选位置'}${detail}`)
          else if (result.error) showToast(`保存失败：${result.error}`, 'warning')
          return
        } catch {
          checkSource()
          if (controller.signal.aborted) {
            if (canNotify() && sourceChanged) showToast('本机保存回执尚未确认；图片连接已变化，请先核对所选位置', 'warning')
            return
          }
          // Only the still-current operation may use the existing browser fallback.
        }
      }
      check()
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
      if (canNotify() && (!controller.signal.aborted || sourceChanged))
        showToast(error instanceof Error ? error.message : '原图下载失败，请重试', 'warning')
    } finally {
      stopRuntime(); stopResources()
      downloadController = null
      downloading.value = false
    }
  }
  return { downloading: readonly(downloading), downloadCurrent, copyPrompt }
}
