import { profileDraftStorage as sessionStorage } from '../platform/web/profileStorage.ts'
import { computed, ref } from 'vue'
import { videoDraftCodec as codec } from '@/storage/videoDraftCodec'
import { createVideoDraftStorage } from '@/storage/videoDraftStorage'
import type { FirstFrameRequest } from '@/types/firstFrameRequest'
import { defineStore } from 'pinia'
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
  storyOrigin?: import('@/types/storyOrigin').StoryOrigin
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

/** 剧本模式一幕 → 分镜镜头（无图纯文本；首帧走分镜的「一键首帧」或手动上传）。 */
export interface StagedScenarioAct {
  storyOrigin?: import('@/types/storyOrigin').StoryOrigin
  /** Stable receipt for this pending act; legacy lists are upgraded on import. */
  importId?: string
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
// 图片本体不入草稿：首帧/尾帧只记耐久图片 ID，恢复时重读预览；
// 每次明确生成再从原图/工作区引用确认受控输入，受控名不作恢复凭据。

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
  /** Acknowledged drawing import; remains stable when the draft is edited. */
  importSourceImageId?: string
  /** 尾帧 IndexedDB 图片 id（空串=未带图）。 */
  lastFrameImageId: string
  updatedAt: number
}

/** 旧版只含 ID 的视频记录：仅作读取兼容，新提交走持久请求 journal。 */
export interface VideoTaskRecord {
  jobId: string
  mode: string
  submittedAt: number
}

/** 分镜参考卡元信息（图片本体不入草稿：角色卡按 characterId+outfitId 重装配）。 */
export interface ShotsDraftCard {
  outfitProseOverride?: string
  label: string
  characterId: string
  outfitId: string
}

export interface ShotSubmissionRecord {
  batchId: string
  shotIndex: number
}

export interface ShotsDraftShot {
  storyOrigin?: import('@/types/storyOrigin').StoryOrigin
  /** Explicit submission provenance; absent on legacy or unsubmitted rows. */
  submission?: ShotSubmissionRecord
  /** Opaque per-submission row identity; never copied onto editable row objects. */
  submissionToken?: string
  prompt: string
  dialogue: string
  shotSize: string
  camera: string
  motion: string
  duration: number
  seedText: string
  cast: string
  firstFramePrompt?: string
  firstFrameRequest?: FirstFrameRequest
  /** 首帧 IndexedDB 图片 id（空串=无首帧；恢复时重上传换新受控名）。 */
  imageId: string
  /** Stable source of an acknowledged drawing-to-shot import. */
  importSourceImageId?: string
  importSourceActId?: string
}

/** 分镜短片整页编辑草稿。 */
export interface ShotsDraftPayload {
  /** Pending acts already saved, retained even after their editable rows are deleted. */
  scenarioImportReceipts?: string[]
  aspectRatio: string
  quality: string
  steps: number
  linkLastFrame: boolean
  identityCard: string
  cards: ShotsDraftCard[]
  shots: ShotsDraftShot[]
  updatedAt: number
}

/** 旧版分镜 ID 读取兼容；不能由 404/410 推导出可以重复提交。 */
export interface ShotsBatchRecord {
  batchId: string
  submittedAt: number
}

const IMAGE_CTX_KEY = VIDEO_CONTEXT_KEY
/** 分镜短片批量带入：绘图页逐张「加入分镜」累积，视频页分镜模式一次性消费。 */
const SHOTS_CTX_KEY = VIDEO_SHOTS_CONTEXT_KEY
/** 剧本模式分幕 → 分镜短片：无图纯文本载荷，视频页一次性消费。 */
const SCENARIO_CTX_KEY = VIDEO_SCENARIO_CONTEXT_KEY




function isVideoTaskRecord(value: unknown): value is VideoTaskRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<VideoTaskRecord>
  return typeof record.jobId === 'string' && record.jobId.length > 0
}


function isShotsBatchRecord(value: unknown): value is ShotsBatchRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<ShotsBatchRecord>
  return typeof record.batchId === 'string' && record.batchId.length > 0
}


function readTaskHistory<T>(key: string, validate: (value: unknown) => value is T): { record: T | null; issue: string } {
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw) return { record: null, issue: '' }
    const parsed: unknown = JSON.parse(raw)
    if (!validate(parsed)) throw new Error('invalid')
    return { record: parsed, issue: '' }
  } catch { return { record: null, issue: '旧任务身份无法读取，记录已保留；请核对原任务，不能重复提交' } }
}


function removeKey(key: string): void {
  try { sessionStorage.removeItem(key) } catch { /* 忽略 */ }
}



