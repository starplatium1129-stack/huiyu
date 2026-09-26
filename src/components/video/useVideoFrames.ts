import { withArtworkStaging } from '@/storage/artworkSession'
import type { Ref } from 'vue'
import {
  uploadVideoImage,
  type VideoDefaults,
  type VideoMode,
  type VideoStatusResponse,
} from '@/api/videoApi'
import { artworkRepository } from '@/storage/artworkRepository'
import { useVideoStore, type VideoCtxPayload } from '@/stores/videoStore'
import { useSceneStore } from '@/stores/sceneStore'

/**
 * 视频页首帧/尾帧素材与绘图页跨页上下文（2026-09-06 自 VideoStudioView 下沉，
 * 体验报告 F1 草稿化的前置拆分）。
 *
 * 职责：帧图上传/移除/预览 URL 生命周期、绘图页「出视频」ctx 的一次性消费应用、
 * 提交时的帧图解析（IndexedDB 原图重上传，无耐久副本时受控名仅用一次——服务端
 * aics_video_input_ 前缀会随任务结束清理，刷新后旧名可能已失效）。
 */

export interface VideoFramesDeps {
  selectedMode: Ref<VideoMode | 'shots'>
  aspectRatio: Ref<VideoDefaults['aspectRatio']>
  selectedModelId: Ref<string>
  prompt: Ref<string>
  videoImageId: Ref<string>
  videoImageUrl: Ref<string>
  firstFrameName: Ref<string>
  lastFrameImageId: Ref<string>
  lastFrameUrl: Ref<string>
  lastFrameName: Ref<string>
  uploadingImage: Ref<boolean>
  status: Ref<VideoStatusResponse | null>
  statusError: Ref<string>
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('图片编码失败'))
    reader.readAsDataURL(blob)
  })
}

