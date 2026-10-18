import { profileDraftStorage, flushProfileWrites } from '@/platform/web/profileStorage'
import { sameTempResultOwner, tempResultOwner, type TempResultOwner } from '@/utils/tempResult'
import type { AnimaSubmission } from '@/composables/generation/animaSessionContract'

/** A window's frozen image intent. Submitted means POST may have happened. */
export interface ImageRequestDraft {
  version: 1
  key: string
  transport: 'runtime' | 'direct'
  owner: TempResultOwner
  submission: AnimaSubmission
  submitted: boolean
  resultId?: string
  signature?: string
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
export function readImageRequestDraft(slot: string): ImageRequestDraft | null {
  const raw = profileDraftStorage.getItem(slot)
  if (!raw) return null
  const value: unknown = JSON.parse(raw)
  if (!record(value) || value.version !== 1 || typeof value.key !== 'string' || !/^[\w-]{1,160}$/.test(value.key)
    || !['runtime', 'direct'].includes(String(value.transport)) || typeof value.submitted !== 'boolean'
    || !record(value.owner) || !(value.owner.kind === 'web' && typeof value.owner.origin === 'string'
      || value.owner.kind === 'workspace' && typeof value.owner.workspaceId === 'string' && typeof value.owner.principalId === 'string')
    || !record(value.submission) || !['anima', 'krea2'].includes(String(value.submission.family))
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
  return { version: 1, key: crypto.randomUUID(), transport: runtime ? 'runtime' : 'direct', owner: tempResultOwner(),
    submission: JSON.parse(JSON.stringify(submission)) as AnimaSubmission, submitted: false }
}
export function assertImageRequestOwner(draft: ImageRequestDraft, runtime: boolean) {
  if (!sameTempResultOwner(draft.owner) || (draft.transport === 'runtime') !== runtime)
    throw new Error('原图片请求属于另一连接或工作区，请回到原连接核对；不会重新提交')
}
export async function writeImageRequestDraft(slot: string, draft: ImageRequestDraft) {
  if (!sameTempResultOwner(draft.owner)) throw new Error('图片请求所属资料来源已变化')
  profileDraftStorage.setItem(slot, JSON.stringify(draft))
  await flushProfileWrites()
  if (!sameTempResultOwner(draft.owner) || readImageRequestDraft(slot)?.key !== draft.key) throw new Error('图片请求保存尚未确认')
}
export async function clearImageRequestDraft(slot: string, draft: ImageRequestDraft) {
  if (!sameTempResultOwner(draft.owner) || readImageRequestDraft(slot)?.key !== draft.key) throw new Error('原图片请求身份已变化')
  profileDraftStorage.removeItem(slot)
  await flushProfileWrites()
  if (!sameTempResultOwner(draft.owner) || readImageRequestDraft(slot)) throw new Error('图片请求接管尚未确认')
}
