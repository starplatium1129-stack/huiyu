import { profileLocalStorage as localStorage } from '../platform/web/profileStorage.ts'
import { nextTick, readonly, ref, watch } from 'vue'
import type { Router } from 'vue-router'
import { applyTheme, useTheme } from './useTheme'
import { THEME_SETTING } from '@/storage/settingsRepository'

type ThemeMode = 'system' | 'dark' | 'light'
export type ThemeStyle = 'atelier' | 'terraria'
export type ThemePalette = 'default' | 'yozakura'
type MotionMode = 'system' | 'full' | 'reduce'
export type GlassMode = 'light' | 'liquid'
const KEY = 'atelier-desktop-appearance-v1'
const themeMode = ref<ThemeMode>('system')
const themeStyle = ref<ThemeStyle>('atelier')
const themePalette = ref<ThemePalette>('default')
const motionMode = ref<MotionMode>('system')
const reducedGlass = ref(false)
const glassMode = ref<GlassMode>('light')
const glassTint = ref(35)
const effectiveGlassMode = ref<GlassMode>('light')
let initialized = false
let lastAppearance: string | null | undefined

function save() {
  lastAppearance = undefined
  try { localStorage.setItem(KEY, JSON.stringify({ theme: themeMode.value, style: themeStyle.value, palette: themePalette.value, motion: motionMode.value, reducedGlass: reducedGlass.value, glass: glassMode.value, glassTint: glassTint.value })) } catch { /* Optional preferences must never block the workspace. */ }
}
function normalizedGlassTint(value: unknown) { return typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.max(0, Math.min(100, value))) : 35 }

function loadThemeStyle() {
  if (themeStyle.value === 'terraria') return Promise.all([
    import('@/assets/css/terraria-theme.css'),
    import('@/assets/css/terraria-surfaces.css'),
  ]).catch(error => console.warn('像素主题样式加载失败，可刷新后重试', error))
}

export function initializeDesktopPreferences() {
  if (initialized) return loadThemeStyle()
  initialized = true
  const dark = matchMedia('(prefers-color-scheme: dark)')
  const reduce = matchMedia('(prefers-reduced-motion: reduce)')
  const contrast = matchMedia('(prefers-contrast: more)')
  const transparency = matchMedia('(prefers-reduced-transparency: reduce)')
  const forcedColors = matchMedia('(forced-colors: active)')
  const { theme } = useTheme()
  let applyingTheme = false
  let reading = false
  let lastLegacy: string | null | undefined
  function read() {
    reading = true
    try {
      const raw = localStorage.getItem(KEY)
      const legacy = localStorage.getItem(THEME_SETTING.key)
      if (raw === lastAppearance && legacy === lastLegacy) return false
      lastAppearance = raw
      lastLegacy = legacy
      const saved = JSON.parse(raw || 'null')
      themeMode.value = ['system', 'dark', 'light'].includes(saved?.theme) ? saved.theme : legacy === 'dark' || legacy === 'light' ? legacy : 'system'
      themeStyle.value = saved?.style === 'terraria' ? 'terraria' : 'atelier'
      themePalette.value = saved?.palette === 'yozakura' ? 'yozakura' : 'default'
      motionMode.value = ['system', 'full', 'reduce'].includes(saved?.motion) ? saved.motion : 'system'
      reducedGlass.value = saved?.reducedGlass === true
      glassMode.value = saved?.glass === 'liquid' ? 'liquid' : 'light'
      glassTint.value = normalizedGlassTint(saved?.glassTint)
    } catch { themeMode.value = theme.value; themeStyle.value = 'atelier'; themePalette.value = 'default'; motionMode.value = 'system'; reducedGlass.value = false; glassMode.value = 'light'; glassTint.value = 35 }
    finally { reading = false }
    return true
  }
  function apply() {
    const palette = themeMode.value === 'system' ? dark.matches ? 'dark' : 'light' : themeMode.value
    applyingTheme = true
    if (theme.value !== palette) applyTheme(palette)
    applyingTheme = false
    const root = document.documentElement
    const reduced = String(motionMode.value === 'reduce' || motionMode.value === 'system' && reduce.matches)
    const motionChanged = root.dataset.motion !== motionMode.value || root.dataset.reducedMotion !== reduced
    if (root.dataset.themeStyle !== themeStyle.value) root.dataset.themeStyle = themeStyle.value
    const nextPalette = themeStyle.value === 'atelier' && themePalette.value === 'yozakura' ? 'yozakura' : ''
    if ((root.dataset.themePalette || '') !== nextPalette) {
      if (nextPalette) root.dataset.themePalette = nextPalette
      else delete root.dataset.themePalette
    }
    if (motionChanged) {
      root.dataset.motion = motionMode.value
      root.dataset.reducedMotion = reduced
    }
    const lowGlass = themeStyle.value === 'terraria' || reducedGlass.value || contrast.matches || transparency.matches || forcedColors.matches
    if (root.dataset.reducedGlass !== String(lowGlass)) root.dataset.reducedGlass = String(lowGlass)
    const effects = lowGlass ? 'low' : 'full'
    if (root.dataset.fluidEffects !== effects) root.dataset.fluidEffects = effects
    effectiveGlassMode.value = lowGlass ? 'light' : glassMode.value
    if (root.dataset.glassMaterial !== effectiveGlassMode.value) root.dataset.glassMaterial = effectiveGlassMode.value
    root.style.setProperty('--glass-tint', String(glassTint.value / 100))
    if (motionChanged) window.dispatchEvent(new Event('atelier:motion-preference'))
    return loadThemeStyle()
  }
  read()
  const appearanceReady = apply()
  watch([themeMode, themeStyle, themePalette, motionMode, reducedGlass, glassMode], () => { if (!reading) { save(); apply() } }, { flush: 'sync' })
  // Tint previews only change CSS; avoid resaving the theme and notifying every motion consumer per slider step.
  watch(glassTint, value => {
    if (!reading) { save(); document.documentElement.style.setProperty('--glass-tint', String(value / 100)) }
  }, { flush: 'sync' })
  // Existing sun/moon controls are an explicit choice and cancel system-following.
  watch(theme, value => { if (!applyingTheme) themeMode.value = value }, { flush: 'sync' })
  for (const query of [dark, reduce, contrast, transparency, forcedColors]) query.addEventListener('change', apply)
  function syncAppearance() { if (read()) apply() }
  window.addEventListener('storage', event => { if (event.key === KEY || event.key === null) syncAppearance() })
  window.addEventListener('huiyu:profile-sync-complete', syncAppearance)
  return appearanceReady
}

