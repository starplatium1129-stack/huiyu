import { nextTick, readonly, ref } from 'vue'
import { settingsRepository, THEME_SETTING, type Theme } from '@/storage/settingsRepository'
import { listenMotionChanges, prefersReducedMotion } from '@/utils/motionPreference'
import { cssTimeToMilliseconds } from '@/utils/motionTiming'
import '@/assets/css/theme-motion.css'

function preferredTheme(): Theme { return settingsRepository.get(THEME_SETTING) || 'dark' }
const theme = ref<Theme>(preferredTheme())
// Theme-sensitive artwork must follow the live capture's palette, while the
// control and saved preference already reflect the latest requested state.
const displayTheme = ref(theme.value)
let requestedTheme = theme.value
let initialized = false
let paletteFrame = 0
type ThemeReveal = { target: Theme; origin: HTMLElement; transition?: ViewTransition; animation?: Animation; retarget: () => void; release: () => void }
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

function commitPalette(value: Theme) {
  const root = document.documentElement
  displayTheme.value = value
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
  theme.value = requestedTheme = value
  stopReveal()
  commitPalette(value)
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
  theme.value = requestedTheme = value
  const previous = reveal
  if (previous) {
    if (origin === previous.origin && canReveal() && (!previous.animation || previous.animation.playState === 'running')) {
      // Keep the capture pair while ready is pending too. The new capture is
      // live: changing its palette on reversal would erase the visible circle.
      previous.retarget()
      return
    }
    stopReveal()
    commitPalette(value)
    return
  }
  if (!origin?.isConnected || !canReveal()) { commitPalette(value); return }
  const rect = origin.getBoundingClientRect()
  const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))
  const root = document.documentElement
  const style = getComputedStyle(root)
  const duration = cssTimeToMilliseconds(style.getPropertyValue('--motion-theme-reveal'))
  const easing = style.getPropertyValue('--ease-theme-reveal').trim()
  if (!Number.isFinite(duration) || duration <= 0) { commitPalette(value); return }
  // Let pointer movement leave the button without cutting the reveal short.
  // A new action elsewhere releases the capture; repeated presses on this
  // stationary button reverse the same circle through its own click path.
  const interrupt = () => { if (reveal === current) { commitPalette(requestedTheme); stopReveal() } }
  let from = 0, to = radius
  const circle = (size: number) => `circle(${size}px at ${x}px ${y}px)`
  const retarget = () => {
    const animation = current.animation
    if (!animation) return
    try {
      const effect = animation.effect as KeyframeEffect
      const progress = effect.getComputedTiming().progress ?? 0
      from += (to - from) * progress
      to = requestedTheme === current.target ? radius : 0
      // Preserve the displayed radius, but give each new direction the same
      // authored easing/duration instead of rewinding a shortened ease-out tail.
      effect.setKeyframes({ clipPath: [circle(from), circle(to)] })
      animation.currentTime = 0
      animation.play()
    } catch { interrupt() }
  }
  const insideOrigin = (event: MouseEvent) => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom
  const onPointerDown = (event: PointerEvent) => { if (event.pointerType !== 'mouse' || !insideOrigin(event)) interrupt() }
  const onClick = (event: MouseEvent) => {
    if (event.target !== root || event.button !== 0 || !insideOrigin(event)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    origin.click()
  }
  const onMotion = () => { if (!canReveal()) interrupt() }
  const releaseMotion = listenMotionChanges(onMotion)
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('click', onClick, true)
  document.addEventListener('keydown', interrupt, true)
  document.addEventListener('scroll', interrupt, true)
  window.addEventListener('resize', interrupt)
  window.addEventListener('pagehide', interrupt)
  window.addEventListener('popstate', interrupt)
  const current: ThemeReveal = { target:value, origin, retarget, release: () => {
    releaseMotion()
    document.removeEventListener('pointerdown', onPointerDown, true)
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
      if (reveal === current) commitPalette(current.target)
      return nextTick()
    })
    void transition.ready.then(() => {
      if (reveal !== current) return
      // Nothing has been revealed if the latest press returned to the old theme
      // before capture completed. Do not create a second capture or flash it.
      if (requestedTheme !== current.target) { interrupt(); return }
      current.animation = root.animate({ clipPath: [
        circle(from), circle(to),
      ] }, { duration, easing, fill:'both', pseudoElement: '::view-transition-new(root)' })
      void current.animation.finished.then(interrupt, interrupt)
    }).catch(() => { if (reveal === current) interrupt() })
    void transition.finished.then(interrupt, interrupt)
  } catch { interrupt() }
}

export function useTheme() {
  return {
    theme: readonly(theme), displayTheme: readonly(displayTheme), setTheme,
    toggleTheme: (origin?: HTMLElement) => setTheme(requestedTheme === 'dark' ? 'light' : 'dark', origin),
    cancelThemeReveal(origin: HTMLElement | null) {
      if (reveal?.origin !== origin) return
      commitPalette(requestedTheme)
      stopReveal()
    },
  }
}

if (import.meta.hot) import.meta.hot.dispose(() => {
  commitPalette(requestedTheme)
  stopReveal()
  window.removeEventListener('storage', onThemeStorage)
  cancelAnimationFrame(paletteFrame)
  paletteFrame = 0
  initialized = false
  delete document.documentElement.dataset.themeChanging
})
