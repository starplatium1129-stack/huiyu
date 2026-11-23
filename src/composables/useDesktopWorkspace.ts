import type { Router } from 'vue-router'
import { settingsRepository } from '@/storage/settingsRepository'
import { startupProfilePending, whenStartupProfileReady } from '@/platform/startupProfile'
import { DESKTOP_LAST_PAGE_SETTING, DESKTOP_START_PAGE_SETTING, isDesktopPage } from '@/storage/desktopPreferences'

/** Install before the router starts resolving its first page. */
export function attachDesktopWorkspace(router: Router) {
  let disposed = false
  let navigation = 0
  const stopRestore = router.beforeEach(async (to, from) => {
    const current = ++navigation
    if (current !== 1 || from.matched.length || to.fullPath !== '/') return
    // Every saved start page shares the atelier layout. Fetch it while the
    // profile connects, then let the router fetch only the chosen child.
    if (startupProfilePending.value) void import('@/components/AppLayout.vue').catch(() => {})
    try { await whenStartupProfileReady() } catch { return }
    if (disposed || navigation !== current || router.currentRoute.value !== from) return
    const choice = settingsRepository.get(DESKTOP_START_PAGE_SETTING)
    const target = choice === 'last' ? settingsRepository.get(DESKTOP_LAST_PAGE_SETTING) : choice
    if (target && target !== '/') return { path: target, replace: true }
  })
  const stopRemember = router.afterEach(async (to, _from, failure) => {
    if (failure || !isDesktopPage(to.path)) return
    try { await whenStartupProfileReady() } catch { return }
    if (!disposed && router.currentRoute.value === to && settingsRepository.get(DESKTOP_LAST_PAGE_SETTING) !== to.path) {
      void settingsRepository.set(DESKTOP_LAST_PAGE_SETTING, to.path)
    }
  })
  return () => { disposed = true; stopRestore(); stopRemember() }
}
