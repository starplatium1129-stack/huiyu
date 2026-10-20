import { apiClient, ApiClientError } from './client'
import type { VideoDefaults, VideoShotSize } from './videoApi'
import { isVideoShotSize, isVideoCamera, isVideoMotion, isVideoDuration } from './videoApiResponse'

export interface VideoAiStatusResponse {
  ok: true
  available: boolean
  source: 'api' | 'ollama' | null
  model: string
  label: string
  reason?: string
}

export interface VideoAiRewriteInput {
  /** 角色锚点（仅作身份参考，LLM 不在描述里重复它）。 */
  identity?: string
  prompt: string
  shotSize?: VideoShotSize | null
  camera?: VideoDefaults['camera']
  motion?: VideoDefaults['motion']
  dialogue?: string
}

export interface VideoAiRewriteResponse {
  ok: true
  source: 'api' | 'ollama'
  model: string
  shot: {
    prompt: string
    shotSize: VideoShotSize | null
    camera: VideoDefaults['camera']
    motion: VideoDefaults['motion']
    dialogue: string
  }
}

export interface VideoAiPolishShotInput {
  prompt: string
  shotSize?: VideoShotSize | null
  camera?: VideoDefaults['camera']
  motion?: VideoDefaults['motion']
  dialogue?: string
}

export interface VideoAiPolishInput {
  identity?: string
  shots: VideoAiPolishShotInput[]
}

export interface VideoAiPolishShot {
  /** null = 保持当前值（AI 认为不需要动）。 */
  shotSize: VideoShotSize | null
  camera: VideoDefaults['camera'] | null
  motion: VideoDefaults['motion'] | null
  dialogue: string | null
}

export interface VideoAiPolishResponse {
  ok: true
  source: 'api' | 'ollama'
  model: string
  shots: VideoAiPolishShot[]
}

export interface VideoAiDialogueInput {
  identity?: string
  prompt: string
  currentDialogue?: string
  mood?: string
}

export interface VideoAiDialogueOption {
  text: string
  label: string
}

export interface VideoAiDialogueResponse {
  ok: true
  source: 'api' | 'ollama'
  model: string
  options: VideoAiDialogueOption[]
}

export interface VideoAiReviewShotInput {
  prompt: string
  shotSize?: VideoShotSize | null
  camera?: VideoDefaults['camera']
  motion?: VideoDefaults['motion']
  dialogue?: string
}

export interface VideoAiIssue {
  index: number
  severity: 'error' | 'warn'
  field: 'prompt' | 'shotSize' | 'camera' | 'motion' | 'dialogue' | 'continuity'
  message: string
  suggestion: string
}

export interface VideoAiReviewResponse {
  ok: true
  source: 'api' | 'ollama'
  model: string
  issues: VideoAiIssue[]
}

export interface VideoAiScriptInput {
  identity?: string
  story: string
  shotCount?: number
  totalSeconds?: number
  characterLabels?: string[]
}

export interface VideoAiScriptShot {
  prompt: string
  shotSize: VideoShotSize | null
  camera: VideoDefaults['camera']
  motion: VideoDefaults['motion']
  dialogue: string
  duration: VideoDefaults['duration']
}

