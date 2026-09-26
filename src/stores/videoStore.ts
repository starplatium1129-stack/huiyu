import { profileDraftStorage as sessionStorage } from '../platform/web/profileStorage.ts'
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { artworkRepository } from '@/storage/artworkRepository'
import {
  VIDEO_CONTEXT_KEY,
  VIDEO_DRAFT_KEY,
  VIDEO_SCENARIO_CONTEXT_KEY,
  VIDEO_SHOTS_BATCH_KEY,
  VIDEO_SHOTS_CONTEXT_KEY,
  VIDEO_SHOTS_DRAFT_KEY,
  VIDEO_TASK_KEY,
} from '@/utils/storageKeys'

/**
 * 视频工作台领域 Store（2026-08-22 从 useVideoBridge 的 sessionStorage 黑盒收敛）。
 *
 * 职责：
 * 1. 绘图页 → 视频页的跨页交接载荷（单图出视频 / 多图分镜短片），类型化 + 响应式；
 * 2. 底层仍持久化到 sessionStorage（键名不变）：跨 SPA 路由与整页刷新都存活，
 *    且保持「视频页一次性消费」语义——消费即清除，不产生幽灵预填。
 * 图片本体不入 store：走作品媒体仓储，载荷只带 imageId。
 */

export interface VideoCtxPayload {
  imageId: string
  /** 最近一次实际出图的完整提示词（视频提示词首选源）。 */
  prompt: string
  /** 用户出图时写的场景描述（prompt 为空时的次选源）。 */
  story: string
  blueprintId: string | null
  characterId: string
  /**
   * 出图时的服装形态 id（2026-09-06 体验报告 F3）：分镜页参考卡按角色+服装
   * 装配；旧载荷缺省 null，装配回退默认服装。
   */
  outfitId?: string | null
  sceneId: string | null
}

export interface VideoBridgeTarget {
  /** 当前显示结果 url（sd 引擎用于 fetch 原图 blob）。 */
  displayUrl: string
  /** anima/krea 结果 blob（非 sd 引擎直用；null 时走 fetch displayUrl）。 */
  animaBlob: Blob | null
  prompt: string
  story: string
  blueprintId: string | null
  characterId: string
  /** 出图时冻结的服装形态 id（F3 快照随行）。 */
  outfitId?: string | null
  sceneId: string | null
  flash: (message: string) => void
  push: (path: string) => Promise<unknown> | void
}

/** 剧本模式一幕 → 分镜镜头（无图纯文本；首帧走分镜的「一键首帧」或手动上传）。 */
export interface StagedScenarioAct {
  prompt: string
  dialogue: string
  shotSize: 'wide' | 'medium' | 'closeup'
  camera: 'still' | 'push' | 'pull' | 'pan' | 'orbit'
  motion: 'subtle' | 'natural' | 'expressive'
  duration: number
  /** 工作室角色（nene / natsume）：参考卡由用户在分镜模式手动挂载。 */
  characterId: string
}

// ── 创作草稿与任务记录（2026-09-06 体验报告 F1）────────────────────────────
// 图片本体一律不入草稿：首帧/尾帧只记 IndexedDB 图片 id，恢复时重建预览并
// 重新上传换取受控文件名（服务端 aics_video_input_ 前缀会随任务结束清理）。

/** 单任务模式（文字/图生/首尾帧）的编辑草稿。 */
export interface VideoDraftPayload {
  mode: string
  prompt: string
  negative: string
  modelId: string
  aspectRatio: string
  quality: string
  steps: number
  duration: number
  camera: string
  motion: string
  seedText: string
  /** 首帧 IndexedDB 图片 id（空串=未带图）。 */
  videoImageId: string
  /** 尾帧 IndexedDB 图片 id（空串=未带图）。 */
  lastFrameImageId: string
  updatedAt: number
}

/** 在途/最近一次单任务视频记录：离页后按 jobId 重连真实状态。 */
export interface VideoTaskRecord {
  jobId: string
  mode: string
  submittedAt: number
}

/** 分镜参考卡元信息（图片本体不入草稿：角色卡按 characterId+outfitId 重装配）。 */
export interface ShotsDraftCard {
  label: string
  characterId: string
  outfitId: string
}

export interface ShotsDraftShot {
  prompt: string
  dialogue: string
  shotSize: string
  camera: string
  motion: string
  duration: number
  seedText: string
  cast: string
  firstFramePrompt?: string
  /** 首帧 IndexedDB 图片 id（空串=无首帧；恢复时重上传换新受控名）。 */
  imageId: string
}

/** 分镜短片整页编辑草稿。 */
export interface ShotsDraftPayload {
  aspectRatio: string
  quality: string
  steps: number
  linkLastFrame: boolean
  identityCard: string
  cards: ShotsDraftCard[]
  shots: ShotsDraftShot[]
  updatedAt: number
}

/** 分镜整批任务记录：离页后按 batchId 重连真实进度。 */
export interface ShotsBatchRecord {
  batchId: string
  submittedAt: number
}

