import type { ProfileDomain, ProfileRecord, ProfileSnapshot } from '../../../types/profile'
import type { ProfilePort } from './profileStorage'
import { CHAT_DRAFT_PREFIX, SD_PENDING_QUEUE_KEY } from '../../utils/storageKeys'

export interface ProfileWriteOperation {
  domain: ProfileDomain
  key: string
  session: boolean
  operationId: string
  expectedRevision?: number | null
  expectedReset: string
  baseValue: unknown
  sendValue: unknown
  changedCharacters?: readonly string[]
  previous?: ProfileRecord
  queuedPredecessor: boolean
  mergedSetting: boolean
}
interface Access {
  port: ProfilePort
  windowId: string
  check(): void
  revision(): number | null
  saved(record: ProfileRecord): void
  recovered(snapshot: ProfileSnapshot): void
}
/** Keep the submitted identity and input through unknown network outcomes;
 * only a definite conflict admits a new identity and a rebased input. */
export async function runProfileWrite(write: ProfileWriteOperation, access: Access): Promise<'confirmed' | 'recovered'> {
  access.check()
  const { domain, key, previous } = write
  if (write.expectedRevision === undefined) {
    if (domain === 'chat' && write.queuedPredecessor && previous) {
      const { mergeProfileChatConflict } = await import('./profileConflict')
      write.sendValue = await mergeProfileChatConflict(key, write.baseValue, write.sendValue, previous.value)
      write.baseValue = structuredClone(previous.value)
      write.changedCharacters = undefined
    } else if (write.mergedSetting && previous) {
      const { mergeProfileSettingConflict } = await import('./profileConflict')
      write.sendValue = mergeProfileSettingConflict(key, write.baseValue, write.sendValue, previous.value)
      write.baseValue = structuredClone(previous.value)
    }
    write.expectedRevision = access.revision()
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const input = { operationId: write.operationId, key, value: write.sendValue as string | null, expectedRevision: write.expectedRevision }
      const saved = domain === 'settings' ? await access.port.saveSetting(input)
        : domain === 'chat' ? await access.port.saveChatRecord({ ...input, baseValue: write.baseValue, changedCharacters: write.changedCharacters, expectedReset: write.expectedReset })
          : await access.port.saveDraft({ ...input, ...(write.session ? { windowId: access.windowId } : {}), expectedReset: write.expectedReset })
      access.saved(saved)
      return 'confirmed'
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : ''
      if (code !== 'REVISION_CONFLICT' && code !== 'PROFILE_RESET_CONFLICT') throw error
      if (key === SD_PENDING_QUEUE_KEY && code === 'REVISION_CONFLICT') {
        throw Object.assign(new Error('待处理队列已被其他窗口更新，请刷新页面后重试。'), { code })
      }
      const latest = domain === 'settings' ? await access.port.readSettings() : domain === 'chat' ? await access.port.readChat() : await access.port.readDrafts(access.windowId)
      if (domain === 'draft' && !key.startsWith(CHAT_DRAFT_PREFIX)
        && (code === 'PROFILE_RESET_CONFLICT' || latest.resetRevision !== write.expectedReset)) {
        // Chat reset retains drawing/video/model drafts; keep their CAS fence.
        write.expectedReset = latest.resetRevision
        write.operationId = crypto.randomUUID()
        continue
      }
      const remote = latest.records.find(record => record.key === key)
      if ((domain === 'chat' || key.startsWith(CHAT_DRAFT_PREFIX)) && latest.resetRevision !== write.expectedReset) {
        access.recovered(domain === 'chat' ? latest : await access.port.readChat())
        return 'recovered'
      }
      const { mergeProfileChatConflict, mergeProfileSettingConflict } = await import('./profileConflict')
      if (domain === 'chat') write.sendValue = await mergeProfileChatConflict(key, write.baseValue, write.sendValue, remote?.value ?? null)
      else if (domain === 'settings') write.sendValue = mergeProfileSettingConflict(key, write.baseValue, write.sendValue, remote?.value ?? null)
      write.baseValue = structuredClone(remote?.value ?? null)
      write.changedCharacters = undefined
      write.expectedRevision = remote?.revision ?? null
      write.operationId = crypto.randomUUID()
    }
  }
  throw new Error('其他窗口正在修改同一资料，请稍后重试；当前编辑已保留。')
}
