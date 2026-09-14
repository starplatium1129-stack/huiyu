import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { desktopShortcutAllowed, initializeDesktopPreferences, installDesktopInteraction, useDesktopPreferences } from './useDesktopInteraction'
import { useTheme } from './useTheme'

describe('desktop interaction', () => {
  let dispose: (() => void) | undefined
  beforeEach(() => {
    document.body.innerHTML = '<nav aria-label="主导航"><a href="/a" aria-current="page">A</a><a href="/b">B</a><button class="appearance-entry">外观</button></nav><main id="main" tabindex="-1"><h1>页面</h1><input id="draft"></main>'
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList)
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { callback(0); return 1 })
  })
  afterEach(() => { dispose?.(); dispose = undefined; document.body.innerHTML = ''; vi.restoreAllMocks() })
  async function setup() {
    const router = createRouter({ history: createMemoryHistory(), routes: ['/a', '/b'].map(path => ({ path, component: {} })) })
    await router.push('/a')
    dispose = installDesktopInteraction(router)
    return router
  }
  function key(key: string, options: KeyboardEventInit = {}) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })
    ;(document.activeElement || document).dispatchEvent(event)
    return event
  }
  it('switches regions with F6 and restores the last usable content control', async () => {
    await setup()
    const input = document.querySelector<HTMLInputElement>('input')!
    input.focus()
    expect(key('F6').defaultPrevented).toBe(true)
    expect(document.activeElement?.tagName).toBe('A')
    key('F6', { shiftKey: true })
    expect(document.activeElement).toBe(input)
  })
  it('leaves input composition, editing combinations and modal forms alone', async () => {
    await setup()
    const input = document.querySelector<HTMLInputElement>('input')!
    input.focus()
    expect(key('F6', { isComposing: true }).defaultPrevented).toBe(false)
    expect(key('F6', { ctrlKey: true }).defaultPrevented).toBe(false)
    expect(key('z', { ctrlKey: true }).defaultPrevented).toBe(false)
    document.body.insertAdjacentHTML('beforeend', '<div aria-modal="true">编辑中</div>')
    expect(key('F6').defaultPrevented).toBe(false)
    expect(key('F1').defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(input)
  })
  it('restores keyboard page focus and falls back when a saved field becomes disabled', async () => {
    const router = await setup()
    const input = document.querySelector<HTMLInputElement>('input')!
    const link = document.querySelector<HTMLAnchorElement>('nav a')!
    input.focus()
    link.focus(); key('Enter'); await router.push('/b')
    expect(document.activeElement?.tagName).toBe('H1')
    link.focus(); key('Enter'); await router.push('/a')
    expect(document.activeElement).toBe(input)
    input.disabled = true
    link.focus(); key('F6')
    expect(document.activeElement?.tagName).toBe('H1')
  })
  it('does not steal focus for pointer navigation or background route updates', async () => {
    const router = await setup()
    const link = document.querySelector<HTMLAnchorElement>('nav a')!
    link.focus()
    await router.push('/b')
    expect(document.activeElement).toBe(link)
  })
  it('supports independent control and companion chat regions', async () => {
    await setup()
    for (const [navigation, content] of [['control-rail', 'control-shell'], ['companion-chat-titlebar', 'companion-chat-body']]) {
      document.body.innerHTML = `<header class="${navigation}"><button>操作</button></header><main class="${content}"><input></main>`
      const input = document.querySelector<HTMLInputElement>('input')!
      input.focus(); key('F6')
      expect(document.activeElement?.tagName).toBe('BUTTON')
      key('F6')
      expect(document.activeElement).toBe(input)
    }
  })
  it('opens help only for an unmodified local F1', async () => {
    await setup()
    const help = vi.fn()
    window.addEventListener('atelier:keyboard-help', help)
    key('F1', { altKey: true }); key('F1', { metaKey: true }); key('F1')
    expect(help).toHaveBeenCalledTimes(1)
    window.removeEventListener('atelier:keyboard-help', help)
    const consumed = new KeyboardEvent('keydown', { cancelable: true }); consumed.preventDefault()
    expect(desktopShortcutAllowed(consumed)).toBe(false)
  })
})

it('applies explicit appearance choices and keeps the legacy theme toggle authoritative', () => {
  localStorage.clear()
  const queries = new Map<string, MediaQueryList>()
  vi.spyOn(window, 'matchMedia').mockImplementation(query => {
    const media = Object.assign(new EventTarget(), { matches: query.includes('reduced-motion'), media: query, onchange: null, addListener() {}, removeListener() {} }) as MediaQueryList
    queries.set(query, media)
    return media
  })
  initializeDesktopPreferences()
  const preferences = useDesktopPreferences()
  expect(preferences.themeMode.value).toBe('system')
  expect(document.documentElement.dataset.reducedMotion).toBe('true')
  preferences.setMotionMode('full')
  expect(document.documentElement.dataset.reducedMotion).toBe('false')
  preferences.setMotionMode('reduce')
  expect(document.documentElement.dataset.reducedMotion).toBe('true')
  preferences.setReducedGlass(true)
  expect(document.documentElement.dataset.fluidEffects).toBe('low')
  useTheme().setTheme('dark')
  expect(preferences.themeMode.value).toBe('dark')
  preferences.setThemeMode('system')
  const dark = queries.get('(prefers-color-scheme: dark)')!
  Object.defineProperty(dark, 'matches', { value: true })
  dark.dispatchEvent(new Event('change'))
  expect(useTheme().theme.value).toBe('dark')
  expect(preferences.themeMode.value).toBe('system')
  vi.restoreAllMocks()
})
