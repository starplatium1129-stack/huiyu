import type { StudioKeyframeOrigin } from '../../../types/studioProject'
import type { KeyframeModel } from '@/api/keyframeApi'

export const canvases = {
  landscape: { label: '横幅 · 768 × 512', width: 768, height: 512 },
  portrait: { label: '竖幅 · 512 × 768', width: 512, height: 768 },
  square: { label: '方形 · 768 × 768', width: 768, height: 768 },
  landscapeHd: { label: '横幅 · 1024 × 768', width: 1024, height: 768 },
  portraitHd: { label: '竖幅 · 768 × 1024', width: 768, height: 1024 },
  squareHd: { label: '方形 · 1024 × 1024', width: 1024, height: 1024 },
} as const
export const keyframeModelId = 'minimax-h3-image-q4'
export const candidateKinds = ['outfit', 'expression', 'pose', 'keyframe'] as const
export type CandidateKind = typeof candidateKinds[number]
const outputKinds = [...candidateKinds, 'character'] as const
export const guideModes = ['outfit', 'difference', 'scene', 'neutral'] as const
export type GuideMode = typeof guideModes[number]
export interface KeyframeGuideDraft {
  mode: GuideMode
  difference: 'expression' | 'pose'
  characterVersionId: string
  lookVersionId: string
  scene: string
  faceVersionId: string
  garmentVersionId: string
  outfitIds: string[]
  partIds: string[]
  differenceIds: string[]
  framingIds: string[]
}
export interface WorkbenchForm {
  title: string
  prompt: string
  variations: string
  modelId: string
  canvas: keyof typeof canvases
  kind: typeof outputKinds[number]
  count: number
  seedText: string
  references: string[]
  steps?: number
  keyframe?: StudioKeyframeOrigin
  variationTitles?: string[]
}
export interface Candidate {
  requestKey: string
  versionId: string
  seed: number
  state: 'ready' | 'sent' | 'done' | 'cancelled' | 'failed'
}
export interface CandidateBatch {
  form: WorkbenchForm
  jobs: Candidate[]
  paused: boolean
  preparation?: { form: WorkbenchForm; job: Candidate }
}
export interface KeyframeDraft {
  schema: 1
  form: WorkbenchForm
  guide: KeyframeGuideDraft
  batch: CandidateBatch | null
}
export function defaultForm(modelId = keyframeModelId): WorkbenchForm {
  return {
    title: '',
    prompt: '',
    variations: '',
    modelId,
    canvas: 'portraitHd',
    kind: 'outfit',
    count: 4,
    seedText: '',
    references: [],
  }
}
function defaultGuide(): KeyframeGuideDraft {
  return {
    mode: 'outfit',
    difference: 'expression',
    characterVersionId: '',
    lookVersionId: '',
    scene: '',
    faceVersionId: '',
    garmentVersionId: '',
    outfitIds: [],
    partIds: [],
    differenceIds: [],
    framingIds: [],
  }
}
export const newKeyframeDraft = (): KeyframeDraft => ({ schema: 1, form: defaultForm(), guide: defaultGuide(), batch: null })

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function stringList(value: unknown, max: number): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every(id => typeof id === 'string' && !!id)
}
function loadGuide(value: unknown): KeyframeGuideDraft {
  const guide = defaultGuide()
  if (value === undefined) return guide
  if (!record(value) || !guideModes.some(mode => mode === value.mode)
      || (value.difference !== 'expression' && value.difference !== 'pose'))
    throw new Error('点选草稿格式无法读取')
  guide.mode = value.mode as GuideMode
  guide.difference = value.difference
  for (const key of ['characterVersionId', 'lookVersionId', 'scene', 'faceVersionId', 'garmentVersionId'] as const) {
    const id = value[key]
    if (typeof id !== 'string') throw new Error('点选素材格式无效')
    guide[key] = id
  }
  for (const key of ['outfitIds', 'partIds', 'differenceIds', 'framingIds'] as const) {
    const ids = value[key]
    if (!stringList(ids, 4)) throw new Error('点选标签格式无效')
    guide[key] = [...new Set(ids)]
  }
  return guide
}
function loadForm(value: unknown): WorkbenchForm {
  if (
    !record(value) ||
    typeof value.title !== 'string' ||
    typeof value.prompt !== 'string' ||
    typeof value.modelId !== 'string' ||
    typeof value.canvas !== 'string' ||
    !Object.hasOwn(canvases, value.canvas) ||
    !outputKinds.some(kind => kind === value.kind) ||
    !Number.isInteger(value.count) ||
    Number(value.count) < 1 ||
    Number(value.count) > 4 ||
    typeof value.seedText !== 'string' ||
    !stringList(value.references, 4)
  )
    throw new Error('工坊草稿格式无法读取')
  if (value.variations !== undefined && typeof value.variations !== 'string') throw new Error('候选变化指令格式无效')
  const { keyframe, variationTitles, steps } = value
  if (keyframe !== undefined && (!record(keyframe) || typeof keyframe.characterVersionId !== 'string'
    || !keyframe.characterVersionId || (keyframe.neutralAnchor !== undefined && keyframe.neutralAnchor !== true)
    || (keyframe.sceneVersionId !== undefined && typeof keyframe.sceneVersionId !== 'string')))
    throw new Error('角色或场景来源格式无效')
  if (variationTitles !== undefined && !stringList(variationTitles, 4)) throw new Error('候选名称格式无效')
  if (steps !== undefined && (!Number.isSafeInteger(steps) || Number(steps) < 1 || Number(steps) > 100))
    throw new Error('候选步数格式无效')
  return {
    title: value.title,
    prompt: value.prompt,
    variations: value.variations ?? '',
    modelId: value.modelId,
    canvas: value.canvas as keyof typeof canvases,
    kind: value.kind as WorkbenchForm['kind'],
    count: Number(value.count),
    seedText: value.seedText,
    references: [...value.references],
    ...(keyframe ? { keyframe: keyframe as unknown as StudioKeyframeOrigin } : {}),
    ...(variationTitles ? { variationTitles: [...variationTitles] } : {}),
    ...(steps === undefined ? {} : { steps: Number(steps) }),
  }
}
function loadCandidate(value: unknown): Candidate {
  if (
    !record(value) ||
    typeof value.requestKey !== 'string' ||
    !value.requestKey ||
    typeof value.versionId !== 'string' ||
    !value.versionId ||
    !Number.isSafeInteger(value.seed) ||
    !['ready', 'sent', 'done', 'cancelled', 'failed'].includes(String(value.state))
  ) throw new Error('候选任务记录无法读取')
  return {
    requestKey: value.requestKey,
    versionId: value.versionId,
    seed: Number(value.seed),
    state: value.state as Candidate['state'],
  }
}
export function readKeyframeDraft(value: Record<string, unknown> | null): KeyframeDraft {
  if (!value) return newKeyframeDraft()
  if (value.schema !== 1) throw new Error('这份工坊草稿需要更新版本的绘遇才能打开')
  const form = loadForm(value.form)
  const guide = loadGuide(value.guide)
  if (value.batch === null) return { schema: 1, form, guide, batch: null }
  const raw = value.batch
  if (
    !record(raw) ||
    !Array.isArray(raw.jobs) ||
    typeof raw.paused !== 'boolean' ||
    raw.jobs.length < 1 ||
    raw.jobs.length > 4
  )
    throw new Error('批量任务记录无法读取')
  const batch: CandidateBatch = { form: loadForm(raw.form), jobs: raw.jobs.map(loadCandidate), paused: raw.paused }
  if (raw.preparation !== undefined) {
    if (!record(raw.preparation)) throw new Error('立绘准备记录无法读取')
    const preparation = { form: loadForm(raw.preparation.form), job: loadCandidate(raw.preparation.job) }
    if (preparation.form.kind !== 'character' || preparation.form.keyframe?.neutralAnchor !== true
        || batch.form.references[0] !== preparation.job.versionId)
      throw new Error('立绘准备与候选图不匹配')
    batch.preparation = preparation
  }
  return { schema: 1, form, guide, batch }
}
export function batchJobs(batch: CandidateBatch | null): Candidate[] {
  return batch ? (batch.preparation ? [batch.preparation.job, ...batch.jobs] : batch.jobs) : []
}
export const pendingCandidate = (job: Candidate) => job.state === 'ready' || job.state === 'sent'
export function canvasSupported(model: KeyframeModel, canvas: keyof typeof canvases) {
  const { width, height } = canvases[canvas]
  return [width, height].every(value =>
    value >= model.minSize && value <= model.maxSize && value % model.alignment === 0)
}
export function editableSeed(seedText: string, count: number): number | undefined {
  if (!seedText.trim()) return undefined
  const seed = Number(seedText)
  if (!/^\d+$/.test(seedText.trim()) || !Number.isSafeInteger(seed) || seed < 0 || seed + count - 1 > 0x7fffffff)
    throw new Error('种子须为 0 到 2147483647 之间的整数，并给每张候选留一个递增值')
  return seed
}
export function variationLines(form: WorkbenchForm) {
  return form.variations
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}
export function candidatePrompt(form: WorkbenchForm, index: number) {
  return [form.prompt.trim(), variationLines(form)[index]].filter(Boolean).join('\n')
}
export const cloneData = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