export function useDesktopPreferences() {
  return {
    themeMode: readonly(themeMode), themeStyle: readonly(themeStyle), themePalette: readonly(themePalette), motionMode: readonly(motionMode), reducedGlass: readonly(reducedGlass),
    glassMode: readonly(glassMode), effectiveGlassMode: readonly(effectiveGlassMode), glassTint: readonly(glassTint),
    setGlassMode(value: GlassMode) { glassMode.value = value === 'liquid' ? 'liquid' : 'light' },
    setGlassTint(value: number) { glassTint.value = normalizedGlassTint(value) },
    setThemeMode(value: ThemeMode) { themeMode.value = value },
    setThemeStyle(value: ThemeStyle) { themeStyle.value = value === 'terraria' ? 'terraria' : 'atelier' },
    setThemePalette(value: ThemePalette) { themePalette.value = value === 'yozakura' ? 'yozakura' : 'default' },
    setMotionMode(value: MotionMode) { motionMode.value = value },
    setReducedGlass(value: boolean) { reducedGlass.value = value },
  }
}

function usableFocus(element: HTMLElement | null): element is HTMLElement {
  return !!element?.isConnected && !element.closest('[inert], [hidden], [aria-hidden="true"], [data-hidden="true"]')
    && !element.matches(':disabled') && element.getClientRects().length > 0
    && getComputedStyle(element).visibility !== 'hidden'
}

/** A menu entry may unmount while the appearance panel loads or closes. */
export function appearanceFocusOrigin(trigger: HTMLElement | null) {
  // F1 can start with body focused. It has a box, but cannot receive return focus.
  return trigger !== document.body && trigger !== document.documentElement && usableFocus(trigger) ? trigger : [...document.querySelectorAll<HTMLElement>(
    '.nav-more-trigger, .nav-menu-toggle, .companion-settings-btn, .orbit-settings-trigger, .appearance-button',
  )].find(usableFocus) ?? null
}

export function desktopShortcutAllowed(event: KeyboardEvent) {
  return !event.defaultPrevented && !event.isComposing && event.keyCode !== 229 && !event.altKey && !event.metaKey
}

