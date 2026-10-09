import { nextTick, readonly, ref } from 'vue'
import { settingsRepository, THEME_SETTING, type Theme } from '@/storage/settingsRepository'
import { prefersReducedMotion } from '@/utils/motionPreference'

export function preferredTheme(): Theme { return settingsRepository.get(THEME_SETTING) || 'dark' }
const theme = ref<Theme>(preferredTheme())
let initialized = false
let transition: ViewTransition | undefined
function applyDocumentTheme() {
  document.documentElement.dataset.theme = theme.value
  document.documentElement.style.colorScheme = theme.value
}
function applyTheme(value: Theme) {
  theme.value = value
  transition?.skipTransition()
  applyDocumentTheme()
}
export function initializeTheme() {
  applyTheme(preferredTheme())
  if (initialized) return
  initialized = true
  window.addEventListener('storage', event => {
    if (event.key === THEME_SETTING.key || event.key === null) applyTheme(preferredTheme())
  })
}
export function setTheme(value: Theme) {
  settingsRepository.set(THEME_SETTING, value)
  if (theme.value === value) return
  // Keep preference watchers synchronous; only the document paint is deferred.
  theme.value = value
  transition?.skipTransition()
  const root = document.documentElement
  if (!document.startViewTransition || prefersReducedMotion() || document.hidden ||
      root.classList.contains('companion-desktop') || !document.querySelector('#app[data-v-app]')) {
    applyDocumentTheme()
    return
  }
  root.dataset.themeTransition = ''
  const current = document.startViewTransition(() => {
    // A skipped transition still invokes its callback. Always use the latest choice.
    applyDocumentTheme()
    return nextTick()
  })
  transition = current
  void current.ready.catch(() => {}) // Skipping an interrupted capture rejects ready.
  void current.finished.catch(applyDocumentTheme).finally(() => {
    if (transition !== current) return
    transition = undefined
    delete root.dataset.themeTransition
  })
}
export function useTheme() {
  return { theme: readonly(theme), setTheme, toggleTheme: () => setTheme(theme.value === 'dark' ? 'light' : 'dark') }
}
