import { workspaceRequest } from '../../api/workspace.ts'
import { getDesktopRuntime } from './runtime.ts'
import { flushProfileWrites } from '../web/profileStorage.ts'

export interface WorkspaceBackupReceipt { format: 'huiyu-workspace-backup-receipt'; version: 1; workspaceId: string; backupId: string; createdAt: string; revision: number; mediaCount: number }
export function workspaceBackupActive(): boolean { return getDesktopRuntime().bootstrap?.runtime?.workspace?.domains.includes('artwork') === true }
export async function createWorkspaceBackup(signal?: AbortSignal): Promise<WorkspaceBackupReceipt> {
  await flushProfileWrites()
  const workspace = getDesktopRuntime().bootstrap?.runtime?.workspace
  if (!workspace) throw new Error('本机工作区尚未连接。')
  const result = await workspaceRequest<{ backupId: string; revision: number; mediaCount: number }>({ kind: 'backup', operationId: crypto.randomUUID() }, signal)
  return { format: 'huiyu-workspace-backup-receipt', version: 1, workspaceId: workspace.workspaceId, createdAt: new Date().toISOString(), ...result }
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
