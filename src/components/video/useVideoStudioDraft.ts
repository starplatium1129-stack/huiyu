import { watch, type Ref } from 'vue'
import { artworkRepository } from '@/storage/artworkRepository'
import { useVideoStore, type VideoDraftPayload } from '@/stores/videoStore'
import { fetchVideoJob, type VideoDefaults, type VideoJob, type VideoMode } from '@/api/videoApi'
import { ApiClientError } from '@/api/client'

/**
 * 视频页创作草稿与任务重连（2026-09-06 体验报告 F1，自 VideoStudioView 下沉）。
 *
 * 旧行为：模式/描述/参数/在途任务全是页面局部 ref——切到作品册再回来，
 * 66 字描述直接归零，运行中的任务句柄随轮询停止而失联。
 *
 * 现在：草稿（模式/参数/描述/首帧尾帧的 IndexedDB 引用）防抖落 sessionStorage，
 * 回页水合；任务提交后记 jobId，回页按 id 拉取真实状态并恢复轮询。
 * 图片本体只在 IndexedDB（服务端受控文件名会随任务清理，恢复时重新上传换新名）。
 */

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
  videoImageUrl: Ref<string>
  lastFrameUrl: Ref<string>
  /** 草稿写入/恢复失败的用户可见通道（view 的 statusError）。 */
  onPersistError: (message: string) => void
}

export type ReconnectResult =
  | { kind: 'job'; job: VideoJob }
  | { kind: 'lost' }      // 410：网关重启，任务中断
  | { kind: 'missing' }   // 404：记录失效，静默清除
  | { kind: 'unreachable' } // 网络/网关暂不可达：保留记录，下次再试
  | { kind: 'none' }

export function useVideoStudioDraft(deps: VideoStudioDraftDeps) {
  const videoStore = useVideoStore()
  let restoring = false
  let draftTimer = 0

  function persistDraft() {
    if (restoring) return
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
      lastFrameImageId: deps.lastFrameImageId.value,
      updatedAt: Date.now(),
    }
    if (!videoStore.saveVideoDraft(draft)) {
      deps.onPersistError('视频草稿保存失败（存储空间不足）：内容仍在页面中，但刷新后可能丢失')
    }
  }

  /** 监听草稿字段（防抖 350ms）；返回停止函数由调用方挂到卸载钩子。 */
  function startDraftWatch(): () => void {
    const stop = watch(
      [deps.selectedMode, deps.prompt, deps.negative, deps.selectedModelId, deps.aspectRatio,
        deps.quality, deps.steps, deps.duration, deps.camera, deps.motion, deps.seedText,
        deps.videoImageId, deps.lastFrameImageId],
      () => {
        window.clearTimeout(draftTimer)
        draftTimer = window.setTimeout(persistDraft, 350)
      },
    )
    return () => { stop(); window.clearTimeout(draftTimer); persistDraft() }
  }

  /** 单张帧图恢复：IndexedDB 取 blob 重建预览；失效返回 false（草稿其余部分照常）。 */
  async function restoreFrame(imageId: string, urlRef: Ref<string>): Promise<boolean> {
    if (!imageId) return true
    try {
      const blob = await artworkRepository.getImage(imageId)
      if (!blob || !blob.size) return false
      if (urlRef.value) URL.revokeObjectURL(urlRef.value)
      urlRef.value = URL.createObjectURL(blob)
      return true
    } catch {
      return false
    }
  }

  /**
   * 水合草稿。返回首帧/尾帧原图失效标记（true=失效，调用方提示重新选择）。
   * 不恢复 mode 为 shots 的草稿（分镜草稿由 ShotListEditor 自己的草稿承担）。
   */
  async function restoreDraft(): Promise<{ firstFrameLost: boolean; lastFrameLost: boolean }> {
    const draft = videoStore.videoDraft
    if (!draft) return { firstFrameLost: false, lastFrameLost: false }
    restoring = true
    try {
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
    const firstOk = await restoreFrame(deps.videoImageId.value, deps.videoImageUrl)
    if (!firstOk) deps.videoImageId.value = ''
    const lastOk = await restoreFrame(deps.lastFrameImageId.value, deps.lastFrameUrl)
    if (!lastOk) deps.lastFrameImageId.value = ''
    return { firstFrameLost: !firstOk, lastFrameLost: !lastOk }
  }

  /** 任务重连：按记录的 jobId 拉真实状态；语义化结果由调用方决定提示文案。 */
  async function reconnectTask(): Promise<ReconnectResult> {
    const record = videoStore.videoTask
    if (!record) return { kind: 'none' }
    try {
      const response = await fetchVideoJob(record.jobId)
      return { kind: 'job', job: response.job }
    } catch (error) {
      if (error instanceof ApiClientError && error.kind === 'http') {
        if (error.status === 410) {
          videoStore.clearVideoTask()
          return { kind: 'lost' }
        }
        if (error.status === 404) {
          videoStore.clearVideoTask()
          return { kind: 'missing' }
        }
      }
      return { kind: 'unreachable' }
    }
  }

  return { startDraftWatch, persistDraft, restoreDraft, reconnectTask }
}