const IMAGE_CTX_KEY = VIDEO_CONTEXT_KEY
/** 分镜短片批量带入：绘图页逐张「加入分镜」累积，视频页分镜模式一次性消费。 */
const SHOTS_CTX_KEY = VIDEO_SHOTS_CONTEXT_KEY
/** 剧本模式分幕 → 分镜短片：无图纯文本载荷，视频页一次性消费。 */
const SCENARIO_CTX_KEY = VIDEO_SCENARIO_CONTEXT_KEY

function isVideoCtxPayload(value: unknown): value is VideoCtxPayload {
  return typeof value === 'object' && value !== null && typeof (value as VideoCtxPayload).imageId === 'string'
}

function isStagedScenarioAct(value: unknown): value is StagedScenarioAct {
  if (typeof value !== 'object' || value === null) return false
  const act = value as Partial<StagedScenarioAct>
  return typeof act.prompt === 'string' && typeof act.characterId === 'string'
}

function isVideoDraft(value: unknown): value is VideoDraftPayload {
  if (typeof value !== 'object' || value === null) return false
  const draft = value as Partial<VideoDraftPayload>
  return typeof draft.mode === 'string' && typeof draft.prompt === 'string'
}

function isVideoTaskRecord(value: unknown): value is VideoTaskRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<VideoTaskRecord>
  return typeof record.jobId === 'string' && record.jobId.length > 0
}

function isShotsDraft(value: unknown): value is ShotsDraftPayload {
  if (typeof value !== 'object' || value === null) return false
  const draft = value as Partial<ShotsDraftPayload>
  return Array.isArray(draft.shots) && Array.isArray(draft.cards)
}

function isShotsBatchRecord(value: unknown): value is ShotsBatchRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<ShotsBatchRecord>
  return typeof record.batchId === 'string' && record.batchId.length > 0
}

function readJson<T>(key: string, validate: (value: unknown) => value is T): T | null {
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return validate(parsed) ? parsed : null
  } catch {
    return null
  }
}

