import { workspaceRequest } from '../../api/workspace.ts'
import { getDesktopRuntime } from './runtime.ts'
import { flushProfileWrites } from '../web/profileStorage.ts'
import { WORKSPACE_BACKUP_PENDING_PREFIX } from '../../utils/storageKeys.ts'

export interface WorkspaceBackupReceipt { format: 'huiyu-workspace-backup-receipt'; version: 1; workspaceId: string; backupId: string; createdAt: string; revision: number; mediaCount: number }
export function workspaceBackupActive(): boolean { return getDesktopRuntime().bootstrap?.runtime?.workspace?.domains.includes('artwork') === true }
/** createdAt is the original operation start, not an exact snapshot timestamp:
 * a prepared retry may reuse an existing manifest or finish a later snapshot. */
export async function createWorkspaceBackup(signal?: AbortSignal, deliver?: (receipt: WorkspaceBackupReceipt, resumed: boolean) => void): Promise<WorkspaceBackupReceipt> {
  const workspace = getDesktopRuntime().bootstrap?.runtime?.workspace
  if (!workspace?.workspaceId || !workspace.principalId) throw new Error('本机工作区尚未连接。')
  const identity = JSON.stringify([workspace.workspaceId, workspace.principalId])
  const storageKey = WORKSPACE_BACKUP_PENDING_PREFIX + identity
  const assertCurrent = () => {
    signal?.throwIfAborted()
    const current = getDesktopRuntime().bootstrap?.runtime?.workspace
    if (JSON.stringify([current?.workspaceId, current?.principalId]) !== identity) throw new Error('工作区连接已变化，请回到原工作区重试备份。')
  }
  if (!navigator.locks?.request) throw new Error('当前环境不支持跨窗口安全备份，请使用新版桌面应用。')
  return navigator.locks.request(storageKey, { signal }, async () => {
    assertCurrent()
    await flushProfileWrites()
    assertCurrent()
    const stored = globalThis.localStorage.getItem(storageKey)
    const pending: { operationId: string; createdAt: string } = stored === null
      ? { operationId: crypto.randomUUID(), createdAt: new Date().toISOString() }
      : JSON.parse(stored)
    if (!pending || typeof pending.operationId !== 'string' || !/^[0-9a-f-]{36}$/.test(pending.operationId)
      || typeof pending.createdAt !== 'string' || !Number.isFinite(Date.parse(pending.createdAt))) throw new Error('备份恢复标记异常，原标记已保留。')
    if (stored === null) globalThis.localStorage.setItem(storageKey, JSON.stringify(pending))
    type Result = { backupId: string; revision: number; mediaCount: number }
    type Operation = { operationId: string; kind: string; state: string; receipt?: Result & { operationId: string; kind: string } }
    const operation = stored === null ? null : await workspaceRequest<Operation | null>({ kind: 'getOperation', operationId: pending.operationId }, signal)
    assertCurrent()
    if (operation && (operation.operationId !== pending.operationId || operation.kind !== 'backup'
      || !['prepared', 'committed'].includes(operation.state))) throw new Error('备份操作身份不匹配，恢复标记已保留。')
    let result: Result
    if (operation?.state === 'committed') {
      if (operation.receipt?.operationId !== pending.operationId || operation.receipt.kind !== 'backup') throw new Error('备份回执身份不匹配，恢复标记已保留。')
      result = operation.receipt
    } else result = await workspaceRequest<Result>({ kind: 'backup', operationId: pending.operationId }, signal)
    assertCurrent()
    const receipt = parseWorkspaceBackupReceipt({ format: 'huiyu-workspace-backup-receipt', version: 1,
      workspaceId: workspace.workspaceId, createdAt: pending.createdAt,
      backupId: result.backupId, revision: result.revision, mediaCount: result.mediaCount })
    if (deliver) {
      deliver(receipt, stored !== null)
      assertCurrent()
      // Delivery means the browser accepted the download trigger, not disk acceptance.
      if (globalThis.localStorage.getItem(storageKey) !== JSON.stringify(pending)) throw new Error('备份恢复标记已变化，请重新读取。')
      globalThis.localStorage.removeItem(storageKey)
    }
    return receipt
  })
}
export function parseWorkspaceBackupReceipt(value: unknown): WorkspaceBackupReceipt {
  const record = value as Partial<WorkspaceBackupReceipt> | null
  const workspaceId = getDesktopRuntime().bootstrap?.runtime?.workspace?.workspaceId
  if (!record || record.format !== 'huiyu-workspace-backup-receipt' || record.version !== 1 || record.workspaceId !== workspaceId
    || typeof record.backupId !== 'string' || !/^[\w-]+$/.test(record.backupId) || !Number.isSafeInteger(record.revision)
    || !Number.isSafeInteger(record.mediaCount) || typeof record.createdAt !== 'string') throw new Error('请选择属于当前本机工作区的备份凭证；旧网页备份需通过独立迁移导入。')
  return record as WorkspaceBackupReceipt
}
export async function createWorkspaceRestoreCandidate(receipt: WorkspaceBackupReceipt): Promise<{ candidateId: string; revision: number; mediaCount: number }> {
  return workspaceRequest({ kind: 'restoreBackup', operationId: crypto.randomUUID(), backupId: receipt.backupId })
}
export async function workspaceStorageHealth(): Promise<string> {
  const status = await workspaceRequest<{ revision: number; schemaVersion: number }>({ kind: 'status' })
  return `本机工作区已连接 · 数据修订 ${status.revision} · 格式 ${status.schemaVersion}`
}
export async function collectWorkspaceGarbage(): Promise<number> {
  const result = await workspaceRequest<{ removed: number }>({ kind: 'collectGarbage', operationId: crypto.randomUUID() })
  return result.removed
}
