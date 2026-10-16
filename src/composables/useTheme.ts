import { nextTick, readonly, ref } from 'vue'
import { settingsRepository, THEME_SETTING, type Theme } from '@/storage/settingsRepository'
import { listenMotionChanges, prefersReducedMotion } from '@/utils/motionPreference'

export function preferredTheme(): Theme { return settingsRepository.get(THEME_SETTING) || 'dark' }
const theme = ref<Theme>(preferredTheme())
let initialized = false
let transition: ViewTransition | undefined
let reveal: Animation | undefined
function applyDocumentTheme() {
  document.documentElement.dataset.theme = theme.value
  document.documentElement.style.colorScheme = theme.value
}
function applyTheme(value: Theme) {
  theme.value = value
  transition?.skipTransition()
  reveal?.cancel()
  applyDocumentTheme()
}
export function initializeTheme() {
  applyTheme(preferredTheme())
  if (initialized) return
  initialized = true
  // Theme ownership lasts for the app; interrupted snapshots yield to the latest preference.
  listenMotionChanges(() => {
    if (prefersReducedMotion()) { transition?.skipTransition(); reveal?.cancel(); applyDocumentTheme() }
  }, () => {
    if (document.hidden) { transition?.skipTransition(); reveal?.cancel(); applyDocumentTheme() }
  })
  window.addEventListener('storage', event => {
    if (event.key === THEME_SETTING.key || event.key === null) applyTheme(preferredTheme())
  })
}
export function setTheme(value: Theme, origin?: { x: number; y: number }) {
  settingsRepository.set(THEME_SETTING, value)
  if (theme.value === value) return
  // Keep preference watchers synchronous; only the document paint is deferred.
  theme.value = value
  transition?.skipTransition()
  reveal?.cancel()
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
  // Lucian UX/UI Prompt #219 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#219
  void current.ready.then(() => {
    if (!origin || transition !== current || prefersReducedMotion() || document.hidden) return
    const x = Math.max(0, Math.min(innerWidth, origin.x)), y = Math.max(0, Math.min(innerHeight, origin.y))
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))
    /* compositor-exempt: this occasional reveal clips one native snapshot; scaling would distort the entire UI. */
    reveal = root.animate([
      { clipPath: `circle(0px at ${x}px ${y}px)`, opacity: 1 },
      { clipPath: `circle(${radius}px at ${x}px ${y}px)`, opacity: 1 },
    ], { duration: parseFloat(getComputedStyle(root).getPropertyValue('--motion-surface')), easing: getComputedStyle(root).getPropertyValue('--ease-out').trim(), pseudoElement: '::view-transition-new(root)', fill: 'both' })
  }).catch(() => {}) // Unsupported effects and interrupted captures retain the existing theme fallback.
  void current.finished.catch(applyDocumentTheme).finally(() => {
    if (transition !== current) return
    transition = undefined
    reveal?.cancel()
    reveal = undefined
    delete root.dataset.themeTransition
  })
}
export function useTheme() {
  return { theme: readonly(theme), setTheme, toggleTheme: (origin?: { x: number; y: number }) => setTheme(theme.value === 'dark' ? 'light' : 'dark', origin) }
}
