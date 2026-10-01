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
      await prepareDesktopWorkspace()
      assertCurrent()
      await refreshDesktopRuntime()
      assertCurrent()
      const candidate = getDesktopRuntime().bootstrap?.runtime?.workspace
      const bridge = getDesktopCapabilities()
      const result = await migrateProfileToCandidate({ sourceProfileId: bootstrap.sourceProfileId, expectedOrigin: bootstrap.sourceOrigin,
        backupDirectory: directory, signal: request.signal, candidate: { request: workspaceRequest },
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
          await activateDesktopWorkspace(status.migrationId, false)
        },
      })
      await refreshDesktopRuntime()
      if (!disposed) {
        onMessage(`迁移已完成，独立备份保存在 ${result.backupName}；旧资料继续保留。`)
        available.value = false
      }
    } catch (error) { if (!disposed) onMessage(request.signal.aborted && !activating.value ? '迁移已取消，原始资料与已导出的备份已保留。' : error instanceof Error ? error.message : '迁移未完成，原始资料与已导出的备份已保留。') }
    finally { if (controller === request) { busy.value = false; controller = null; activating.value = false; progress.value = '' } }
  }
  async function enableBundled() {
    if (busy.value || !bundledVerified.value) return
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
  return { available, bundledAvailable, bundledVerified, busy, canCancel, progress, migrate, enableBundled, cancel: () => { if (!activating.value) controller?.abort() } }
}
