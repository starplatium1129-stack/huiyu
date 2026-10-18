import { computed, onActivated, onDeactivated, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue'
import { withArtworkStaging } from '@/storage/artworkSession'
import { artworkRepository } from '@/storage/artworkRepository'
import { imageMediaSession, useOriginalImage } from '@/composables/useOriginalImage'
import { onDesktopRuntime } from '@/platform/desktop/runtime'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'
import { registerMigrationArtworkSource } from '@/platform/web/migrationBarrier'
import { sameTempResultOwner, tempResultOwner } from '@/utils/tempResult'
import {
  uploadVideoImage, importWorkspaceVideoImage,
  type VideoDefaults, type VideoMode, type VideoStatusResponse,
} from '@/api/videoApi'
import { useVideoStore, type VideoCtxPayload } from '@/stores/videoStore'
import { useSceneStore } from '@/stores/sceneStore'

/** Single-video sources live here; useOriginalImage owns both preview lifecycles.
 * Durable IDs can be reread. Only undurable inputs retain original Blobs between visits. */
export interface VideoFramesDeps {
  selectedMode: Ref<VideoMode | 'shots'>
  aspectRatio: Ref<VideoDefaults['aspectRatio']>
  selectedModelId: Ref<string>
  prompt: Ref<string>
  videoImageId: Ref<string>
  lastFrameImageId: Ref<string>
  status: Ref<VideoStatusResponse | null>
  statusError: Ref<string>
  available: () => boolean
  /** Save and flush the full imported intent before removing its inbox entry. */
  persistImportedCtx: (sourceImageId: string) => Promise<void>
}

export function useVideoFrames(deps: VideoFramesDeps) {
  const videoStore = useVideoStore(), sceneStore = useSceneStore()
  const owner = tempResultOwner()
  function createSlot(id: Ref<string>, label: string) {
    return { id, label, preview: useOriginalImage(), blob: shallowRef<Blob | null>(null),
      pending: shallowRef<Blob | null>(null), version: 0, upload: null as AbortController | null }
  }
  const first = createSlot(deps.videoImageId, '首帧'), last = createSlot(deps.lastFrameImageId, '尾帧')
  type Slot = typeof first
  let active = true, disposed = false, contextVersion = 0, session = imageMediaSession()
  let preparation: AbortController | null = null
  const uploads = new Set<AbortController>(), uploadingImage = ref(false)
  const hasFirstFrame = computed(() => Boolean(first.id.value || first.blob.value || first.pending.value))
  const hasLastFrame = computed(() => Boolean(last.id.value || last.blob.value || last.pending.value))
  const releaseMigration = registerMigrationArtworkSource(() => [first, last].some(slot =>
    Boolean(slot.pending.value || slot.blob.value && !slot.id.value)))

  function owned() { return sameTempResultOwner(owner) }
  function available() { return !disposed && active && deps.available() && owned() }
  function track(controller: AbortController) { uploads.add(controller); uploadingImage.value = true }
  function finish(controller: AbortController) { uploads.delete(controller); uploadingImage.value = uploads.size > 0 }
  function stopSlot(slot: Slot) { slot.version++; slot.upload?.abort(); slot.upload = null }
  function stopOperations() {
    contextVersion++; preparation?.abort(); preparation = null
    stopSlot(first); stopSlot(last); uploads.clear(); uploadingImage.value = false
  }
  function clearFrame(slot: Slot) {
    contextVersion++; preparation?.abort(); stopSlot(slot)
    slot.preview.release(); slot.id.value = ''; slot.blob.value = null; slot.pending.value = null
  }

  /** A failed read keeps its ID. Only a current, empty original proves it is lost. */
  async function restorePreview(slot: Slot, original?: Blob) {
    if (!available()) return
    const id = slot.id.value, blob = slot.blob.value, version = slot.version
    if (!id && !blob && !original) { slot.preview.release(); return }
    const repository = artworkRepository, mediaSession = imageMediaSession()
    const current = () => available() && version === slot.version && id === slot.id.value && blob === slot.blob.value
      && repository === artworkRepository && mediaSession === imageMediaSession()
    await slot.preview.load({ current, preserve: true, async read(signal, selectedRepository) {
      signal.throwIfAborted()
      if (!current()) return null
      const image = original || blob || await selectedRepository.getImage(id, signal)
      signal.throwIfAborted()
      if (!current()) return null
      if (!image?.size) {
        slot.preview.release()
        slot.id.value = ''
        deps.statusError.value = `${slot.label}原图已失效，请重新选择图片`
      }
      return image
    } })
  }
  watch([first.preview.error, last.preview.error], ([firstError, lastError]) => {
    if (available() && (firstError || lastError)) deps.statusError.value = '帧图暂时无法读取，原输入已保留；请重新进入页面重试'
  })

  /** Validate a new selection before replacing the previous source. An interrupted
   * selection stays in pending; returning to the same owner can finish preparing it. */
  async function prepareFile(slot: Slot, file: Blob) {
    if (!available() || slot.pending.value !== file || slot.upload) return
    stopSlot(slot)
    const version = slot.version, controller = new AbortController(), repository = artworkRepository
    const mediaSession = imageMediaSession()
    slot.upload = controller; track(controller)
    const sameSource = () => repository === artworkRepository && mediaSession === imageMediaSession() && owned()
    const current = () => available() && !controller.signal.aborted && sameSource()
      && slot.version === version && slot.pending.value === file
    let imageId = '', published = false
    try {
      await withArtworkStaging(async () => {
        if (!current()) return
        await uploadVideoImage(file, undefined, controller.signal)
        if (!current()) return
        imageId = await repository.putImage(file).catch(() => '')
        if (!current()) return
        slot.id.value = imageId; slot.blob.value = imageId ? null : file; slot.pending.value = null
        published = true
        if (!imageId) deps.statusError.value = '原图本地保存失败，当前窗口会保留图片；刷新前请重新选择图片或明确移除'
        await restorePreview(slot, file)
      })
    } catch (error) {
      if (current()) {
        const message = error instanceof Error ? error.message : '图片上传失败'
        deps.statusError.value = `${message}；所选图片已保留，重新进入页面可重试，也可明确移除`
      }
    } finally {
      // The desktop adapter is reused across workspaces. Never release an old
      // alias through a new authority; the original workspace's orphan GC owns it.
      if (imageId && !published && sameSource()) await repository.deleteImage(imageId).catch(() => {})
      if (slot.upload === controller) slot.upload = null
      finish(controller)
    }
  }

  async function handleFrameFile(event: Event, target: 'first' | 'last') {
    const input = event.target as HTMLInputElement, file = input.files?.[0]
    input.value = ''
    if (!file || !available()) return
    if (!file.type.startsWith('image/')) { deps.statusError.value = '仅支持图片文件（PNG / JPEG / WebP）'; return }
    const slot = target === 'first' ? first : last
    preparation?.abort(); stopSlot(slot); slot.preview.stop()
    // Retain/register the actual File before the first lock or network await.
    slot.pending.value = file; deps.statusError.value = ''
    await prepareFile(slot, file)
    if (!slot.pending.value && !slot.preview.url.value) await restorePreview(slot)
  }

  async function restorePreviews() {
    if (!available()) return
    await Promise.all([first, last].map(async slot => {
      if (slot.pending.value) await prepareFile(slot, slot.pending.value)
      if (!slot.upload && !slot.preview.url.value) await restorePreview(slot)
    }))
  }

  /** Transfer the existing prompt/story/blueprint intent without rewriting it. */
  function composeVideoPrompt(ctx: VideoCtxPayload): string {
    const prompt = (ctx.prompt || '').trim(), story = (ctx.story || '').trim()
    if (prompt || story) return prompt || story
    const blueprint = ctx.blueprintId && sceneStore.sceneBlueprints.find(item => item.id === ctx.blueprintId)
    return blueprint ? (blueprint.promptProse || '').trim()
      || [blueprint.description, blueprint.action, blueprint.lighting].filter(Boolean).join('，') : ''
  }
  async function consumeVideoCtx() {
    if (!available()) return
    const ctx = videoStore.pendingImageCtx
    if (!ctx?.imageId) return
    if (videoStore.videoDraft?.importSourceImageId !== ctx.imageId) {
      clearFrame(first); clearFrame(last)
      deps.selectedMode.value = 'image'; deps.aspectRatio.value = 'original'
      if (deps.status.value?.models.some(model => model.id === 'minimax-h3')) deps.selectedModelId.value = 'minimax-h3'
      deps.prompt.value = composeVideoPrompt(ctx); first.id.value = ctx.imageId
    }
    const version = ++contextVersion
    const current = () => available() && version === contextVersion && videoStore.pendingImageCtx === ctx
    try {
      // A matching optimistic draft is not proof of persistence. Flush it again.
      await deps.persistImportedCtx(ctx.imageId)
      if (!current()) return
      if (!videoStore.consumeImageCtx(ctx)) deps.statusError.value = '视频草稿已保存，导入待办更新失败；请重新进入页面重试'
    } catch {
      if (current()) deps.statusError.value = '视频草稿尚未写稳，绘图导入待办已保留；请保持原工作区连接并重试'
    }
  }

  /** Every explicit generation confirms a controlled input from its durable alias
   * or original bytes. Request recovery never calls this preparation again. */
  async function resolveSubmitFrames(mode: VideoMode | 'shots', signal: AbortSignal): Promise<{ image?: string; lastFrame?: string }> {
    signal.throwIfAborted()
    if (mode !== 'image' && mode !== 'first-last-frame') return {}
    preparation?.abort()
    const controller = new AbortController(); preparation = controller
    const combined = AbortSignal.any([signal, controller.signal]), repository = artworkRepository, mediaSession = imageMediaSession()
    const slots = mode === 'first-last-frame' ? [first, last] : [first]
    const sources = slots.map(slot => ({ slot, id: slot.id.value, blob: slot.blob.value, version: slot.version }))
    const check = () => {
      combined.throwIfAborted()
      if (!available() || repository !== artworkRepository || mediaSession !== imageMediaSession()) throw new Error('图片连接已变化，请确认后重新生成')
      if (sources.some(source => source.slot.pending.value)) throw new Error('所选帧图尚未准备完成，请重新进入页面重试或移除后重新选择')
      if (sources.some(source => source.slot.version !== source.version || source.slot.id.value !== source.id
        || source.slot.blob.value !== source.blob)) throw new Error('准备期间帧图已更换，请确认后重新生成')
    }
    async function resolve(source: typeof sources[number]) {
      check()
      if (source.id && repository.getWorkspaceMediaReference) {
        const reference = repository.getWorkspaceMediaReference(source.id)
        check()
        const uploaded = await importWorkspaceVideoImage(reference.alias, combined)
        check(); return uploaded.name
      }
      const blob = source.blob || (source.id ? await repository.getImage(source.id, combined) : null)
      check()
      if (!blob?.size) throw new Error(`${source.slot.label}图片读取失败，请重新选择`)
      const uploaded = await uploadVideoImage(blob, undefined, combined)
      check(); return uploaded.name
    }
    track(controller)
    try {
      const image = await resolve(sources[0]!)
      const lastFrame = sources[1] ? await resolve(sources[1]) : undefined
      check(); return { image, lastFrame }
    } finally {
      if (preparation === controller) preparation = null
      finish(controller)
    }
  }

  function refreshSession() {
    const next = imageMediaSession()
    if (session === next) return
    session = next; stopOperations()
    if (available()) void restorePreviews()
  }
  const stopRuntime = onDesktopRuntime(refreshSession)
  const stopResourceWatch = watch(runtimeResourceIdentity, refreshSession, { flush: 'sync' })
  onActivated(() => { active = true })
  onDeactivated(() => { active = false; stopOperations() })
  onScopeDispose(() => {
    disposed = true; active = false; stopRuntime(); stopResourceWatch(); stopOperations()
    first.blob.value = null; first.pending.value = null; last.blob.value = null; last.pending.value = null
    releaseMigration()
  })
  return {
    videoImageUrl: first.preview.url, lastFrameUrl: last.preview.url, uploadingImage, hasFirstFrame, hasLastFrame,
    consumeVideoCtx, restorePreviews, handleFrameFile, resolveSubmitFrames,
    clearFirstFrame: () => clearFrame(first), clearLastFrame: () => clearFrame(last),
  }
}
