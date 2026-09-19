import type { AnimaPhase, AnimaJobMetadata } from './generation'
export type { AnimaPhase, AnimaJobMetadata } from './generation'

import type { SDErrorReport } from '@/utils/sdError'

export interface AnimaOption {
  id: string
  label?: string
  name?: string
  character?: string
  preview?: boolean
  validation?: string
  available?: boolean
  family?: 'anima' | 'krea2'
  profileId?: string
  defaults?: Record<string, unknown>
  capabilities?: { negative: boolean; lora: boolean; noLora?: boolean; characterIdentity: boolean; experimental: boolean }
  sizes?: string[]
}

export interface KreaStyleLoraOption {
  id: string
  trigger: string
  recommendedStrength: number
  available: boolean
}

export interface AnimaResult {
  url: string
  blob: Blob
  metadata: AnimaJobMetadata
}

/**
 * 出图提交时冻结的创作上下文（2026-09-06 体验报告 F3）。
 *
 * 结果在画布停留期间用户可能继续改表单（换角色/蓝图/故事）；跨页交接
 * （出视频/加入分镜）与历史入册必须跟随「这张图是谁」，而非当前表单。
 */
export interface AnimaResultContext {
  history?: import('vue').DeepReadonly<Partial<import('@/stores/promptBuilderStore').HistoryEntry>>
  /** 热门角色 id；工作室角色为空串。 */
  characterId?: string
  /** 服装形态 id；无/不适用为 null。 */
  outfitId?: string | null
  blueprintId?: string | null
  sceneId?: string | null
  story?: string
  /** 工作室角色（nene/natsume/triad）；恢复临时成片时据此还原引擎守卫前置。 */
  char?: string
}

export interface AnimaGenerationState {
  phase: AnimaPhase
  backendStatus?: string
  /** ComfyUI 当前只通过轮询提供阶段；未知采样步数时保持 null，禁止伪造百分比。 */
  progress: number | null
  elapsedSeconds: number
  progressText: string
  currentNode: string | null
  online: boolean
  checkMsg: string
  models: AnimaOption[]
  loras: AnimaOption[]
  styleLoras: KreaStyleLoraOption[]
  styleLoraId: string
  prompt: string
  negative: string
  modelId: string
  loraId: string
  loraStrength: number
  family: 'anima' | 'krea2'
  width: number
  height: number
  steps: number
  cfg: number
  sampler: string
  scheduler: string
  seed: number | null
  hiresFix?: boolean
  hiresScale?: number
  hiresDenoise?: number
  teaCache?: boolean
  teaCacheThresh?: number
  job: AnimaJobMetadata | null
  result: AnimaResult | null
  /** 当前结果对应的提交时冻结上下文（F3）；无结果/旧数据为 null。 */
  resultContext?: AnimaResultContext | null
  statusText: string
  errorMsg: string
  /**
   * 失败时的分类报告（2026-08-30 UX 审计）。Anima / Krea 2 此前直出 ComfyUI
   * 的英文技术串，用户既看不懂也没有重试入口；现在与 SD 路径共用同一套分类
   * 器，标题与建议给中文，原始串折进 details。成功与取消时置空。
   */
  errorReport: SDErrorReport | null
}