export interface VideoAiScriptResponse {
  ok: true
  source: 'api' | 'ollama'
  model: string
  shots: VideoAiScriptShot[]
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string'
function invalid(detail: string): never {
  throw new ApiClientError(`AI 分镜响应无效：${detail}，原镜头已保留。`, { kind: 'invalid-response' })
}
function responseHeader(value: Record<string, unknown>): Pick<VideoAiRewriteResponse, 'ok' | 'source' | 'model'> {
  if (value.ok !== true || (value.source !== 'api' && value.source !== 'ollama') || !text(value.model)) invalid('来源信息不完整')
  return { ok: true, source: value.source, model: value.model }
}
function responseList(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) invalid(`${field}不是列表`)
  return value
}
function readShot(value: unknown): VideoAiRewriteResponse['shot'] {
  if (!record(value) || !text(value.prompt) || value.prompt.length > 4000
    || !(value.shotSize === null || isVideoShotSize(value.shotSize))
    || !isVideoCamera(value.camera) || !isVideoMotion(value.motion)
    || !text(value.dialogue) || value.dialogue.length > 300) invalid('镜头字段不完整或超出范围')
  return { prompt: value.prompt, shotSize: value.shotSize, camera: value.camera, motion: value.motion, dialogue: value.dialogue }
}
function readPolishShot(value: unknown): VideoAiPolishShot {
  if (!record(value) || !(value.shotSize === null || isVideoShotSize(value.shotSize))
    || !(value.camera === null || isVideoCamera(value.camera))
    || !(value.motion === null || isVideoMotion(value.motion))
    || !(value.dialogue === null || text(value.dialogue) && value.dialogue.length <= 300)) invalid('编排建议字段不完整或超出范围')
  // null keeps the original field; an empty dialogue deliberately clears it.
  return { shotSize: value.shotSize, camera: value.camera, motion: value.motion, dialogue: value.dialogue }
}
function readDialogueOption(value: unknown): VideoAiDialogueOption {
  if (!record(value) || !text(value.text) || !value.text.trim() || value.text.length > 60
    || !text(value.label) || value.label.length > 12) invalid('台词选项字段无效')
  return { text: value.text, label: value.label }
}
function readIssue(value: unknown, shotCount: number): VideoAiIssue {
  if (!record(value) || typeof value.index !== 'number' || !Number.isSafeInteger(value.index) || value.index < 0 || value.index >= shotCount
    || (value.severity !== 'error' && value.severity !== 'warn')
    || (value.field !== 'prompt' && value.field !== 'shotSize' && value.field !== 'camera'
      && value.field !== 'motion' && value.field !== 'dialogue' && value.field !== 'continuity')
    || !text(value.message) || !value.message.trim() || value.message.length > 120
    || !text(value.suggestion) || value.suggestion.length > 120) invalid('质量建议字段或镜头编号无效')
  return { index: value.index, severity: value.severity, field: value.field, message: value.message, suggestion: value.suggestion }
}
function readScriptShot(value: unknown): VideoAiScriptShot {
  const shot = readShot(value)
  if (!shot.prompt.trim() || !record(value) || !isVideoDuration(value.duration)) invalid('脚本镜头描述或时长无效')
  return { ...shot, duration: value.duration }
}

export async function fetchVideoAiStatus(signal?: AbortSignal): Promise<VideoAiStatusResponse> {
  const value = await apiClient.request<Record<string, unknown>>('/api/video-ai/status', { cache: 'no-store', signal, timeoutMs: 8_000 })
  if (value.ok !== true || typeof value.available !== 'boolean'
    || !(value.source === null || value.source === 'api' || value.source === 'ollama')
    || (value.available && value.source === null) || !text(value.model) || !text(value.label)
    || (value.reason !== undefined && !text(value.reason))) invalid('AI 状态字段无效')
  return { ok: true, available: value.available, source: value.source, model: value.model, label: value.label,
    ...(value.reason === undefined ? {} : { reason: value.reason }) }
}

export async function rewriteVideoShot(input: VideoAiRewriteInput, signal?: AbortSignal): Promise<VideoAiRewriteResponse> {
  const value = await apiClient.request<Record<string, unknown>>('/api/video-ai/rewrite', { method: 'POST', body: input, signal, timeoutMs: 150_000 })
  return { ...responseHeader(value), shot: readShot(value.shot) }
}

export async function polishVideoShots(input: VideoAiPolishInput, signal?: AbortSignal): Promise<VideoAiPolishResponse> {
  const shotCount = input.shots.length
  const value = await apiClient.request<Record<string, unknown>>('/api/video-ai/polish', { method: 'POST', body: input, signal, timeoutMs: 150_000 })
  const header = responseHeader(value), suggestions = responseList(value.shots, '编排建议')
  if (suggestions.length > shotCount) invalid('编排建议超出原镜头数量')
  return { ...header, shots: suggestions.map(readPolishShot) }
}

export async function suggestDialogue(input: VideoAiDialogueInput, signal?: AbortSignal): Promise<VideoAiDialogueResponse> {
  const value = await apiClient.request<Record<string, unknown>>('/api/video-ai/dialogue', { method: 'POST', body: input, signal, timeoutMs: 150_000 })
  return { ...responseHeader(value), options: responseList(value.options, '台词选项').map(readDialogueOption) }
}

export async function reviewVideoShots(shots: VideoAiReviewShotInput[], signal?: AbortSignal): Promise<VideoAiReviewResponse> {
  const shotCount = shots.length
  const value = await apiClient.request<Record<string, unknown>>('/api/video-ai/review', { method: 'POST', body: { shots }, signal, timeoutMs: 150_000 })
  return { ...responseHeader(value), issues: responseList(value.issues, '质量建议').map(issue => readIssue(issue, shotCount)) }
}

export async function generateVideoScript(input: VideoAiScriptInput, signal?: AbortSignal): Promise<VideoAiScriptResponse> {
  const value = await apiClient.request<Record<string, unknown>>('/api/video-ai/script', { method: 'POST', body: input, signal, timeoutMs: 180_000 })
  return { ...responseHeader(value), shots: responseList(value.shots, '脚本镜头').map(readScriptShot) }
}