function writeJson(key: string, value: unknown): boolean {
  try {
    sessionStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

function removeKey(key: string): void {
  try { sessionStorage.removeItem(key) } catch { /* 忽略 */ }
}

function readStoredShots(): VideoCtxPayload[] {
  const list = readJson<VideoCtxPayload[]>(SHOTS_CTX_KEY, Array.isArray)
  return Array.isArray(list) ? list.filter(isVideoCtxPayload) : []
}

function readStoredScenarioActs(): StagedScenarioAct[] {
  const list = readJson<StagedScenarioAct[]>(SCENARIO_CTX_KEY, Array.isArray)
  return Array.isArray(list) ? list.filter(isStagedScenarioAct) : []
}

export const useVideoStore = defineStore('videoStudio', () => {
  // ── 状态（初始化时从 sessionStorage 水合，刷新不丢） ──
  const pendingImageCtx = ref<VideoCtxPayload | null>(readJson(IMAGE_CTX_KEY, isVideoCtxPayload))
  const pendingShotCtxs = ref<VideoCtxPayload[]>(readStoredShots())
  const pendingScenarioActs = ref<StagedScenarioAct[]>(readStoredScenarioActs())

  // ── 派生 ──
  /** 绘图页「已加入分镜」角标计数。 */
  const shotsPending = computed(() => pendingShotCtxs.value.length)

  // ── 单图出视频交接 ──
  function stageImageCtx(ctx: VideoCtxPayload): boolean {
    pendingImageCtx.value = ctx
    if (!writeJson(IMAGE_CTX_KEY, ctx)) {
      pendingImageCtx.value = null
      return false
    }
    return true
  }

  /** 视频页一次性消费：取走并清除。 */
  function consumeImageCtx(): VideoCtxPayload | null {
    const ctx = pendingImageCtx.value
    if (!ctx) return null
    pendingImageCtx.value = null
    removeKey(IMAGE_CTX_KEY)
    return ctx
  }

  // ── 分镜短片批量交接 ──
  /**
   * 追加一张。返回明确的成败与当前总数（2026-09-06 体验报告 F4）：
   * 存储写失败时**回滚内存、原列表一根不动**——旧语义是静默挤掉最旧一张，
   * 返回值还让调用方误以为成功，刷新后界面与存储不一致。
   */
  function appendShotCtx(ctx: VideoCtxPayload): { ok: boolean; count: number } {
    const list = [...pendingShotCtxs.value, ctx]
    if (!writeJson(SHOTS_CTX_KEY, list)) {
      return { ok: false, count: pendingShotCtxs.value.length }
    }
    pendingShotCtxs.value = list
    return { ok: true, count: list.length }
  }

  function stageShotCtxs(list: VideoCtxPayload[]): boolean {
    pendingShotCtxs.value = list
    if (!writeJson(SHOTS_CTX_KEY, list)) {
      pendingShotCtxs.value = []
      removeKey(SHOTS_CTX_KEY)
      return false
    }
    return true
  }

  /** 视频页分镜模式一次性消费：取走全部并清除。 */
  function consumeShotCtxs(): VideoCtxPayload[] {
    const list = pendingShotCtxs.value
    if (!list.length) return []
    pendingShotCtxs.value = []
    removeKey(SHOTS_CTX_KEY)
    return list
  }

  // ── 剧本模式分幕交接（2026-08-23 激活：剧本页整本送入分镜短片） ──────────
  function stageScenarioActs(list: StagedScenarioAct[]): boolean {
    pendingScenarioActs.value = list
    if (!writeJson(SCENARIO_CTX_KEY, list)) {
      pendingScenarioActs.value = []
      removeKey(SCENARIO_CTX_KEY)
      return false
    }
    return true
  }

  /** 视频页分镜模式一次性消费：取走并清除。 */
  function consumeScenarioActs(): StagedScenarioAct[] {
    const list = pendingScenarioActs.value
    if (!list.length) return []
    pendingScenarioActs.value = []
    removeKey(SCENARIO_CTX_KEY)
    return list
  }

  // ── 创作草稿与任务记录（F1：切页/刷新不丢创作上下文）─────────────────────
  const videoDraft = ref<VideoDraftPayload | null>(readJson(VIDEO_DRAFT_KEY, isVideoDraft))
  const videoTask = ref<VideoTaskRecord | null>(readJson(VIDEO_TASK_KEY, isVideoTaskRecord))
  const shotsDraft = ref<ShotsDraftPayload | null>(readJson(VIDEO_SHOTS_DRAFT_KEY, isShotsDraft))
  const shotsBatch = ref<ShotsBatchRecord | null>(readJson(VIDEO_SHOTS_BATCH_KEY, isShotsBatchRecord))

  /** 草稿写入失败必须可感知（F1 验收）：返回 false 由调用方提示。 */
  function saveVideoDraft(draft: VideoDraftPayload): boolean {
    if (!writeJson(VIDEO_DRAFT_KEY, draft)) return false
    videoDraft.value = draft
    return true
  }

  function clearVideoDraft(): void {
    videoDraft.value = null
    removeKey(VIDEO_DRAFT_KEY)
  }

  function recordVideoTask(record: VideoTaskRecord): boolean {
    if (!writeJson(VIDEO_TASK_KEY, record)) return false
    videoTask.value = record
    return true
  }

  function clearVideoTask(): void {
    videoTask.value = null
    removeKey(VIDEO_TASK_KEY)
  }

  function saveShotsDraft(draft: ShotsDraftPayload): boolean {
    if (!writeJson(VIDEO_SHOTS_DRAFT_KEY, draft)) return false
    shotsDraft.value = draft
    return true
  }

  function clearShotsDraft(): void {
    shotsDraft.value = null
    removeKey(VIDEO_SHOTS_DRAFT_KEY)
  }

  function recordShotsBatch(record: ShotsBatchRecord): boolean {
    if (!writeJson(VIDEO_SHOTS_BATCH_KEY, record)) return false
    shotsBatch.value = record
    return true
  }

  function clearShotsBatch(): void {
    shotsBatch.value = null
    removeKey(VIDEO_SHOTS_BATCH_KEY)
  }

  return {
    pendingImageCtx,
    pendingShotCtxs,
    shotsPending,
    stageImageCtx,
    consumeImageCtx,
    appendShotCtx,
    stageShotCtxs,
    consumeShotCtxs,
    stageScenarioActs,
    consumeScenarioActs,
    videoDraft,
    videoTask,
    shotsDraft,
    shotsBatch,
    saveVideoDraft,
    clearVideoDraft,
    recordVideoTask,
    clearVideoTask,
    saveShotsDraft,
    clearShotsDraft,
    recordShotsBatch,
    clearShotsBatch,
  }
})

// ── IndexedDB 相关桥接（blob 处理不属于 store，保留在组合层） ──────────────

/** 图片入 IndexedDB + 组装跨页上下文（不导航；单图/多图共用）。 */
export async function prepareVideoCtx(target: VideoBridgeTarget): Promise<VideoCtxPayload | null> {
  try {
    let blob: Blob
    if (target.animaBlob) {
      blob = target.animaBlob
    } else {
      const response = await fetch(target.displayUrl, { cache: 'no-store' })
      const contentType = response.headers.get('content-type') || ''
      if (!response.ok || !contentType.startsWith('image/')) {
        target.flash('成片响应无效，请重新生成')
        return null
      }
      blob = await response.blob()
    }
    if (!blob.size) {
      target.flash('成片数据已失效，请重新生成')
      return null
    }
    const imageId = await artworkRepository.putImage(blob)
    return {
      imageId,
      prompt: target.prompt,
      story: target.story,
      blueprintId: target.blueprintId,
      characterId: target.characterId,
      outfitId: target.outfitId ?? null,
      sceneId: target.sceneId,
    }
  } catch (error) {
    target.flash('成片处理失败')
    console.warn(error)
    return null
  }
}
import { runtimeFetch as fetch } from '@/platform/runtimeUrl'
