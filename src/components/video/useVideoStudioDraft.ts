import { onScopeDispose, watch, type Ref } from 'vue'
import { useVideoStore, type VideoDraftPayload } from '@/stores/videoStore'
import { type VideoDefaults, type VideoMode } from '@/api/videoApi'
import { registerMaintenanceParticipant } from '@/platform/maintenanceParticipants'
import { sameTempResultOwner, tempResultOwner } from '@/utils/tempResult'
import { getDesktopRuntime } from '@/platform/desktop/runtime'
import { flushProfileWrites } from '@/platform/web/profileStorage'

/** Editable frame references and parameters; admission belongs to useVideoRequest. */
export interface VideoStudioDraftDeps {
  selectedMode: Ref<VideoMode | 'shots'>
  prompt: Ref<string>
  negative: Ref<string>
  selectedModelId: Ref<string>
  aspectRatio: Ref<VideoDefaults['aspectRatio']>
  quality: Ref<VideoDefaults['quality']>
  steps: Ref<4 | 8>
  duration: Ref<VideoDefaults['duration']>
  camera: Ref<VideoDefaults['camera']>
  motion: Ref<VideoDefaults['motion']>
  seedText: Ref<string>
  videoImageId: Ref<string>
  lastFrameImageId: Ref<string>
  /** 草稿写入/恢复失败的用户可见通道（view 的 statusError）。 */
  onPersistError: (message: string) => void
}

export function useVideoStudioDraft(deps: VideoStudioDraftDeps) {
  const videoStore = useVideoStore()
  const owner = tempResultOwner()
  let restoring = false
  let draftTimer = 0
  let saveFailed = false
  let disposed = false
  let importSourceImageId = ''
  onScopeDispose(() => { disposed = true }, true)
  watch(() => videoStore.videoReloadVersion, () => {
    window.clearTimeout(draftTimer); draftTimer = 0
    restoreDraft()
  }, { flush: 'sync' })

  function checkOwner() {
    if (sameTempResultOwner(owner)) return
    const workspace = getDesktopRuntime().bootstrap?.runtime?.workspace
    // A disconnect keeps the logical draft owner. The existing profile outbox
    // decides whether it can save now; no old IDs are moved to a new workspace.
    if (owner.kind === 'workspace' && workspace?.workspaceId === owner.workspaceId
      && workspace.principalId === owner.principalId) return
    throw new Error('视频所属资料已变化，请回到原工作区保存')
  }

  function persistDraft(sourceImageId?: string): boolean {
    if (disposed || restoring) return false
    try { checkOwner() } catch {
      saveFailed = true
      deps.onPersistError('视频草稿所属资料已变化，原内容仍在页面中；请恢复原工作区后保存')
      return false
    }
    if (sourceImageId) importSourceImageId = sourceImageId
    window.clearTimeout(draftTimer); draftTimer = 0
    const draft: VideoDraftPayload = {
      mode: deps.selectedMode.value,
      prompt: deps.prompt.value,
      negative: deps.negative.value,
      modelId: deps.selectedModelId.value,
      aspectRatio: deps.aspectRatio.value,
      quality: deps.quality.value,
      steps: deps.steps.value,
      duration: deps.duration.value,
      camera: deps.camera.value,
      motion: deps.motion.value,
      seedText: deps.seedText.value,
      videoImageId: deps.videoImageId.value,
      ...(importSourceImageId ? { importSourceImageId } : {}),
      lastFrameImageId: deps.lastFrameImageId.value,
      updatedAt: Date.now(),
    }
    saveFailed = !videoStore.saveVideoDraft(draft)
    if (saveFailed) {
      deps.onPersistError(videoStore.draftIssue || '视频草稿尚未保存：内容仍在页面中，请保持窗口打开并重试')
    }
    return !saveFailed
  }

  async function persistImportedCtx(sourceImageId: string) {
    checkOwner()
    if (!persistDraft(sourceImageId)) throw new Error('视频草稿保存失败')
    await flushProfileWrites()
    checkOwner()
  }

  /** 监听草稿字段（防抖 350ms）；返回停止函数由调用方挂到卸载钩子。 */
  function startDraftWatch(): () => void {
    const releaseMaintenance = registerMaintenanceParticipant(() => {
      if (restoring) throw new Error('DRAFT_RESTORING')
      if (draftTimer || saveFailed) persistDraft()
      if (saveFailed) throw new Error('DRAFT_SAVE_FAILED')
    })
    const stop = watch(
      [deps.selectedMode, deps.prompt, deps.negative, deps.selectedModelId, deps.aspectRatio,
        deps.quality, deps.steps, deps.duration, deps.camera, deps.motion, deps.seedText,
        deps.videoImageId, deps.lastFrameImageId],
      () => {
        window.clearTimeout(draftTimer)
        draftTimer = window.setTimeout(persistDraft, 350)
      },
    )
    return () => { releaseMaintenance(); stop(); window.clearTimeout(draftTimer); persistDraft() }
  }

  /**
   * 只同步水合编辑参数和耐久图片 ID；预览由 useVideoFrames 统一恢复。
   * 不恢复 mode 为 shots 的草稿（分镜草稿由 ShotListEditor 自己的草稿承担）。
   */
  function restoreDraft(): void {
    if (disposed) return
    try { checkOwner() } catch {
      deps.onPersistError('视频草稿所属资料尚未确认，请恢复原工作区连接后重新进入页面')
      return
    }
    const draft = videoStore.videoDraft
    if (!draft) return
    restoring = true
    try {
      importSourceImageId = typeof draft.importSourceImageId === 'string' ? draft.importSourceImageId : ''
      if (['text', 'image', 'first-last-frame'].includes(draft.mode)) {
        deps.selectedMode.value = draft.mode as VideoMode
      }
      deps.prompt.value = draft.prompt || ''
      deps.negative.value = draft.negative || ''
      if (draft.modelId) deps.selectedModelId.value = draft.modelId
      if (['landscape', 'portrait', 'square', 'original'].includes(draft.aspectRatio)) {
        deps.aspectRatio.value = draft.aspectRatio as VideoDefaults['aspectRatio']
      }
      if (['fast', 'standard', 'fine'].includes(draft.quality)) {
        deps.quality.value = draft.quality as VideoDefaults['quality']
      }
      if (draft.steps === 4 || draft.steps === 8) deps.steps.value = draft.steps
      if ([3, 5, 10, 15].includes(draft.duration)) {
        deps.duration.value = draft.duration as VideoDefaults['duration']
      }
      if (['still', 'push', 'pull', 'pan', 'orbit'].includes(draft.camera)) {
        deps.camera.value = draft.camera as VideoDefaults['camera']
      }
      if (['subtle', 'natural', 'expressive'].includes(draft.motion)) {
        deps.motion.value = draft.motion as VideoDefaults['motion']
      }
      deps.seedText.value = draft.seedText || ''
      deps.videoImageId.value = draft.videoImageId || ''
      deps.lastFrameImageId.value = draft.lastFrameImageId || ''
    } finally {
      restoring = false
    }
  }

  return { startDraftWatch, persistImportedCtx, restoreDraft }
}