/** Installs local document shortcuts; never registers operating-system hotkeys. */
export function installDesktopInteraction(router: Router) {
  const remembered = new Map<string, { element: WeakRef<HTMLElement>; id: string }>()
  let keyboardNavigation = false, disposed = false, focusRevision = 0
  let focusFrame: number | undefined
  function cancelPendingFocus() {
    focusRevision++
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
    focusFrame = undefined
  }
  const main = () => document.getElementById('main') ?? document.querySelector<HTMLElement>('.companion-chat-body,.companion-conversation') ?? document.querySelector<HTMLElement>('main')
  const nav = () => document.querySelector<HTMLElement>('.companion-orbit') || [...document.querySelectorAll<HTMLElement>('nav[aria-label="主导航"], .control-rail, .control-mobile-nav, .companion-toolbar, .companion-chat-titlebar, .companion-desktop-float')].find(usableFocus)
  const modalOpen = () => [...document.querySelectorAll<HTMLElement>('dialog[open], [aria-modal="true"]')].some(usableFocus)
  function remember(event: FocusEvent) {
    const element = event.target
    if (element instanceof HTMLElement && main()?.contains(element)) remembered.set(router.currentRoute.value.path, { element: new WeakRef(element), id: element.id })
  }
  function contentFocus() {
    const content = main()
    if (!content) return
    const saved = remembered.get(router.currentRoute.value.path)
    const previous = saved?.element.deref() ?? null
    const candidate = usableFocus(previous) ? previous : saved?.id ? document.getElementById(saved.id) : null
    const heading = [...content.querySelectorAll<HTMLElement>('h1')].reverse().find(usableFocus)
    const target = candidate && content.contains(candidate) && usableFocus(candidate) ? candidate : heading || content
    if (!target.matches('a[href],button,input,select,textarea,[tabindex]')) target.tabIndex = -1
    target.focus({ preventScroll: true })
  }
  function keydown(event: KeyboardEvent) {
    // Ordinary typing and local navigation do not need a document-wide modal scan.
    if (event.key !== 'F1' && event.key !== 'F6' && event.key !== 'Enter') return
    if (event.ctrlKey || !desktopShortcutAllowed(event) || modalOpen()) return
    if (event.key === 'F1' && !event.shiftKey) {
      if (!nav()) return
      event.preventDefault(); window.dispatchEvent(new Event('atelier:keyboard-help')); return
    }
    if (event.key === 'F6') {
      const navigation = nav()
      if (!navigation || !main()) return
      event.preventDefault()
      if (navigation.contains(document.activeElement) || document.activeElement?.closest('.nav-more-menu')) contentFocus()
      else {
        const active = navigation.querySelector<HTMLElement>('[aria-current]')
        const toggle = navigation.querySelector<HTMLElement>('.nav-menu-toggle')
        const brand = [...navigation.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), [tabindex="0"]')].find(usableFocus)
        ;(usableFocus(active) ? active : usableFocus(toggle) ? toggle : brand)?.focus({ preventScroll: true })
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && event.target instanceof Element) {
      const anchor = event.target.closest('a[href]')
      keyboardNavigation = !!(anchor && (nav()?.contains(anchor) || anchor.closest('.nav-more-menu,[data-route-focus]')))
    }
  }
  function pointerdown() { keyboardNavigation = false; cancelPendingFocus() }
  const removeAfter = router.afterEach(async (to, from, failure) => {
    const restore = keyboardNavigation; keyboardNavigation = false
    cancelPendingFocus()
    const revision = focusRevision
    // Same-page anchors and selection changes keep their local focus owner.
    if (disposed || failure || !restore || to.path === from.path) return
    await nextTick()
    if (disposed || revision !== focusRevision) return
    focusFrame = requestAnimationFrame(() => {
      if (disposed || revision !== focusRevision) return
      focusFrame = undefined
      if (!modalOpen()) contentFocus()
    })
  })
  document.addEventListener('focusin', remember)
  document.addEventListener('keydown', keydown)
  document.addEventListener('pointerdown', pointerdown)
  return () => {
    disposed = true
    cancelPendingFocus()
    remembered.clear()
    removeAfter()
    document.removeEventListener('focusin', remember)
    document.removeEventListener('keydown', keydown)
    document.removeEventListener('pointerdown', pointerdown)
  }
}
