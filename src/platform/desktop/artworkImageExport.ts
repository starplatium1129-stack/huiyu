import { invokeHost } from './hostApi'
import { getDesktopRuntime } from './runtime'
import type { BackupExportProgress } from '@/utils/backupExport'

interface Reply { cancelled?: boolean; job?: { operationId: string; state: string; progress?: BackupExportProgress; result?: { path: string; mediaCount: number }; error?: string } }
let active = false
/** Native grants come from the folder picker; renderer paths are never accepted. */
export async function exportArtworkImages(signal: AbortSignal, progress: (value: BackupExportProgress) => void): Promise<string> {
  if (active) throw new Error('已有原图导出正在进行，请先完成或取消。')
  active = true
  const workspaceId = getDesktopRuntime().bootstrap?.runtime?.workspace?.workspaceId
  const key = `aics_workspace_image_export_pending_v1:${workspaceId}`
  let operationId: string = crypto.randomUUID(), settled = false
  const call = (action: string) => invokeHost<Reply>('workspace_portable_backup', { action, operationId, workspaceId })
  let started = false, cancellation: Promise<unknown> | undefined
  const cancel = () => { if (started && !cancellation) cancellation = call('cancel').catch(() => {}) }
  signal.addEventListener('abort', cancel)
  try {
    signal.throwIfAborted()
    const pending = globalThis.localStorage.getItem(key)
    if (pending && !/^[0-9a-f-]{36}$/.test(pending)) throw new Error('原图导出恢复编号无效，请保留原记录')
    operationId = pending || operationId
    if (!pending) globalThis.localStorage.setItem(key,operationId)
    let reply = await call(pending ? 'status' : 'export-images')
    if (reply.cancelled) { settled = true; return '未选择导出目录' }
    started = true
    if (signal.aborted) cancel()
    while (reply.job && ['running', 'cancelling'].includes(reply.job.state)) {
      if (reply.job.operationId !== operationId) throw new Error('原图导出操作编号不匹配')
      if (reply.job.progress) progress(reply.job.progress)
      await new Promise(resolve => setTimeout(resolve, 500))
      reply = await call('status')
    }
    if (reply.job?.operationId !== operationId) throw new Error('原图导出回执无效，请核对目标目录')
    settled = ['succeeded','failed','cancelled'].includes(reply.job.state)
    if (reply.job.progress) progress(reply.job.progress)
    if (reply.job.state === 'cancelled') return `已停止导出；已保存 ${reply.job.progress?.completed ?? 0} 张，已完成文件保留`
    if (reply.job.state !== 'succeeded' || !reply.job.result) throw new Error(reply.job.error || '原图导出尚未确认，请核对目标目录')
    return `已导出 ${reply.job.result.mediaCount} 张原图：${reply.job.result.path}`
  } catch (error) {
    // Tauri rejects IPC failures as strings; preserve the host code so a
    // restarted runtime cannot leave this pending marker stuck forever.
    const message = error instanceof Error ? error.message : String(error ?? '')
    if (message.includes('WORKSPACE_JOB_NOT_FOUND')) {
      settled = true
      throw new Error('上次原图导出已不在运行，请核对目标目录后重新选择；已完成文件保留。')
    }
    throw error instanceof Error ? error : new Error(message || '原图导出尚未确认，请核对目标目录')
  } finally {
    signal.removeEventListener('abort', cancel)
    await cancellation
    try { if (settled && globalThis.localStorage.getItem(key) === operationId) globalThis.localStorage.removeItem(key) }
    finally { active = false }
  }
}
