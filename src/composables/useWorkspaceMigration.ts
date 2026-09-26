import { ref, onScopeDispose } from 'vue'
import { getDesktopRuntime, onDesktopRuntime, refreshDesktopRuntime } from '../platform/desktop/runtime'
import { prepareDesktopWorkspace, activateDesktopWorkspace, enableDesktopBundledUi } from '../platform/desktop/bootstrap'
import { getDesktopCapabilities } from '../platform/desktop/capabilities'
import { workspaceRequest } from '../api/workspace'
import { migrateProfileToCandidate } from '../platform/web/migrationCoordinator'
import { useTaskCenter } from './useTaskCenter'
import { flushProfileWrites } from '../platform/web/profileStorage'

export function useWorkspaceMigration(onMessage: (message: string) => void) {
  const busy = ref(false), available = ref(false), progress = ref('')
  const bundledAvailable = ref(false), bundledVerified = ref(false)
  const tasks = useTaskCenter()
  let controller: AbortController | null = null
  const unsubscribe = onDesktopRuntime(state => {
    available.value = state.connection === 'ready' && state.bootstrap?.windowRole === 'atelier'
      && !state.bootstrap.runtime?.workspace?.domains.includes('artwork')
    const workspace = state.bootstrap?.runtime?.workspace
    bundledAvailable.value = state.connection === 'ready' && state.bootstrap?.windowRole === 'atelier' && Boolean(workspace)
      && !workspace!.bundledUi && ['artwork', 'settings', 'chat', 'draft'].every(domain => workspace!.domains.includes(domain as 'artwork' | 'settings' | 'chat' | 'draft'))
    bundledVerified.value = state.bootstrap?.bundledUiAvailable === true
  })
  onScopeDispose(() => { unsubscribe(); controller?.abort() })
  async function migrate(resume = false) {
    if (busy.value) return
    const bootstrap = getDesktopRuntime().bootstrap
    if (!bootstrap || tasks.activeCount.value) { onMessage('请等待进行中的任务结束后再迁移。'); return }
    const choose = (window as Window & { showDirectoryPicker?: (options: { mode: string; id: string }) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker
    if (!choose) { onMessage('当前窗口不支持选择独立备份目录，请更新桌面 WebView2 后重试。'); return }
    let directory: FileSystemDirectoryHandle
    try { directory = await choose({ mode: resume ? 'read' : 'readwrite', id: 'huiyu-migration-backup' }) } catch { return }
    busy.value = true; controller = new AbortController(); progress.value = '正在准备独立备份与来源盘点…'
    try {
      await prepareDesktopWorkspace()
      await refreshDesktopRuntime()
      const bridge = getDesktopCapabilities()
      const result = await migrateProfileToCandidate({ sourceProfileId: bootstrap.sourceProfileId, expectedOrigin: bootstrap.sourceOrigin,
        backupDirectory: directory, signal: controller.signal, candidate: { request: workspaceRequest },
        resume,
        migrateCredential: async (reference, secret) => {
          if (!bridge?.writeChatCredential || !bridge.readChatCredential) return false
          await bridge.writeChatCredential(reference, secret)
          return await bridge.readChatCredential(reference) === secret
        },
        onProgress: (phase, completed, total) => { progress.value = phase === 'verify' ? '正在核对原图与恢复副本…' : `正在迁移 ${completed} / ${total}` },
        activate: async status => { await activateDesktopWorkspace(status.migrationId, false) },
      })
      await refreshDesktopRuntime()
      onMessage(`迁移已完成，独立备份保存在 ${result.backupName}；旧资料继续保留。`)
      available.value = false
    } catch (error) { onMessage(error instanceof Error ? error.message : '迁移未完成，原始资料与已导出的备份已保留。') }
    finally { busy.value = false; controller = null; progress.value = '' }
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
  return { available, bundledAvailable, bundledVerified, busy, progress, migrate, enableBundled, cancel: () => controller?.abort() }
}