export const useVideoStore = defineStore('videoStudio', () => {
  const drafts = createVideoDraftStorage()
  const videoReloadVersion = ref(0), shotsReloadVersion = ref(0)
  const draftIssue = computed(() => Object.values(drafts.issues.value).join('；'))
  // ── 状态（初始化时从 sessionStorage 水合，刷新不丢） ──
  const pendingImageCtx = ref<VideoCtxPayload | null>(drafts.read(IMAGE_CTX_KEY, codec.context))
  const pendingShotCtxs = ref<VideoCtxPayload[]>(drafts.read(SHOTS_CTX_KEY, codec.contexts) || [])
  const pendingScenarioActs = ref<StagedScenarioAct[]>(drafts.read(SCENARIO_CTX_KEY, codec.acts) || [])

  // ── 单图出视频交接 ──
  function stageImageCtx(ctx: VideoCtxPayload): boolean {
    const saved = drafts.write(IMAGE_CTX_KEY, ctx, codec.context)
    if (!saved) return false
    pendingImageCtx.value = saved
    return true
  }

  /** 视频页一次性消费：取走并清除。 */
  function consumeImageCtx(expected: VideoCtxPayload): VideoCtxPayload | null {
    const ctx = pendingImageCtx.value
    if (!ctx || ctx !== expected) return null
    try { sessionStorage.removeItem(IMAGE_CTX_KEY) } catch { return null }
    pendingImageCtx.value = null
    return ctx
  }

  // ── 分镜短片批量交接 ──
  /**
   * 追加一张。返回明确的成败与当前总数（2026-09-06 体验报告 F4）：
   * 存储写失败时**回滚内存、原列表一根不动**——旧语义是静默挤掉最旧一张，
   * 返回值还让调用方误以为成功，刷新后界面与存储不一致。
   */
  function appendShotCtx(ctx: VideoCtxPayload): { ok: boolean; count: number } {
    const saved = drafts.write(SHOTS_CTX_KEY, [...pendingShotCtxs.value, ctx], codec.contexts)
    if (!saved) {
      return { ok: false, count: pendingShotCtxs.value.length }
    }
    const list = [...pendingShotCtxs.value, saved[saved.length - 1]]
    pendingShotCtxs.value = list
    return { ok: true, count: list.length }
  }

  function stageShotCtxs(list: VideoCtxPayload[]): boolean {
    const saved = drafts.write(SHOTS_CTX_KEY, list, codec.contexts)
    if (!saved) return false
    pendingShotCtxs.value = list.map((item, index) => pendingShotCtxs.value.includes(item) ? item : saved[index])
    return true
  }

  // ── 剧本模式分幕交接（2026-08-23 激活：剧本页整本送入分镜短片） ──────────
  function stageScenarioActs(list: StagedScenarioAct[]): boolean {
    const pending = list.map(act => ({ ...act,
      importId: typeof act.importId === 'string' && act.importId ? act.importId : crypto.randomUUID() }))
    const saved = drafts.write(SCENARIO_CTX_KEY, pending, codec.acts)
    if (!saved) return false
    pendingScenarioActs.value = saved
    return true
  }

  // ── 创作草稿与任务记录（F1：切页/刷新不丢创作上下文）─────────────────────
  const videoDraft = ref<VideoDraftPayload | null>(drafts.read(VIDEO_DRAFT_KEY, codec.video))
  const legacyVideo = readTaskHistory(VIDEO_TASK_KEY, isVideoTaskRecord)
  const videoTask = ref<VideoTaskRecord | null>(legacyVideo.record)
  const videoTaskIssue = ref(legacyVideo.issue)
  const shotsDraft = ref<ShotsDraftPayload | null>(drafts.read(VIDEO_SHOTS_DRAFT_KEY, codec.shots))
  const legacyBatch = readTaskHistory(VIDEO_SHOTS_BATCH_KEY, isShotsBatchRecord)
  const shotsBatch = ref<ShotsBatchRecord | null>(legacyBatch.record)
  const shotsBatchIssue = ref(legacyBatch.issue)

  /** 草稿写入失败必须可感知（F1 验收）：返回 false 由调用方提示。 */
  function saveVideoDraft(draft: VideoDraftPayload): boolean {
    const saved = drafts.write(VIDEO_DRAFT_KEY, draft, codec.video)
    if (!saved) return false
    videoDraft.value = saved
    return true
  }

  function clearVideoTask(): void {
    videoTask.value = null
    removeKey(VIDEO_TASK_KEY)
  }

  function saveShotsDraft(draft: ShotsDraftPayload): boolean {
    const saved = drafts.write(VIDEO_SHOTS_DRAFT_KEY, draft, codec.shots)
    if (!saved) return false
    shotsDraft.value = saved
    return true
  }

  function clearShotsBatch(): void {
    shotsBatch.value = null
    removeKey(VIDEO_SHOTS_BATCH_KEY)
  }

  function reloadDamagedDrafts() {
    const keys = new Set(Object.keys(drafts.issues.value))
    if (keys.has(IMAGE_CTX_KEY)) pendingImageCtx.value = drafts.read(IMAGE_CTX_KEY, codec.context)
    if (keys.has(SHOTS_CTX_KEY)) pendingShotCtxs.value = drafts.read(SHOTS_CTX_KEY, codec.contexts) || []
    if (keys.has(SCENARIO_CTX_KEY)) pendingScenarioActs.value = drafts.read(SCENARIO_CTX_KEY, codec.acts) || []
    if (keys.has(VIDEO_DRAFT_KEY)) { videoDraft.value = drafts.read(VIDEO_DRAFT_KEY, codec.video); if (videoDraft.value) videoReloadVersion.value++ }
    if (keys.has(VIDEO_SHOTS_DRAFT_KEY)) { shotsDraft.value = drafts.read(VIDEO_SHOTS_DRAFT_KEY, codec.shots); if (shotsDraft.value) shotsReloadVersion.value++ }
  }
  return {
    draftIssue, videoReloadVersion, shotsReloadVersion, reloadDamagedDrafts, exportDamagedDrafts: drafts.exportOriginals, discardDamagedDrafts: drafts.discard,
    pendingImageCtx,
    pendingShotCtxs,
    stageImageCtx,
    consumeImageCtx,
    appendShotCtx,
    stageShotCtxs,
    pendingScenarioActs,
    stageScenarioActs,
    videoDraft,
    videoTask, videoTaskIssue,
    shotsDraft,
    shotsBatch, shotsBatchIssue,
    saveVideoDraft,
    clearVideoTask,
    saveShotsDraft,
    clearShotsBatch,
  }
})
