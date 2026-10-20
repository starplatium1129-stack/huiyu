import { onScopeDispose, ref, type Ref } from 'vue'
import { invokeHost, hostApi } from '@/platform/desktop/hostApi'
import { createWorkspaceBackup } from '@/platform/desktop/backupActions'
import { confirmAction } from './useConfirm'
import { flushProfileWrites } from '@/platform/web/profileStorage'
import { registerMaintenanceParticipant } from '@/platform/maintenanceParticipants'
import { WORKSPACE_BACKUP_PENDING_PREFIX } from '@/utils/storageKeys'
import { getDesktopRuntime } from '@/platform/desktop/runtime'

interface PortableResult { workspaceId?: string; mediaCount?: number; path?: string }
interface HostReply { cancelled?: boolean; activated?: boolean; job?: { operationId: string; state: string; result?: PortableResult; error?: string; progress?: { phase: string; completed: number; total: number } } }
const candidateKey = WORKSPACE_BACKUP_PENDING_PREFIX + 'portable-restore'
const pendingKey = WORKSPACE_BACKUP_PENDING_PREFIX + 'portable-operation'
let activeFileOperation = false
export function usePortableBackup(busy: Ref<boolean>, flash: (message: string) => void) {
  const available = Boolean(hostApi())
  const progress = ref(''), candidate = ref<PortableResult | null>(null)
  let operation: string | null = null, controller: AbortController | null = null, disposed = false, activating = false
  try { const value = JSON.parse(globalThis.localStorage.getItem(candidateKey) || 'null'); if (typeof value?.workspaceId === 'string') candidate.value = value } catch { /* Picker remains available if the remembered preview cannot be read. */ }
  const call = (action: string, extra = {}) => invokeHost<HostReply>('workspace_portable_backup', { action, operationId: operation, ...extra })
  function cancel() { controller?.abort(); if (operation) void call('cancel').catch(() => {}) }
  const preparingActivation = (reason?: 'migration') => activating && reason === 'migration'
  const release = registerMaintenanceParticipant(async reason => { if (operation && !preparingActivation(reason)) throw new Error('完整备份正在处理，请先完成或取消。') })
  onScopeDispose(() => { disposed = true; cancel(); release() })
  async function run(action: 'export' | 'import') {
    if (busy.value || disposed || !available) return
    if (activeFileOperation) { flash('已有完整备份操作正在进行，请先完成或取消。'); return }
    activeFileOperation = true; busy.value = true; operation = crypto.randomUUID(); controller = new AbortController()
    const signal = controller.signal
    let settled = false
    try {
      await flushProfileWrites()
      signal.throwIfAborted()
      const pending = JSON.parse(globalThis.localStorage.getItem(pendingKey) || 'null') as { id?: string; action?: string } | null
      let reply: HostReply
      if (pending?.id) {
        operation = pending.id
        progress.value = '正在核对上次完整备份操作…'
        action = pending.action === 'import' ? 'import' : 'export'
        reply = await call('status')
      } else {
        progress.value = action === 'export' ? '正在创建一致的工作区快照…' : '请选择完整备份包…'
        const receipt = action === 'export' ? await createWorkspaceBackup(signal, () => {}, value => { progress.value = `准备备份 ${value.completed} / ${value.total}` }) : null
        signal.throwIfAborted()
        globalThis.localStorage.setItem(pendingKey, JSON.stringify({ id: operation, action }))
        reply = await call(action, { backupId: receipt?.backupId })
      }
      if (reply.cancelled) { settled = true; return }
      let cancellationSent = false
      while (reply.job && ['running','cancelling'].includes(reply.job.state)) {
        if (reply.job.operationId !== operation) throw new Error('备份操作编号不匹配，原待办已保留')
        if (signal.aborted && !cancellationSent) { cancellationSent = true; await call('cancel') }
        const current = reply.job.progress
        progress.value = signal.aborted ? '正在停止并清理未完成的文件…' : current
          ? `正在${action === 'export' ? '写出' : '读取并核验'}完整备份 ${current.completed} / ${current.total}` : '正在处理完整备份…'
        await new Promise(resolve => setTimeout(resolve, 700))
        reply = await call('status')
      }
      if (reply.job?.operationId !== operation) throw new Error('备份回执编号不匹配')
      settled = ['succeeded','failed','cancelled'].includes(reply.job.state)
      if (reply.job.state === 'cancelled') { if (!disposed) flash('已取消完整备份操作，原工作区保留'); return }
      if (reply.job?.state !== 'succeeded' || !reply.job.result) throw new Error(reply.job?.error || '备份结果尚未确认，请保持程序打开并重试查询')
      if (action === 'import') {
        candidate.value = reply.job.result
        globalThis.localStorage.setItem(candidateKey, JSON.stringify(candidate.value))
        if (!disposed) flash(`完整备份已核验，共 ${candidate.value.mediaCount} 个媒体；可切换到恢复副本。`)
      } else if (!disposed) flash(`完整备份已保存：${reply.job.result.path}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : '完整备份操作未完成'
      // A new host no longer owns the old in-memory file operation. Never replay
      // its file grant; the next action must use a fresh native picker.
      if (message.includes('WORKSPACE_JOB_NOT_FOUND')) settled = true
      if (!disposed) flash(message.includes('WORKSPACE_JOB_NOT_FOUND') ? '上次文件操作已不在运行，请核对目标文件后重新选择备份包；原工作区保留。' : message)
    } finally {
      try { if (settled) globalThis.localStorage.removeItem(pendingKey) }
      finally { activeFileOperation = false; operation = null; controller = null; busy.value = false; progress.value = '' }
    }
  }
  async function activate() {
    if (!candidate.value?.workspaceId || busy.value || disposed || activeFileOperation) return
    const selected = candidate.value
    if (!await confirmAction({ title: '切换到恢复的工作区？', message: '将打开已核验的恢复副本。当前工作区保留；恢复的历史任务不会自动重新生成。', confirmLabel: '切换工作区' })) return
    if (disposed || busy.value || activeFileOperation || candidate.value !== selected) return
    activeFileOperation = true; busy.value = true; activating = true; operation = crypto.randomUUID()
    try {
      const bootstrap = getDesktopRuntime().bootstrap
      const workspace = bootstrap?.runtime?.workspace
      if (!bootstrap || !workspace) throw new Error('工作区尚未连接，请恢复连接后再切换。')
      const { freezeMigrationSource, markMigrationActivation, reconcileMigrationAuthority } = await import('@/platform/web/migrationBarrier')
      await freezeMigrationSource(async () => {
        const current = getDesktopRuntime()
        if (disposed || current.connection !== 'ready' || current.bootstrap?.runtime?.workspace?.runtimeEpoch !== workspace.runtimeEpoch) throw new Error('工作区连接已变化，请重新核对恢复副本。')
        // Keep every source window sealed until the existing authority protocol
        // confirms the new workspace, including a lost native acknowledgement.
        markMigrationActivation({ migrationId: selected.workspaceId!, workspaceId: selected.workspaceId!, generation: workspace.generation,
          sourceProfileId: bootstrap.sourceProfileId, sourceOrigin: bootstrap.sourceOrigin, domains: ['artwork', 'settings', 'chat', 'draft'] })
        let activationError: unknown
        try {
          const reply = await call('activate', { workspaceId: selected.workspaceId })
          if (!reply.activated) throw new Error('切换结果尚未确认，请重新连接')
        } catch (error) { activationError = error }
        try { await reconcileMigrationAuthority() }
        catch (error) { throw new Error(`${error instanceof Error ? error.message : '工作区尚未确认'}${activationError instanceof Error ? ` ${activationError.message}` : ''}`) }
      })
      globalThis.localStorage.removeItem(candidateKey)
      window.location.reload()
    } catch (error) { flash(error instanceof Error ? error.message : '工作区尚未切换') }
    finally { activeFileOperation = false; operation = null; activating = false; busy.value = false }
  }
  return { available, progress, candidate, run, cancel, activate, preparingActivation }
}
