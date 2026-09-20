import { nextTick, readonly, ref, watch } from 'vue'
import type { Router } from 'vue-router'
import { useTheme } from './useTheme'
import { THEME_SETTING } from '@/storage/settingsRepository'

type ThemeMode = 'system' | 'dark' | 'light'
type MotionMode = 'system' | 'full' | 'reduce'
export type GlassMode = 'light' | 'liquid'
const KEY = 'atelier-desktop-appearance-v1'
const themeMode = ref<ThemeMode>('system')
const motionMode = ref<MotionMode>('system')
const reducedGlass = ref(false)
const glassMode = ref<GlassMode>('light')
const effectiveGlassMode = ref<GlassMode>('light')
let initialized = false

function save() {
  try { localStorage.setItem(KEY, JSON.stringify({ theme: themeMode.value, motion: motionMode.value, reducedGlass: reducedGlass.value, glass: glassMode.value })) } catch { /* Optional preferences must never block the workspace. */ }
}

export function initializeDesktopPreferences() {
  if (initialized) return
  initialized = true
  const dark = matchMedia('(prefers-color-scheme: dark)')
  const reduce = matchMedia('(prefers-reduced-motion: reduce)')
  const contrast = matchMedia('(prefers-contrast: more)')
  const transparency = matchMedia('(prefers-reduced-transparency: reduce)')
  const forcedColors = matchMedia('(forced-colors: active)')
  const { theme, setTheme } = useTheme()
  let applyingTheme = false
  let reading = false
  function read() {
    reading = true
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || 'null')
      const legacy = localStorage.getItem(THEME_SETTING.key)
      themeMode.value = ['system', 'dark', 'light'].includes(saved?.theme) ? saved.theme : legacy === 'dark' || legacy === 'light' ? legacy : 'system'
      motionMode.value = ['system', 'full', 'reduce'].includes(saved?.motion) ? saved.motion : 'system'
      reducedGlass.value = saved?.reducedGlass === true
      glassMode.value = saved?.glass === 'liquid' ? 'liquid' : 'light'
    } catch { themeMode.value = theme.value; motionMode.value = 'system'; reducedGlass.value = false; glassMode.value = 'light' }
    finally { reading = false }
  }
  function apply() {
    applyingTheme = true
    setTheme(themeMode.value === 'system' ? dark.matches ? 'dark' : 'light' : themeMode.value)
    applyingTheme = false
    const root = document.documentElement
    root.dataset.motion = motionMode.value
    root.dataset.reducedMotion = String(motionMode.value === 'reduce' || motionMode.value === 'system' && reduce.matches)
    const lowGlass = reducedGlass.value || contrast.matches || transparency.matches || forcedColors.matches
    root.dataset.reducedGlass = String(lowGlass)
    root.dataset.fluidEffects = lowGlass ? 'low' : 'full'
    effectiveGlassMode.value = lowGlass ? 'light' : glassMode.value
    root.dataset.glassMaterial = effectiveGlassMode.value
    window.dispatchEvent(new Event('atelier:motion-preference'))
  }
  read(); save(); apply()
  watch([themeMode, motionMode, reducedGlass, glassMode], () => { if (!reading) { save(); apply() } }, { flush: 'sync' })
  // Existing sun/moon controls are an explicit choice and cancel system-following.
  watch(theme, value => { if (!applyingTheme) themeMode.value = value }, { flush: 'sync' })
  for (const query of [dark, reduce, contrast, transparency, forcedColors]) query.addEventListener('change', apply)
  window.addEventListener('storage', event => { if (event.key === KEY || event.key === null) { read(); apply() } })
}

export function useDesktopPreferences() {
  return {
    themeMode: readonly(themeMode), motionMode: readonly(motionMode), reducedGlass: readonly(reducedGlass),
    glassMode: readonly(glassMode), effectiveGlassMode: readonly(effectiveGlassMode),
    setGlassMode(value: GlassMode) { glassMode.value = value === 'liquid' ? 'liquid' : 'light' },
    setThemeMode(value: ThemeMode) { themeMode.value = value },
    setMotionMode(value: MotionMode) { motionMode.value = value },
    setReducedGlass(value: boolean) { reducedGlass.value = value },
  }
}

