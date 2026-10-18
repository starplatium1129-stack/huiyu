import { readonly, ref } from 'vue'
import { settingsRepository, THEME_SETTING, type Theme } from '@/storage/settingsRepository'
import { listenMotionChanges, prefersReducedMotion } from '@/utils/motionPreference'
import { cssTimeToMilliseconds } from '@/utils/motionTiming'
import '@/assets/css/theme-motion.css'

function preferredTheme(): Theme { return settingsRepository.get(THEME_SETTING) || 'dark' }
const theme = ref<Theme>(preferredTheme())
let initialized = false
let paletteFrame = 0
type PaperTurn = { target: Theme; sheet: HTMLDivElement; animation: Animation; release: () => void }
let paperTurn: PaperTurn | undefined

function stopPaperTurn() {
  const previous = paperTurn
  paperTurn = undefined
  if (!previous) return
  previous.release()
  previous.animation.cancel()
  previous.sheet.remove()
}

function canTurnPaper() {
  return !prefersReducedMotion() && !document.hidden &&
    !document.documentElement.classList.contains('companion-desktop') &&
    !window.matchMedia('(forced-colors: active)').matches &&
    Boolean(document.querySelector('#app[data-v-app]')) &&
    typeof document.documentElement.animate === 'function'
}

function turnPaper(target: Theme, paper: string, edge: string, duration: number, easing: string) {
  // A decorative sheet, never a captured/duplicated UI. Native view-transition
  // captures disable hit-testing on their contents, even with pointer-events:none.
  // The real page and every control remain stationary and usable underneath.
  const sheet = document.createElement('div')
  sheet.className = 'theme-paper-turn'
  sheet.setAttribute('aria-hidden', 'true')
  sheet.inert = true
  sheet.dataset.direction = target === 'light' ? 'forward' : 'backward'
  sheet.style.setProperty('--theme-paper', paper)
  sheet.style.setProperty('--theme-paper-edge', edge)
  document.body.append(sheet)
  const direction = target === 'light' ? -1 : 1
  try {
    const animation = sheet.animate([
      { transform: 'perspective(1600px) translateX(0%) rotateY(0deg)', opacity: 0, offset: 0 },
      { transform: `perspective(1600px) translateX(${direction * 3}%) rotateY(${direction * 12}deg)`, opacity: .3, offset: .16 },
      { transform: `perspective(1600px) translateX(${direction * 14}%) rotateY(${direction * 54}deg)`, opacity: .22, offset: .65 },
      { transform: `perspective(1600px) translateX(${direction * 24}%) rotateY(${direction * 88}deg)`, opacity: 0, offset: 1 },
    ], { duration, easing, fill: 'both' })
    const onInput = (event: Event) => {
      // A second press on the actual theme switch reverses this same timeline.
      const toggle = event.target instanceof Element && event.target.closest('.app-theme-toggle')
      if (toggle && (!(event instanceof KeyboardEvent) || event.key === 'Enter' || event.key === ' ')) return
      stopPaperTurn()
    }
    const onMotion = () => { if (!canTurnPaper()) stopPaperTurn() }
    const releaseMotion = listenMotionChanges(onMotion)
    document.addEventListener('pointerdown', onInput, true)
    document.addEventListener('keydown', onInput, true)
    document.addEventListener('scroll', stopPaperTurn, true)
    window.addEventListener('resize', stopPaperTurn)
    window.addEventListener('popstate', stopPaperTurn)
    window.addEventListener('pagehide', stopPaperTurn)
    const current: PaperTurn = { target, sheet, animation, release: () => {
      releaseMotion()
      document.removeEventListener('pointerdown', onInput, true)
      document.removeEventListener('keydown', onInput, true)
      document.removeEventListener('scroll', stopPaperTurn, true)
      window.removeEventListener('resize', stopPaperTurn)
      window.removeEventListener('popstate', stopPaperTurn)
      window.removeEventListener('pagehide', stopPaperTurn)
    } }
    paperTurn = current
    animation.onfinish = () => {
      if (paperTurn === current && animation.playState === 'finished') stopPaperTurn()
    }
    animation.oncancel = () => { if (paperTurn === current) stopPaperTurn() }
  } catch { sheet.remove() }
}

function applyDocumentTheme() {
  const root = document.documentElement
  // Commit the palette immediately; only the non-interactive paper layer moves.
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
  stopPaperTurn()
  theme.value = value
  applyDocumentTheme()
}
function onThemeStorage(event: StorageEvent) {
  if (event.key === THEME_SETTING.key || event.key === null) applyTheme(preferredTheme())
}
export function initializeTheme() {
  applyTheme(preferredTheme())
  if (initialized) return
  initialized = true
  window.addEventListener('storage', onThemeStorage)
}
function setTheme(value: Theme) {
  settingsRepository.set(THEME_SETTING, value)
  if (theme.value === value) return
  const animate = canTurnPaper()
  const previous = animate ? paperTurn : undefined
  const style = animate && !previous ? getComputedStyle(document.documentElement) : undefined
  const paper = style?.getPropertyValue('--bg-base').trim() || ''
  const edge = style?.getPropertyValue('--border-strong').trim() || ''
  const duration = style ? cssTimeToMilliseconds(style.getPropertyValue('--motion-theme-turn')) : 0
  const easing = style?.getPropertyValue('--ease-in-out').trim() || 'ease-in-out'
  theme.value = value
  applyDocumentTheme()
  if (!animate) { stopPaperTurn(); return }
  if (previous) {
    // Preserve the displayed pose on fast reversals; no replay from frame zero.
    previous.animation.updatePlaybackRate(value === previous.target ? 1 : -1)
    previous.animation.play()
  } else if (Number.isFinite(duration) && duration > 0) turnPaper(value, paper, edge, duration, easing)
}
export function useTheme() {
  return { theme: readonly(theme), setTheme, toggleTheme: () => setTheme(theme.value === 'dark' ? 'light' : 'dark') }
}

if (import.meta.hot) import.meta.hot.dispose(() => {
  stopPaperTurn()
  window.removeEventListener('storage', onThemeStorage)
  cancelAnimationFrame(paletteFrame)
  paletteFrame = 0
  initialized = false
  delete document.documentElement.dataset.themeChanging
})
