import { readonly, ref } from 'vue'
import { settingsRepository, THEME_SETTING, type Theme } from '@/storage/settingsRepository'

export function preferredTheme(): Theme { return settingsRepository.get(THEME_SETTING) || 'dark' }
const theme = ref<Theme>(preferredTheme())
let initialized = false
let paletteFrame = 0
function applyDocumentTheme() {
  const root = document.documentElement
  // Whole-document snapshots disable hit-testing on their captured controls.
  // Commit the palette immediately; the theme switch owns its local motion.
  root.dataset.themeChanging = ''
  root.dataset.theme = theme.value
  root.style.colorScheme = theme.value
  cancelAnimationFrame(paletteFrame)
  // Paint one coherent palette before restoring ordinary surface transitions.
  paletteFrame = requestAnimationFrame(() => {
    paletteFrame = requestAnimationFrame(() => {
      paletteFrame = 0
      delete root.dataset.themeChanging
    })
  })
}
function applyTheme(value: Theme) {
  theme.value = value
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
  applyTheme(value)
}
export function useTheme() {
  return { theme: readonly(theme), setTheme, toggleTheme: () => setTheme(theme.value === 'dark' ? 'light' : 'dark') }
}
