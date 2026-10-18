import { readonly, ref } from 'vue'
import { settingsRepository, THEME_SETTING, type Theme } from '@/storage/settingsRepository'
import { listenMotionChanges, prefersReducedMotion } from '@/utils/motionPreference'
import { cssTimeToMilliseconds } from '@/utils/motionTiming'
import '@/assets/css/theme-motion.css'

function preferredTheme(): Theme { return settingsRepository.get(THEME_SETTING) || 'dark' }
const theme = ref<Theme>(preferredTheme())
let requestedTheme = theme.value
let initialized = false
let paletteFrame = 0
type ThemeReveal = { target: Theme; origin: HTMLElement; transition?: ViewTransition; animation?: Animation; release: () => void }
let reveal: ThemeReveal | undefined

function stopReveal() {
  const previous = reveal
  reveal = undefined
  if (!previous) return
  previous.release()
  previous.transition?.skipTransition()
  previous.animation?.cancel()
  delete document.documentElement.dataset.themeReveal
}

function canReveal() {
  return !prefersReducedMotion() && !document.hidden &&
    !document.documentElement.classList.contains('companion-desktop') &&
    !window.matchMedia('(forced-colors: active)').matches &&
    window.matchMedia('(hover: hover) and (pointer: fine)').matches &&
    !document.querySelector('dialog[open]') &&
    Boolean(document.querySelector('#app[data-v-app]')) &&
    typeof document.startViewTransition === 'function'
}

function commitTheme(value: Theme) {
  const root = document.documentElement
  theme.value = value
  root.dataset.themeChanging = ''
  root.dataset.theme = value
  root.style.colorScheme = value
  cancelAnimationFrame(paletteFrame)
  // Paint one palette, without interpolating thousands of local surface colors.
  paletteFrame = requestAnimationFrame(() => {
    paletteFrame = requestAnimationFrame(() => {
      paletteFrame = 0
      delete root.dataset.themeChanging
    })
  })
}

function applyTheme(value: Theme) {
  requestedTheme = value
  stopReveal()
  commitTheme(value)
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

// Circular reveal adapted from Lucian UX/UI Prompt's site theme control.
// https://lucianlabs.dev/uxui-prompt/ · MIT (c) 2026 Seokwoooo.
function setTheme(value: Theme, origin?: HTMLElement) {
  if (requestedTheme === value) return
  settingsRepository.set(THEME_SETTING, value)
  requestedTheme = value
  const previous = reveal
  if (origin === previous?.origin && previous?.animation?.playState === 'running' && canReveal()) {
    commitTheme(value)
    previous.animation.updatePlaybackRate(value === previous.target ? 1 : -1)
    previous.animation.play()
    return
  }
  stopReveal()
  if (!origin?.isConnected || !canReveal()) { commitTheme(value); return }
  const rect = origin.getBoundingClientRect()
  const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))
  const root = document.documentElement
  const style = getComputedStyle(root)
  const duration = cssTimeToMilliseconds(style.getPropertyValue('--motion-theme-reveal'))
  const easing = style.getPropertyValue('--ease-theme-reveal').trim()
  if (!Number.isFinite(duration) || duration <= 0) { commitTheme(value); return }
  // A root capture is absent from pointer hit-testing. Leaving this stationary
  // button releases it before the next workspace press. Repeated presses at the
  // same point use only this button's own click path and reverse the same circle.
  const interrupt = () => { if (reveal === current) { commitTheme(requestedTheme); stopReveal() } }
  const insideOrigin = (event: MouseEvent) => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom
  const onPointer = (event: PointerEvent) => { if (event.pointerType !== 'mouse' || !insideOrigin(event)) interrupt() }
  const onClick = (event: MouseEvent) => {
    if (event.target !== root || event.button !== 0 || !insideOrigin(event)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    origin.click()
  }
  const onMotion = () => { if (!canReveal()) interrupt() }
  const releaseMotion = listenMotionChanges(onMotion)
  document.addEventListener('pointermove', onPointer, true)
  document.addEventListener('pointerdown', onPointer, true)
  document.addEventListener('click', onClick, true)
  document.addEventListener('keydown', interrupt, true)
  document.addEventListener('scroll', interrupt, true)
  window.addEventListener('resize', interrupt)
  window.addEventListener('pagehide', interrupt)
  window.addEventListener('popstate', interrupt)
  const current: ThemeReveal = { target:value, origin, release: () => {
    releaseMotion()
    document.removeEventListener('pointermove', onPointer, true)
    document.removeEventListener('pointerdown', onPointer, true)
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('keydown', interrupt, true)
    document.removeEventListener('scroll', interrupt, true)
    window.removeEventListener('resize', interrupt)
    window.removeEventListener('pagehide', interrupt)
    window.removeEventListener('popstate', interrupt)
  } }
  reveal = current
  root.dataset.themeReveal = ''
  try {
    const transition = current.transition = document.startViewTransition(() => {
      if (reveal === current) commitTheme(value)
    })
    void transition.ready.then(() => {
      if (reveal !== current) return
      current.animation = root.animate({ clipPath: [
        `circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`,
      ] }, { duration, easing, fill:'both', pseudoElement: '::view-transition-new(root)' })
    }).catch(() => { if (reveal === current) interrupt() })
    void transition.finished.then(() => { if (reveal === current) stopReveal() }, interrupt)
  } catch { interrupt() }
}

export function useTheme() {
  return {
    theme: readonly(theme), setTheme,
    toggleTheme: (origin?: HTMLElement) => setTheme(requestedTheme === 'dark' ? 'light' : 'dark', origin),
    cancelThemeReveal(origin: HTMLElement | null) {
      if (reveal?.origin !== origin) return
      commitTheme(requestedTheme)
      stopReveal()
    },
  }
}

if (import.meta.hot) import.meta.hot.dispose(() => {
  stopReveal()
  window.removeEventListener('storage', onThemeStorage)
  cancelAnimationFrame(paletteFrame)
  paletteFrame = 0
  initialized = false
  delete document.documentElement.dataset.themeChanging
})
