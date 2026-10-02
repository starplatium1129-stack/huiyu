import { onScopeDispose, ref } from 'vue'
import { getDesktopUpdater } from '@/platform/desktop/updater'

/**
 * 桌面端自动更新横幅（审计 P1：Tauri updater）。
 * 仅在 Tauri 壳内生效（window.__TAURI__，withGlobalTauri 注入核心 invoke/event API）。
 * 启动检查在 Rust 侧后台完成并广播 `desktop-update-found`；安装经
 * `desktop_update_install` 命令下载安装并由安装器重启应用。
 */

export function useDesktopUpdater() {
  const availableVersion = ref('')
  const statusText = ref('')
  const installing = ref(false)
  const cancelling = ref(false)
  const errorText = ref('')
  const subscriptions: number[] = []
  let disposed = false, checkRevision = 0

  const api = getDesktopUpdater()
  /** 当前前端是否运行在桌面壳内。浏览器里桌面更新能力不存在——这是能力缺失，
   *  不是故障（审计 2026-09-05 P2-04）：静默跳过检查，不得把"仅桌面端支持"当错误展示。 */
  const supported = api !== null
  if (api) {
    subscriptions.push(api.onFound(version => { if (!disposed && !installing.value) { checkRevision++; availableVersion.value = version } }))
    subscriptions.push(api.onProgress(text => { if (!disposed && installing.value) statusText.value = text }))
  }

  async function check(silent = false): Promise<void> {
    if (!api || disposed || installing.value) return
    const revision = ++checkRevision
    const current = () => !disposed && !installing.value && revision === checkRevision
    try {
      const version = await api.check()
      if (!current()) return
      availableVersion.value = version ?? ''
      statusText.value = ''
      errorText.value = '' // 重试成功：清掉上一次失败留下的旧错误
    } catch (error) {
      if (!current()) return
      // 启动时的自动检查属于可选能力；离线或网关短暂重启不应展示底层网络错误。
      errorText.value = silent ? '' : (error instanceof Error ? error.message : String(error))
    }
  }

  async function install(): Promise<void> {
    if (!api || disposed || installing.value) return
    checkRevision++
    installing.value = true
    errorText.value = ''
    statusText.value = '准备安装…'
    try {
      const installed = await api.install()
      if (disposed) return
      if (!installed) {
        installing.value = false
        cancelling.value = false
        statusText.value = '更新已取消；再次升级会重新下载完整安装包'
      }
      // 成功路径：安装器重启应用，不会走到这里
    } catch (error) {
      if (disposed) return
      statusText.value = ''
      errorText.value = error instanceof Error ? error.message : String(error)
      installing.value = false
      cancelling.value = false
    }
  }

  async function cancel(): Promise<void> {
    if (!api || disposed || !installing.value || cancelling.value) return
    const revision = checkRevision
    cancelling.value = true
    try {
      const accepted = await api.cancel()
      if (disposed || !installing.value || checkRevision !== revision) return
      statusText.value = accepted ? '正在取消更新…' : '已进入安装阶段，请等待安装器完成'
    } catch (error) {
      if (disposed || !installing.value || checkRevision !== revision) return
      cancelling.value = false
      errorText.value = error instanceof Error ? error.message : String(error)
    }
  }

  onScopeDispose(() => { disposed = true; checkRevision++; subscriptions.forEach(id => api?.off(id)) })

  return { availableVersion, statusText, installing, cancelling, errorText, supported, check, install, cancel }
}
