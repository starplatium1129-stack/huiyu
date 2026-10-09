import { describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises } from '@vue/test-utils'
import { attachDesktopWorkspace } from './useDesktopWorkspace'
import { createSettingsRepository } from '@/storage/settingsRepository'
import { DESKTOP_LAST_PAGE_SETTING, DESKTOP_START_PAGE_SETTING } from '@/storage/desktopPreferences'

function fixture() {
  const data = new Map<string, string>()
  const settings = createSettingsRepository({ getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) } })
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
  return { settings, router }
}
describe('desktop workspace preferences', () => {
  it('restores the chosen page and remembers successful navigation without query strings', async () => {
    const { settings, router } = fixture()
    settings.set(DESKTOP_START_PAGE_SETTING, '/prompt-builder')
    await router.push('/')
    const detach = attachDesktopWorkspace(router, settings)
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/prompt-builder')
    await router.push('/gallery?project=private-draft')
    expect(settings.get(DESKTOP_LAST_PAGE_SETTING)).toBe('/gallery')
    await router.push('/control')
    expect(settings.get(DESKTOP_LAST_PAGE_SETTING)).toBe('/gallery')
    detach()
    await router.push('/video-studio')
    expect(settings.get(DESKTOP_LAST_PAGE_SETTING)).toBe('/gallery')
  })
  it('restores the last page but preserves explicit deep links', async () => {
    for (const initial of ['/', '/?scene=sc001', '/gallery?project=1', '/companion']) {
      const { settings, router } = fixture()
      settings.set(DESKTOP_START_PAGE_SETTING, 'last')
      settings.set(DESKTOP_LAST_PAGE_SETTING, '/video-studio')
      await router.push(initial)
      const detach = attachDesktopWorkspace(router, settings)
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe(initial === '/' ? '/video-studio' : initial)
      detach()
    }
  })
  it('rejects untrusted destinations and cancels before the router becomes ready', async () => {
    expect(DESKTOP_START_PAGE_SETTING.parse('https://example.com')).toBeNull()
    expect(DESKTOP_LAST_PAGE_SETTING.parse('/companion')).toBeNull()
    const { settings, router } = fixture()
    settings.set(DESKTOP_START_PAGE_SETTING, '/gallery')
    const detach = attachDesktopWorkspace(router, settings)
    detach()
    await router.push('/')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/')
  })
  it('keeps remembering later navigation when the restored page fails to load', async () => {
    const { settings } = fixture()
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: '/', component: {} },
      { path: '/gallery', component: () => Promise.reject(new Error('offline page chunk')) },
      { path: '/video-studio', component: {} },
    ] })
    router.onError(() => {})
    settings.set(DESKTOP_START_PAGE_SETTING, 'last')
    settings.set(DESKTOP_LAST_PAGE_SETTING, '/gallery')
    await router.push('/')
    const detach = attachDesktopWorkspace(router, settings)
    try {
      await flushPromises()
      expect(router.currentRoute.value.path).toBe('/')
      await router.push('/video-studio?job=private-job')
      expect(settings.get(DESKTOP_LAST_PAGE_SETTING)).toBe('/video-studio')
    } finally { detach() }
  })
})
