import type { Router } from 'vue-router'
import { settingsRepository, type SettingsRepository } from '@/storage/settingsRepository'
import { DESKTOP_LAST_PAGE_SETTING, DESKTOP_START_PAGE_SETTING, isDesktopPage } from '@/storage/desktopPreferences'

/** 只恢复工作页，不保存生成参数、查询串或临时授权信息。 */
export function attachDesktopWorkspace(router: Router, settings: SettingsRepository = settingsRepository) {
  let disposed = false
  let unsubscribe: (() => void) | undefined
  void router.isReady().then(async () => {
    if (disposed) return
    const initial = router.currentRoute.value
    const choice = settings.get(DESKTOP_START_PAGE_SETTING)
    const target = choice === 'last' ? settings.get(DESKTOP_LAST_PAGE_SETTING) : choice
    // 明确的深链、带查询参数/锚点的首页以及桌宠表面一律保留。
    if (initial.fullPath === '/' && target && target !== '/') {
      try { await router.replace(target) } catch { /* Keep tracking later successful navigation after a failed restore. */ }
    }
    if (disposed) return
    const remember = (path: string) => {
      if (isDesktopPage(path)) settings.set(DESKTOP_LAST_PAGE_SETTING, path)
    }
    remember(router.currentRoute.value.path)
    unsubscribe = router.afterEach((to, _from, failure) => { if (!failure) remember(to.path) })
  }).catch(() => { /* 导航失败保留当前页；不影响窗口操作。 */ })
  return () => { disposed = true; unsubscribe?.() }
}