export function useVideoFrames(deps: VideoFramesDeps) {
  const {
    selectedMode, aspectRatio, selectedModelId, prompt,
    videoImageId, videoImageUrl, firstFrameName,
    lastFrameImageId, lastFrameUrl, lastFrameName,
    uploadingImage, status, statusError,
  } = deps
  const videoStore = useVideoStore()
  const sceneStore = useSceneStore()
  let firstVersion = 0
  let lastVersion = 0
  let pendingUploads = 0

  /**
   * 跨页上下文 → 视频提示词（确定性组装，不做 tag 翻译）：
   * 1. 实际出图提示词（ctx.prompt）直接作为视频主描述；
   * 2. prompt 为空时回退用户写的 story；
   * 3. story 为空时，用场景预设的结构化字段——优先英文 promptProse，
   *    缺失时才回退中文 description + action + lighting；
   * 4. I2VA 首帧图已在后端按官方规范锁定角色/服装/场景（<Picture 1> 指令），
   *    身份描述如与画面冲突可在文本框手动删减，这里只做搬运不做裁剪。
   */
  function composeVideoPrompt(ctx: VideoCtxPayload): string {
    const ctxPrompt = (ctx.prompt || '').trim()
    if (ctxPrompt) return ctxPrompt
    const story = (ctx.story || '').trim()
    if (story) return story
    if (ctx.blueprintId) {
      const bp = sceneStore.sceneBlueprints.find(item => item.id === ctx.blueprintId)
      if (bp) {
        const prose = (bp.promptProse || '').trim()
        if (prose) return prose
        return [bp.description, bp.action, bp.lighting].filter(Boolean).join('，')
      }
    }
    return ''
  }

  async function applyVideoCtx(ctx: VideoCtxPayload) {
    clearFirstFrame()
    clearLastFrame()
    const version = firstVersion
    try {
      const blob = await artworkRepository.getImage(ctx.imageId)
      if (version !== firstVersion) return
      if (blob) {
        if (videoImageUrl.value) URL.revokeObjectURL(videoImageUrl.value)
        videoImageUrl.value = URL.createObjectURL(blob)
        videoImageId.value = ctx.imageId
      } else {
        statusError.value = '带入的首帧原图已失效，请重新选择图片'
      }
    } catch { if (version === firstVersion) statusError.value = '首帧图片读取失败，请重新选择图片' }
    if (version !== firstVersion) return
    selectedMode.value = 'image'
    // 首帧比例跟随原图，避免固定画幅拉伸（如 832x1216 出图 → 480x832 画布会变形）。
    aspectRatio.value = 'original'
    // 图生视频只有支持 image 的模型可用（本机目录里即 MiniMax H3）；Wan 5B 会静默丢掉首帧，
    // 这里直接选到 H3，避免用户带着首帧落到「文字成片」模型上。
    if (status.value?.models.some(model => model.id === 'minimax-h3')) {
      selectedModelId.value = 'minimax-h3'
    }
    const composed = composeVideoPrompt(ctx)
    if (composed && composed.trim().length >= 4) prompt.value = composed
  }

  /** 绘图页「出视频」跨页上下文（一次性消费，videoStore 承载）。 */
  function consumeVideoCtx() {
    const ctx = videoStore.consumeImageCtx()
    if (!ctx || !ctx.imageId) return
    void applyVideoCtx(ctx)
  }

  function clearFirstFrame() {
    firstVersion++
    if (videoImageUrl.value) URL.revokeObjectURL(videoImageUrl.value)
    videoImageUrl.value = ''
    videoImageId.value = ''
    firstFrameName.value = ''
  }

  function clearLastFrame() {
    lastVersion++
    if (lastFrameUrl.value) URL.revokeObjectURL(lastFrameUrl.value)
    lastFrameUrl.value = ''
    lastFrameName.value = ''
    lastFrameImageId.value = ''
  }

  /**
   * 本地上传首帧/尾帧：base64 → 网关 → 受控文件名 + 本地预览。
   * 同时写 IndexedDB 留耐久凭据（F1）：受控名随任务清理，草稿恢复靠 imageId 重上传。
   */
  async function handleFrameFile(event: Event, slot: 'first' | 'last') {
    return withArtworkStaging(async () => {
      const input = event.target as HTMLInputElement
      const file = input.files?.[0]
      input.value = ''
      if (!file) return
      if (!file.type.startsWith('image/')) {
        statusError.value = '仅支持图片文件（PNG / JPEG / WebP）'
        return
      }
      const version = slot === 'first' ? ++firstVersion : ++lastVersion
      const isCurrent = () => version === (slot === 'first' ? firstVersion : lastVersion)
      pendingUploads++
      uploadingImage.value = true
      statusError.value = ''
      try {
        const upload = await uploadVideoImage(await blobToBase64(file))
        const imageId = await artworkRepository.putImage(file).catch(() => '')
        if (!isCurrent()) return
        const preview = URL.createObjectURL(file)
        if (!imageId) statusError.value = '图片可用于本次生成，但本地保存失败，刷新或再次生成前需重新选择图片'
        if (slot === 'first') {
          if (videoImageUrl.value) URL.revokeObjectURL(videoImageUrl.value)
          videoImageUrl.value = preview
          firstFrameName.value = upload.name
          videoImageId.value = imageId
        } else {
          if (lastFrameUrl.value) URL.revokeObjectURL(lastFrameUrl.value)
          lastFrameUrl.value = preview
          lastFrameName.value = upload.name
          lastFrameImageId.value = imageId
        }
      } catch (error) {
        if (isCurrent()) statusError.value = error instanceof Error ? error.message : '图片上传失败'
      } finally {
        pendingUploads--
        uploadingImage.value = pendingUploads > 0
      }
    })
  }

  /**
   * 提交时优先用本地原图换取新受控名；服务端会在任务结束时清理旧文件。
   * 没有耐久副本时仅使用一次本会话受控名，再次生成要求重新选择图片。
   */
  async function resolveSubmitFrames(mode: VideoMode | 'shots'): Promise<{ image?: string; lastFrame?: string }> {
    if (mode !== 'image' && mode !== 'first-last-frame') return {}
    const first = { id: videoImageId.value, name: firstFrameName.value, version: firstVersion }
    const last = { id: lastFrameImageId.value, name: lastFrameName.value, version: lastVersion }
    // 服务端会清理已提交的输入文件；有本地原图时每次重传，没有耐久副本时旧名只使用一次。
    firstFrameName.value = ''
    if (mode === 'first-last-frame') lastFrameName.value = ''
    async function resolve(frame: { id: string; name: string }, label: string) {
      if (frame.id) {
        const blob = await artworkRepository.getImage(frame.id)
        if (!blob) throw new Error(`${label}图片读取失败，请重新选择`)
        return (await uploadVideoImage(await blobToBase64(blob))).name
      }
      if (frame.name) return frame.name
      throw new Error(`${label}图片读取失败，请重新选择`)
    }
    pendingUploads++
    uploadingImage.value = true
    try {
      const image = await resolve(first, '首帧')
      const lastFrame = mode === 'first-last-frame' ? await resolve(last, '尾帧') : undefined
      if (first.version !== firstVersion || (mode === 'first-last-frame' && last.version !== lastVersion)) {
        throw new Error('准备期间帧图已更换，请确认后重新生成')
      }
      return { image, lastFrame }
    } finally {
      pendingUploads--
      uploadingImage.value = pendingUploads > 0
    }
  }

  function disposeFrames() { firstVersion++; lastVersion++ }

  return {
    applyVideoCtx,
    consumeVideoCtx,
    clearFirstFrame,
    clearLastFrame,
    handleFrameFile,
    resolveSubmitFrames,
    disposeFrames,
  }
}
