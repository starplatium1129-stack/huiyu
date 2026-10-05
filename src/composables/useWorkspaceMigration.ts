import type { DesktopWorkspaceSession } from '../../types/desktop-bootstrap'
import { bindMigrationCandidate } from '../platform/web/migrationAuthority'
import { markMigrationActivation, migrationRecoveryPending, watchMigrationRecovery, reconcileMigrationAuthority, recoverMigrationAuthority } from '../platform/web/migrationBarrier'
import { computed, ref, onScopeDispose } from 'vue'
import { getDesktopRuntime, onDesktopRuntime, refreshDesktopRuntime } from '../platform/desktop/runtime'
import { prepareDesktopWorkspace, activateDesktopWorkspace, enableDesktopBundledUi } from '../platform/desktop/bootstrap'
import { getDesktopCapabilities } from '../platform/desktop/capabilities'
import { workspaceRequest } from '../api/workspace'
import { migrateProfileToCandidate } from '../platform/web/migrationCoordinator'
import { useTaskCenter } from './useTaskCenter'
import { flushProfileWrites } from '../platform/web/profileStorage'
import { registerMaintenanceParticipant } from '../platform/maintenanceParticipants'

export function useWorkspaceMigration(onMessage: (message: string) => void) {
  const busy = ref(false), available = ref(false), progress = ref('')
  onScopeDispose(registerMaintenanceParticipant(() => { if (busy.value) throw new Error('MIGRATION_BUSY') }))
  const recoveryPending = ref(migrationRecoveryPending())
  onScopeDispose(watchMigrationRecovery(() => { recoveryPending.value = migrationRecoveryPending() }))
  const bundledAvailable = ref(false), bundledVerified = ref(false)
  const tasks = useTaskCenter()
  let controller: AbortController | null = null
  let disposed = false
  const activating = ref(false)
  const canCancel = computed(() => busy.value && !activating.value && controller !== null)
  const unsubscribe = onDesktopRuntime(state => {
    available.value = state.connection === 'ready' && state.bootstrap?.windowRole === 'atelier'
      && !state.bootstrap.runtime?.workspace?.domains.includes('artwork')
    const workspace = state.bootstrap?.runtime?.workspace
    bundledAvailable.value = state.connection === 'ready' && state.bootstrap?.windowRole === 'atelier' && Boolean(workspace)
      && !workspace!.bundledUi && ['artwork', 'settings', 'chat', 'draft'].every(domain => workspace!.domains.includes(domain as 'artwork' | 'settings' | 'chat' | 'draft'))
    bundledVerified.value = state.bootstrap?.bundledUiAvailable === true
  })
  onScopeDispose(() => { disposed = true; unsubscribe(); controller?.abort() })
  async function migrate(resume = false) {
    if (disposed || busy.value) return
    if (recoveryPending.value) { onMessage('上次激活结果尚未确认，请先执行只读核对。'); return }
    const initial = getDesktopRuntime()
    const bootstrap = initial.bootstrap
    if (!bootstrap || initial.connection !== 'ready' || bootstrap.windowRole !== 'atelier' || tasks.activeCount.value) { onMessage('请等待进行中的任务结束后再迁移。'); return }
    const choose = (window as Window & { showDirectoryPicker?: (options: { mode: string; id: string }) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker
    if (!choose) { onMessage('当前窗口不支持选择独立备份目录，请更新桌面 WebView2 后重试。'); return }
    const request = new AbortController()
    controller = request; busy.value = true
    const sourceIdentity = (value: NonNullable<typeof bootstrap>) => [value.windowId, value.sourceProfileId, value.sourceOrigin, value.runtime?.origin, value.runtime?.runtimeEpoch]
    const identity = JSON.stringify(sourceIdentity(bootstrap))
    const targetIdentity = () => { const target = getDesktopRuntime().bootstrap?.runtime?.workspace; return JSON.stringify([target?.workspaceId, target?.generation]) }
    const initialTarget = targetIdentity()
    function assertCurrent() {
      request.signal.throwIfAborted()
      const current = getDesktopRuntime()
      if (disposed || controller !== request || current.connection !== 'ready' || !current.bootstrap
        || current.bootstrap.windowRole !== 'atelier' || current.bootstrap.runtime?.workspace?.domains.includes('artwork') || JSON.stringify(sourceIdentity(current.bootstrap)) !== identity) throw new Error('工作区连接已变化，请重新开始迁移。')
      if (tasks.activeCount.value) throw new Error('请等待进行中的任务结束后再迁移。')
    }
    try {
      let directory: FileSystemDirectoryHandle
      try { directory = await choose.call(window, { mode: resume ? 'read' : 'readwrite', id: 'huiyu-migration-backup' }) } catch { return }
      assertCurrent()
      if (targetIdentity() !== initialTarget) throw new Error('迁移目标已变化，请重新选择备份目录。')
      progress.value = '正在准备独立备份与来源盘点…'
      let candidate: DesktopWorkspaceSession | null | undefined
      const bridge = getDesktopCapabilities()
      const result = await migrateProfileToCandidate({ sourceProfileId: bootstrap.sourceProfileId, expectedOrigin: bootstrap.sourceOrigin,
        backupDirectory: directory, signal: request.signal,
        prepareCandidate: async selection => {
          assertCurrent()
          const prepared = await prepareDesktopWorkspace(selection)
          assertCurrent()
          // An older coalesced handshake may still refer to the previous candidate.
          await refreshDesktopRuntime(true)
          assertCurrent()
          candidate = getDesktopRuntime().bootstrap?.runtime?.workspace
          const expected = prepared.runtime?.workspace
          if (prepared.connection !== 'ready' || !expected || !candidate
            || candidate.workspaceId !== expected.workspaceId || candidate.runtimeEpoch !== expected.runtimeEpoch || candidate.generation !== expected.generation
            || (selection.mode === 'resume' && selection.workspaceId && candidate.workspaceId !== selection.workspaceId)) throw new Error('迁移目标未确认，请保留备份并重试。')
          return { workspaceId: candidate.workspaceId, ...bindMigrationCandidate(getDesktopRuntime, workspaceRequest) }
        },
        resume,
        migrateCredential: async (reference, secret) => {
          if (!bridge?.writeChatCredential || !bridge.readChatCredential) return false
          await bridge.writeChatCredential(reference, secret)
          return await bridge.readChatCredential(reference) === secret
        },
        onProgress: (phase, completed, total) => { if (!disposed && !request.signal.aborted) progress.value = phase === 'verify' ? '正在核对原图与恢复副本…' : `正在迁移 ${completed} / ${total}` },
        activate: async status => {
          assertCurrent()
          const current = getDesktopRuntime().bootstrap?.runtime?.workspace
          if (!candidate || current?.workspaceId !== candidate.workspaceId || current.generation !== candidate.generation) throw new Error('迁移目标已变化，请重新核对后继续。')
          // Once native activation starts, retain the source barrier until its acknowledgment.
          activating.value = true; progress.value = '正在确认工作区切换，请稍候…'
          // Persist intent before invoke; a lost acknowledgment must not thaw old writers.
          markMigrationActivation({ migrationId: status.migrationId, workspaceId: candidate.workspaceId, generation: candidate.generation,
            sourceProfileId: bootstrap.sourceProfileId, sourceOrigin: bootstrap.sourceOrigin, domains: status.domains })
          let activationError: unknown
          try { await activateDesktopWorkspace(status.migrationId, false) } catch (error) { activationError = error }
          try { await reconcileMigrationAuthority() } catch (error) {
            const detail = error instanceof Error ? error.message : '激活结果尚未确认。'
            throw new Error(activationError instanceof Error ? `${detail} 本机确认：${activationError.message}` : detail)
          }
        },
      })
      if (!disposed) {
        onMessage(`迁移已完成，独立备份保存在 ${result.backupName}；旧资料继续保留。`)
        available.value = false
      }
    } catch (error) { if (!disposed) onMessage(request.signal.aborted && !activating.value ? '迁移已取消，原始资料与已导出的备份已保留。' : error instanceof Error ? error.message : '迁移未完成，原始资料与已导出的备份已保留。') }
    finally { if (controller === request) { busy.value = false; controller = null; activating.value = false; progress.value = '' } }
  }
  async function reconcile() {
    if (disposed || busy.value) return
    busy.value = true
    try {
      await recoverMigrationAuthority()
      if (!disposed) onMessage('已核对本机激活身份与各窗口资料连接，可以继续使用。')
    } catch (error) { if (!disposed) onMessage(error instanceof Error ? error.message : '激活结果仍未确认，请保留备份并联系维护人员。') }
    finally { busy.value = false; recoveryPending.value = migrationRecoveryPending() }
  }
  async function enableBundled() {
    if (busy.value || recoveryPending.value || !bundledVerified.value) return
    if (tasks.activeCount.value) { onMessage('请等待进行中的任务结束后再切换启动方式。'); return }
    busy.value = true
    try {
      await flushProfileWrites()
      await enableDesktopBundledUi()
      await refreshDesktopRuntime()
      onMessage('独立启动界面已准备好，下次启动桌面程序时生效。')
    } catch (error) { onMessage(error instanceof Error ? error.message : '启动方式尚未切换，当前入口继续保留。') }
    finally { busy.value = false }
  }
  return { available, bundledAvailable, bundledVerified, busy, canCancel, recoveryPending, reconcile, progress, migrate, enableBundled, cancel: () => { if (!activating.value) controller?.abort() } }
}
