import { apiClient } from './client'
import { hasRuntimeTasks } from './runtimeTaskAuthority'
import { desktopRuntimeFetch, desktopRuntimeIdentity, getDesktopRuntime } from '@/platform/desktop/runtime'
import { trackMaintenanceWrite } from '@/platform/maintenanceParticipants'

export const videoModes = { 'first-last': '首尾帧', first: '仅首帧', dialogue: '角色对白' } as const
export const videoCameras = { fixed: '固定', push: '推近', pull: '拉远', pan: '摇镜', track: '移动' } as const
export const videoMotions = { low: '轻微', medium: '适中', high: '明显' } as const
export const videoQualities = { fast: '快速', standard: '标准', quality: '画质优先' } as const
export const runStatuses = {
  queued: '排队中',
  running: '生成中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
} as const
export interface StudioFramePlan {
  modelId: 'flux-kontext-dev' | 'minimax-h3-image-q4'
  referenceVersionIds: string[]
  canvas?: 'landscape' | 'portrait' | 'square'
  firstPrompt?: string
  lastPrompt?: string
}
export interface StudioVideoSettings {
  mode: keyof typeof videoModes
  camera: keyof typeof videoCameras
  motion: keyof typeof videoMotions
  quality: keyof typeof videoQualities
  resolution: 480 | 720
  seconds: 2 | 3 | 5
  seed: number | null
  prompt?: string
}
export interface StudioVideoInput extends StudioVideoSettings {
  shotId: string
  expectedRevision: number
  templateId?: string
  framePlan?: StudioFramePlan
}
export interface StudioVideoBatch {
  id: string
  shots: StudioVideoInput[]
}
export interface StudioVideoTemplate {
  id: string
  version: number
  label: string
  mode: StudioVideoSettings['mode']
  steps?: Record<StudioVideoSettings['quality'], 1 | 4 | 8>
}
export interface StudioVideoRun {
  id: string
  batchId: string
  projectId: string
  shotId: string
  shotTitle: string
  shotRevision?: number
  templateId: string
  templateVersion: number
  settings: StudioVideoSettings
  firstVersionId: string | null
  lastVersionId: string | null
  audioVersionId?: string | null
  status: keyof typeof runStatuses
  taskId: string | null
  clipVersionId: string | null
  createdAt: number
  error?: string | null
  cancelRequested?: boolean
  statusLabel?: string
  preparation?: {
    state?: string
    modelId?: string
    referenceVersionIds?: string[]
    tasks?: { slot: 'first' | 'last'; status: keyof typeof runStatuses; prompt?: string; error?: string }[]
  } | null
  liveProgress?: {
    value?: number | null
    message?: string | null
    previewUrl?: string | null
    previewDataUrl?: string | null
  } | null
  gpuRetry?: { attempt: number; reason: string; width: number; height: number; cause?: string | null } | null
}
export interface StudioExportOptions {
  upscale: boolean
  interpolate: boolean
  useShotAudio: boolean
}
export interface StudioExportInput {
  id: string
  shots: Array<{ shotId: string; expectedRevision: number; clipVersionId: string }>
  options: StudioExportOptions
}
export interface StudioExportRecord {
  id: string
  projectId: string
  status: StudioVideoRun['status']
  progress: number | null
  message: string
  clipVersionId: string | null
  error?: string | null
  cancelRequested?: boolean
  createdAt: number
  shots: Array<{ shotId: string; shotTitle?: string; clipVersionId: string; audioVersionId?: string | null }>
  options: StudioExportOptions
}
export interface StudioVideoBoard {
  templates: StudioVideoTemplate[]
  runs: StudioVideoRun[]
  unavailable?: string
  modelIssues?: Partial<Record<StudioVideoSettings['mode'], string>>
  templateWarnings?: string[]
  exports?: StudioExportRecord[]
}
export interface GpuQueue {
  paused: boolean
  waiting: number
  activeModel: string | null
  residentModel: string | null
  blocked: boolean
  concurrency: 1
}
export interface StudioVideoPort {
  kind: 'desktop' | 'browser'
  journalKey: string
  list(signal: AbortSignal): Promise<StudioVideoBoard>
  submit(batch: StudioVideoBatch, signal: AbortSignal): Promise<StudioVideoBoard>
  cancel(id: string, signal: AbortSignal): Promise<StudioVideoBoard>
  selectCurrent(
    shotId: string,
    runId: string,
    expectedRevision: number,
    signal: AbortSignal
  ): Promise<StudioVideoBoard>
  submitExport?(input: StudioExportInput, signal: AbortSignal): Promise<StudioVideoBoard>
  cancelExport?(id: string, signal: AbortSignal): Promise<StudioVideoBoard>
  queue(signal: AbortSignal, paused?: boolean): Promise<GpuQueue>
  preview(run: StudioVideoRun, signal: AbortSignal): Promise<Blob>
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
const text = (value: unknown): value is string => typeof value === 'string' && !!value
const nullableId = (value: unknown) => value === null || text(value)
const integer = (value: unknown, min: number) => Number.isSafeInteger(value) && Number(value) >= min
const member = (items: object, value: unknown) => typeof value === 'string' && Object.hasOwn(items, value)
const nullableString = (value: unknown) => value == null || typeof value === 'string'
const optionalPrompt = (value: unknown) =>
  value === undefined || (typeof value === 'string' && value.length <= 4000)
export function validVideoSettings(value: unknown): value is StudioVideoSettings {
  return (
    object(value) &&
    member(videoModes, value.mode) &&
    member(videoCameras, value.camera) &&
    member(videoMotions, value.motion) &&
    member(videoQualities, value.quality) &&
    (value.resolution === 480 || value.resolution === 720) &&
    (value.seconds === 2 || value.seconds === 3 || value.seconds === 5) &&
    (value.seed === null || (integer(value.seed, 0) && Number(value.seed) <= 2_147_483_647)) &&
    (value.prompt === undefined || typeof value.prompt === 'string')
  )
}
function validFramePlan(plan: unknown) {
  if (!object(plan) || !['flux-kontext-dev', 'minimax-h3-image-q4'].includes(String(plan.modelId))) return false
  const ids = plan.referenceVersionIds
  return (
    Array.isArray(ids) &&
    ids.length >= 1 &&
    ids.length <= 4 &&
    ids.every(text) &&
    new Set(ids).size === ids.length &&
    (plan.canvas === undefined || ['landscape', 'portrait', 'square'].includes(String(plan.canvas))) &&
    optionalPrompt(plan.firstPrompt) &&
    optionalPrompt(plan.lastPrompt)
  )
}
function validShot(shot: unknown) {
  return (
    object(shot) &&
    text(shot.shotId) &&
    integer(shot.expectedRevision, 1) &&
    validVideoSettings(shot) &&
    (shot.templateId === undefined || text(shot.templateId)) &&
    (shot.framePlan === undefined || validFramePlan(shot.framePlan))
  )
}
export function validVideoBatch(value: unknown): value is StudioVideoBatch {
  return (
    object(value) &&
    text(value.id) &&
    /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.id) &&
    Array.isArray(value.shots) &&
    value.shots.length > 0 &&
    value.shots.length <= 64 &&
    value.shots.every(validShot)
  )
}
function validProgress(progress: unknown) {
  if (progress == null) return true
  if (!object(progress)) return false
  const value = progress.value
  return (
    (value == null || (typeof value === 'number' && value >= 0 && value <= 1)) &&
    nullableString(progress.message) &&
    nullableString(progress.previewUrl) &&
    nullableString(progress.previewDataUrl)
  )
}
function validPreparation(prep: unknown) {
  if (prep == null) return true
  return (
    object(prep) &&
    nullableString(prep.state) &&
    nullableString(prep.modelId) &&
    (prep.referenceVersionIds === undefined ||
      (Array.isArray(prep.referenceVersionIds) && prep.referenceVersionIds.every(text))) &&
    (prep.tasks === undefined ||
      (Array.isArray(prep.tasks) &&
        prep.tasks.every(
          (task) =>
            object(task) &&
            (task.slot === 'first' || task.slot === 'last') &&
            member(runStatuses, task.status) &&
            nullableString(task.prompt) &&
            nullableString(task.error)
        )))
  )
}
function validRetry(retry: unknown) {
  return (
    retry == null ||
    (object(retry) &&
      integer(retry.attempt, 1) &&
      text(retry.reason) &&
      nullableString(retry.cause) &&
      integer(retry.width, 1) &&
      integer(retry.height, 1))
  )
}
function validRun(run: unknown, projectId: string) {
  return (
    object(run) &&
    run.projectId === projectId &&
    text(run.id) &&
    text(run.batchId) &&
    text(run.shotId) &&
    text(run.shotTitle) &&
    text(run.templateId) &&
    integer(run.templateVersion, 1) &&
    validVideoSettings(run.settings) &&
    nullableId(run.firstVersionId) &&
    nullableId(run.lastVersionId) &&
    (run.shotRevision === undefined || integer(run.shotRevision, 1)) &&
    (run.audioVersionId === undefined || nullableId(run.audioVersionId)) &&
    member(runStatuses, run.status) &&
    integer(run.createdAt, 0) &&
    Number(run.createdAt) <= 8.64e15 &&
    nullableId(run.taskId) &&
    nullableId(run.clipVersionId) &&
    nullableString(run.error) &&
    nullableString(run.statusLabel) &&
    (run.cancelRequested == null || typeof run.cancelRequested === 'boolean') &&
    validProgress(run.liveProgress) &&
    validPreparation(run.preparation) &&
    validRetry(run.gpuRetry)
  )
}
function validExportOptions(options: unknown) {
  return (
    object(options) &&
    typeof options.upscale === 'boolean' &&
    typeof options.interpolate === 'boolean' &&
    typeof options.useShotAudio === 'boolean'
  )
}
function validExportShots(shots: unknown, input: boolean) {
  if (!Array.isArray(shots) || !shots.length || shots.length > 64) return false
  return (
    shots.every(
      (shot) =>
        object(shot) &&
        text(shot.shotId) &&
        text(shot.clipVersionId) &&
        (input
          ? integer(shot.expectedRevision, 1)
          : (shot.shotTitle === undefined || text(shot.shotTitle)) &&
            (shot.audioVersionId === undefined || nullableId(shot.audioVersionId)))
    ) && new Set(shots.map((shot) => shot.shotId)).size === shots.length
  )
}
export function validStudioExportInput(value: unknown): value is StudioExportInput {
  return (
    object(value) &&
    text(value.id) &&
    /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.id) &&
    validExportOptions(value.options) &&
    validExportShots(value.shots, true)
  )
}
function validExportRecord(item: unknown, projectId: string) {
  return (
    object(item) &&
    item.projectId === projectId &&
    text(item.id) &&
    member(runStatuses, item.status) &&
    (item.progress === null || (typeof item.progress === 'number' && item.progress >= 0 && item.progress <= 1)) &&
    typeof item.message === 'string' &&
    nullableId(item.clipVersionId) &&
    nullableString(item.error) &&
    (item.cancelRequested == null || typeof item.cancelRequested === 'boolean') &&
    integer(item.createdAt, 0) &&
    Number(item.createdAt) <= 8.64e15 &&
    validExportOptions(item.options) &&
    validExportShots(item.shots, false)
  )
}
export function decodeStudioVideoBoard(value: unknown, projectId: string): StudioVideoBoard {
  if (
    !object(value) ||
    !Array.isArray(value.templates) ||
    !Array.isArray(value.runs) ||
    (value.exports !== undefined &&
      !(Array.isArray(value.exports) && value.exports.every((item) => validExportRecord(item, projectId)))) ||
    (value.templateWarnings !== undefined &&
      !(Array.isArray(value.templateWarnings) && value.templateWarnings.every(text))) ||
    !value.templates.every(
      (t) =>
        object(t) &&
        text(t.id) &&
        integer(t.version, 1) &&
        text(t.label) &&
        member(videoModes, t.mode) &&
        (t.steps === undefined ||
          (object(t.steps) &&
            [t.steps.fast, t.steps.standard, t.steps.quality].every((n) =>
              t.mode === 'dialogue' ? n === 1 : n === 4 || n === 8
            )))
    ) ||
    !value.runs.every((run) => validRun(run, projectId))
  )
    throw new Error('分镜视频记录与当前项目不符，请重新读取。')
  return value as unknown as StudioVideoBoard
}

