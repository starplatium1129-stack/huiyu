import { newRequestDraft, readRequestDraft, type RequestDraft } from './requestDraft'
import type { AnimaSubmission } from '@/composables/generation/animaSessionContract'

/** A window's frozen image intent. Submitted means POST may have happened. */
export interface ImageRequestDraft extends RequestDraft {
  submission: AnimaSubmission
  resultId?: string
  signature?: string
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
export function readImageRequestDraft(slot: string): ImageRequestDraft | null {
  const value = readRequestDraft(slot)
  if (!value) return null
  if (!record(value.submission) || !['anima', 'krea2'].includes(String(value.submission.family))
    || !record(value.submission.request) || !(value.submission.context === null || record(value.submission.context))
    || value.resultId !== undefined && typeof value.resultId !== 'string'
    || value.signature !== undefined && typeof value.signature !== 'string') throw new Error('原图片请求身份无法读取，已保留记录，请先核对原任务')
  const request = value.submission.request
  if (!['prompt', 'negative', 'profileId', 'modelId'].every(key => typeof request[key] === 'string')
    || !['width', 'height', 'steps', 'cfg'].every(key => typeof request[key] === 'number' && Number.isFinite(request[key]))
    || !(request.character === null || typeof request.character === 'string')
    || !(request.loraId === null || typeof request.loraId === 'string')
    || !(request.loraStrength === null || typeof request.loraStrength === 'number' && Number.isFinite(request.loraStrength)))
    throw new Error('原图片参数无法读取，已保留请求身份，不会重新提交')
  return value as unknown as ImageRequestDraft
}
export function newImageRequestDraft(submission: AnimaSubmission, runtime: boolean): ImageRequestDraft {
  return { ...newRequestDraft(runtime), submission: JSON.parse(JSON.stringify(submission)) as AnimaSubmission }
}
