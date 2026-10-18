import { profileDraftStorage, flushProfileWrites } from '@/platform/web/profileStorage'
import { sameTempResultOwner, tempResultOwner, type TempResultOwner } from '@/utils/tempResult'

/** Window-owned acceptance identity; submitted means execution may have been admitted. */
export interface RequestDraft {
  version: 1
  key: string
  transport: 'runtime' | 'direct'
  owner: TempResultOwner
  submitted: boolean
}
export function readRequestDraft(slot: string): (RequestDraft & Record<string, unknown>) | null {
  const raw = profileDraftStorage.getItem(slot)
  if (!raw) return null
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('原请求记录无效，已保留记录')
  const draft = value as Record<string, unknown>, owner = draft.owner as Partial<TempResultOwner> | undefined
  if (draft.version !== 1 || typeof draft.key !== 'string' || !/^[\w-]{1,160}$/.test(draft.key)
    || !['runtime', 'direct'].includes(String(draft.transport)) || typeof draft.submitted !== 'boolean'
    || !owner || !(owner.kind === 'web' && typeof owner.origin === 'string'
      || owner.kind === 'workspace' && typeof owner.workspaceId === 'string' && typeof owner.principalId === 'string'))
    throw new Error('原请求身份无法读取，已保留记录，请先核对原任务')
  return draft as RequestDraft & Record<string, unknown>
}
export function newRequestDraft(runtime: boolean): RequestDraft {
  return { version: 1, key: crypto.randomUUID(), transport: runtime ? 'runtime' : 'direct', owner: tempResultOwner(), submitted: false }
}
export function assertRequestOwner(draft: RequestDraft, runtime: boolean) {
  if (!sameTempResultOwner(draft.owner) || (draft.transport === 'runtime') !== runtime)
    throw new Error('原请求属于另一连接或工作区，请回到原连接核对；不会重新提交')
}
export async function writeRequestDraft(slot: string, draft: RequestDraft) {
  if (!sameTempResultOwner(draft.owner)) throw new Error('请求所属资料来源已变化')
  profileDraftStorage.setItem(slot, JSON.stringify(draft))
  await flushProfileWrites()
  if (!sameTempResultOwner(draft.owner) || readRequestDraft(slot)?.key !== draft.key) throw new Error('原请求保存尚未确认')
}
export async function clearRequestDraft(slot: string, draft: RequestDraft) {
  if (!sameTempResultOwner(draft.owner) || readRequestDraft(slot)?.key !== draft.key) throw new Error('原请求身份已变化')
  profileDraftStorage.removeItem(slot)
  await flushProfileWrites()
  if (!sameTempResultOwner(draft.owner) || readRequestDraft(slot)) throw new Error('原请求接管尚未确认')
}