export async function gpuQueue(signal: AbortSignal, paused?: boolean): Promise<GpuQueue> {
  const value = await apiClient.request<GpuQueue & { ok: true }>('/api/generation/gpu-queue', {
    method: paused === undefined ? 'GET' : 'PUT',
    body: paused === undefined ? undefined : { paused },
    signal,
    cache: 'no-store',
    cachePolicy: 'bypass',
    timeoutMs: 15_000,
  })
  if (
    value.ok !== true ||
    value.concurrency !== 1 ||
    typeof value.paused !== 'boolean' ||
    !integer(value.waiting, 0) ||
    !nullableId(value.activeModel) ||
    !nullableId(value.residentModel) ||
    typeof value.blocked !== 'boolean'
  )
    throw new Error('本机 GPU 队列状态无效。')
  return value
}
export function captureStudioVideoApi(projectId: string): StudioVideoPort | null {
  const state = getDesktopRuntime(),
    workspace = state.bootstrap?.runtime?.workspace
  if (!hasRuntimeTasks() || !workspace || state.connection !== 'ready') return null
  const identity = desktopRuntimeIdentity()
  const projectPath = '/api/tasks/v1/studio-video/projects/' + encodeURIComponent(projectId)
  const runPath = (id: string) => projectPath + '/runs/' + encodeURIComponent(id)
  function current(signal: AbortSignal) {
    signal.throwIfAborted()
    if (getDesktopRuntime().connection !== 'ready' || desktopRuntimeIdentity() !== identity)
      throw new Error('工作区连接已变化，请重新打开原项目。')
  }
  async function projectRequest(path: string, signal: AbortSignal, method = 'GET', body?: unknown) {
    current(signal)
    const response = await apiClient.request<{ ok: true; runtimeEpoch: string; result: unknown }>(path, {
      method,
      body,
      signal,
      cache: 'no-store',
      cachePolicy: 'bypass',
      timeoutMs: 45_000,
    })
    current(signal)
    if (response.ok !== true || response.runtimeEpoch !== workspace!.runtimeEpoch)
      throw new Error('分镜视频来自另一运行时，请重新打开项目。')
    return decodeStudioVideoBoard(response.result, projectId)
  }
  async function queue(signal: AbortSignal, paused?: boolean) {
    current(signal)
    const value = await gpuQueue(signal, paused)
    current(signal)
    return value
  }
  async function preview(run: StudioVideoRun, signal: AbortSignal) {
    current(signal)
    const path = runPath(run.id) + '/preview'
    if (run.projectId !== projectId || run.liveProgress?.previewUrl?.split('?')[0] !== path)
      throw new Error('预览地址与当前镜头不符。')
    const response = await desktopRuntimeFetch(run.liveProgress.previewUrl, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      cache: 'no-store',
      redirect: 'error',
    })
    if (!response.ok) throw new Error('中间帧暂未就绪。')
    const blob = await response.blob()
    current(signal)
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(blob.type) || !blob.size)
      throw new Error('中间帧格式无效。')
    return blob
  }
  return {
    kind: 'desktop',
    journalKey: `aics-model-draft-studio-video-${workspace.workspaceId}-${workspace.principalId}-${state.bootstrap?.windowId}-${projectId}`,
    list: (signal: AbortSignal) => projectRequest(projectPath, signal),
    submit: (batch: StudioVideoBatch, signal: AbortSignal) =>
      trackMaintenanceWrite(() =>
        projectRequest(projectPath + '/batches/' + encodeURIComponent(batch.id), signal, 'POST', {
          shots: batch.shots,
        })
      ),
    cancel: (id: string, signal: AbortSignal) => projectRequest(runPath(id) + '/cancel', signal, 'POST', {}),
    selectCurrent: (shotId, runId, expectedRevision, signal) =>
      trackMaintenanceWrite(() =>
        projectRequest(projectPath + '/shots/' + encodeURIComponent(shotId) + '/current', signal, 'POST', {
          runId,
          expectedRevision,
        })
      ),
    submitExport: (input, signal) =>
      trackMaintenanceWrite(() =>
        projectRequest(projectPath + '/exports/' + encodeURIComponent(input.id), signal, 'POST', {
          shots: input.shots,
          options: input.options,
        })
      ),
    cancelExport: (id, signal) =>
      projectRequest(projectPath + '/exports/' + encodeURIComponent(id) + '/cancel', signal, 'POST', {}),
    queue,
    preview,
  }
}