export function usableFocus(element: HTMLElement | null): element is HTMLElement {
  return !!element?.isConnected && !element.closest('[inert], [hidden], [aria-hidden="true"], [data-hidden="true"]')
    && !element.matches(':disabled') && element.getClientRects().length > 0
    && getComputedStyle(element).visibility !== 'hidden'
}

export function desktopShortcutAllowed(event: KeyboardEvent) {
  return !event.defaultPrevented && !event.isComposing && event.keyCode !== 229 && !event.altKey && !event.metaKey
}

/** Installs local document shortcuts; never registers operating-system hotkeys. */
export function installDesktopInteraction(router: Router) {
  const remembered = new Map<string, { element: HTMLElement; id: string }>()
  let keyboardNavigation = false
  const main = () => document.querySelector<HTMLElement>('.companion-chat-body, .companion-conversation') || document.querySelector<HTMLElement>('main#main, main')
  const nav = () => [...document.querySelectorAll<HTMLElement>('nav[aria-label="主导航"], .control-rail, .control-mobile-nav, .companion-toolbar, .companion-chat-titlebar, .companion-desktop-float')].find(usableFocus)
  const modalOpen = () => [...document.querySelectorAll<HTMLElement>('dialog[open], [aria-modal="true"]')].some(usableFocus)
  function remember(event: FocusEvent) {
    const element = event.target
    if (element instanceof HTMLElement && main()?.contains(element)) remembered.set(router.currentRoute.value.path, { element, id: element.id })
  }
  function contentFocus() {
    const content = main()
    if (!content) return
    const saved = remembered.get(router.currentRoute.value.path)
    const candidate = saved && (usableFocus(saved.element) ? saved.element : saved.id ? document.getElementById(saved.id) : null)
    const heading = [...content.querySelectorAll<HTMLElement>('h1')].reverse().find(usableFocus)
    const target = candidate && content.contains(candidate) && usableFocus(candidate) ? candidate : heading || content
    if (!target.matches('a[href], button, input, select, textarea, [tabindex]')) target.tabIndex = -1
    target.focus({ preventScroll: true })
  }
  function keydown(event: KeyboardEvent) {
    if (!desktopShortcutAllowed(event) || modalOpen()) return
    if (event.key === 'F1' && !event.ctrlKey && !event.shiftKey) {
      if (!nav()) return
      event.preventDefault(); window.dispatchEvent(new Event('atelier:keyboard-help')); return
    }
    if (event.key === 'F6' && !event.ctrlKey) {
      const navigation = nav()
      if (!navigation || !main()) return
      event.preventDefault()
      if (navigation.contains(document.activeElement) || document.activeElement?.closest('.nav-more-menu')) contentFocus()
      else {
        const active = navigation.querySelector<HTMLElement>('[aria-current]')
        const toggle = navigation.querySelector<HTMLElement>('.nav-menu-toggle')
        const brand = [...navigation.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), [tabindex="0"]')].find(usableFocus)
        ;(usableFocus(active) ? active : usableFocus(toggle) ? toggle : brand)?.focus()
      }
    }
    if (event.key === 'Enter' && !event.ctrlKey && !event.shiftKey && event.target instanceof Element && event.target.closest('nav a[href], .nav-more-menu a[href]')) keyboardNavigation = true
  }
  function pointerdown() { keyboardNavigation = false }
  const removeAfter = router.afterEach(async (_to, _from, failure) => {
    const restore = keyboardNavigation; keyboardNavigation = false
    if (failure || !restore) return
    await nextTick()
    requestAnimationFrame(() => { if (!modalOpen()) contentFocus() })
  })
  document.addEventListener('focusin', remember)
  document.addEventListener('keydown', keydown)
  document.addEventListener('pointerdown', pointerdown)
  return () => {
    removeAfter()
    document.removeEventListener('focusin', remember)
    document.removeEventListener('keydown', keydown)
    document.removeEventListener('pointerdown', pointerdown)
  }
}
