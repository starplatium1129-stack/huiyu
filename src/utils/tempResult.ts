import { profileDraftStorage as sessionStorage, profileRuntimeActive, flushProfileWrites } from '../platform/web/profileStorage.ts'
import { TEMP_RESULT_KEY } from '@/utils/storageKeys'
import type { AnimaJobMetadata, AnimaResultContext } from '@/types/anima'
import type { DrawEngine } from '@/storage/settingsRepository'
import { isArtworkCommitIdentity, type ArtworkCommitIdentity } from '@/application/artwork/artworkSaveInput'
import { getDesktopRuntime } from '@/platform/desktop/runtime'

/**
 * 未入册临时成片记录（2026-09-06 体验报告 F2）。
 *
 * 用户偏好是「默认不自动入册」（AUTO_SAVE_TO_GALLERY 默认关），但 blob URL
 * 随页面卸载即失效——此前一次切页/刷新，未点「保存快照」的成片就永远消失。
 *
 * 设计：每次直出成功即把 blob 写入 IndexedDB（廉价、本地），sessionStorage
 * 只存指针与参数快照；入册成功/用户显式丢弃时清除；新成片替换旧记录并回收
 * 旧 blob。未确认的入册指针保留，不能被新成片隐式覆盖。
 */

export type TempResultContext = AnimaResultContext
export type TempResultOwner = { kind: 'web'; origin: string; sourceProfileId?: string } | { kind: 'workspace'; workspaceId: string; principalId: string }

export interface TempResultRecord {
  /** IndexedDB 图片 id（blob 本体所在）。 */
  imageId: string
  engine: DrawEngine
  prompt: string
  negative: string
  seed: number | null
  size: string
  /** Anima/Krea 完整任务元数据（恢复时重建会话结果用）。 */
  animaMetadata?: AnimaJobMetadata | null
  /** F3 冻结上下文：出图时的角色/服装/蓝图/场景/故事。 */
  context?: TempResultContext | null
  savedAt: number
  owner?: TempResultOwner
  /** Structured metadata only. Both aliases remain visible to draft media GC. */
  pendingCommit?: ArtworkCommitIdentity
}

function isRecord(value: unknown): value is TempResultRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<TempResultRecord>
  return typeof record.imageId === 'string' && record.imageId.length > 0
    && ['sd', 'anima', 'krea2'].includes(String(record.engine))
}

export function tempResultOwner(): TempResultOwner {
  const state = getDesktopRuntime(), workspace = state.bootstrap?.runtime?.workspace
  if (profileRuntimeActive() || workspace?.domains.includes('artwork')) {
    if (state.connection !== 'ready' || !profileRuntimeActive() || !workspace?.workspaceId || !workspace.principalId
      || !['artwork', 'draft'].every(domain => workspace.domains.includes(domain as 'artwork' | 'draft'))) throw new Error('临时成片资料身份尚未确认，请恢复原工作区连接')
    return { kind: 'workspace', workspaceId: workspace.workspaceId, principalId: workspace.principalId }
  }
  return { kind: 'web', origin: location.origin, sourceProfileId: state.bootstrap?.sourceProfileId }
}
const ownerKey = (owner: TempResultOwner) => JSON.stringify(owner.kind === 'workspace'
  ? [owner.kind, owner.workspaceId, owner.principalId] : [owner.kind, owner.origin, owner.sourceProfileId ?? ''])
export function sameTempResultOwner(owner: TempResultOwner): boolean {
  try { return ownerKey(owner) === ownerKey(tempResultOwner()) } catch { return false }
}

/** An unscoped old record is read from the already selected draft authority.
 * Web-owned records may cross only the verified activation of that source. */
export function resolveTempResultOwner(record: TempResultRecord): TempResultOwner {
  const owner = tempResultOwner()
  if (!record.owner || ownerKey(record.owner) === ownerKey(owner)) return owner
  const bootstrap = getDesktopRuntime().bootstrap
  if (record.owner.kind === 'web' && owner.kind === 'workspace' && bootstrap?.sourceOrigin === record.owner.origin
    && (!record.owner.sourceProfileId || record.owner.sourceProfileId === bootstrap.sourceProfileId)
    && bootstrap.runtime?.workspace?.activeMigrationId) return owner
  throw new Error('临时成片属于另一资料来源，请回到原工作区恢复')
}

/** Missing is empty; unreadable identities stop restoration and keep the pointer. */
export function readTempResult(): TempResultRecord | null {
  try {
    const raw = sessionStorage.getItem(TEMP_RESULT_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) throw new Error('临时成片记录格式无效，原记录已保留')
    if (parsed.owner && !(parsed.owner.kind === 'web' && typeof parsed.owner.origin === 'string'
      || parsed.owner.kind === 'workspace' && typeof parsed.owner.workspaceId === 'string' && typeof parsed.owner.principalId === 'string'))
      throw new Error('临时成片来源身份无效，原记录已保留')
    if (parsed.pendingCommit !== undefined && !isArtworkCommitIdentity(parsed.pendingCommit)) throw new Error('原入册身份无法核对，原记录已保留')
    return parsed
  } catch (error) { throw error instanceof Error ? error : new Error('临时成片记录暂时无法读取') }
}

/** 写入临时记录；存储失败返回 false（调用方负责提示，不静默吞）。 */
function writeTempResult(record: TempResultRecord): boolean {
  try {
    const value = JSON.stringify(record)
    if (profileRuntimeActive()) {
      const bootstrap = getDesktopRuntime().bootstrap
      // ProfilePort uses these fields; 4 KiB covers the bounded revision/reset
      // tokens and operation UUID supplied later by its existing outbox.
      const envelope = { kind: 'profile.saveDraft', operationId: '0'.repeat(36), key: TEMP_RESULT_KEY, value,
        expectedRevision: null, expectedReset: '', windowId: bootstrap?.windowId,
        protocolVersion: 1, workspaceId: bootstrap?.runtime?.workspace?.workspaceId }
      if (new TextEncoder().encode(JSON.stringify(envelope)).byteLength + 4096 > 2 * 1024 * 1024) return false
    }
    sessionStorage.setItem(TEMP_RESULT_KEY, value)
    return true
  } catch {
    return false
  }
}

export async function writeTempResultDurable(record: TempResultRecord): Promise<void> {
  if (!writeTempResult(record)) throw new Error('临时成片身份未写入，入册尚未提交；请检查空间与2MiB工作区正文限制后重试')
  await flushProfileWrites()
}

export function clearTempResult(): boolean {
  try { sessionStorage.removeItem(TEMP_RESULT_KEY); return true } catch { return false }
}
