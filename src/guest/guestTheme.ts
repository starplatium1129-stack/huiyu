import { readonly, ref } from 'vue'

export type GuestTheme = 'light' | 'dark'

const STORAGE_KEY = 'huiyu.guest.color-scheme'
const lightQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-color-scheme: light)')
  : null

const theme = ref<GuestTheme>('dark')
const isOverridden = ref(false)
let initialized = false

function systemScheme(): GuestTheme {
  return lightQuery?.matches ? 'light' : 'dark'
}

function readStoredScheme(): GuestTheme | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw === 'light' || raw === 'dark' ? raw : null
  } catch {
    return null
  }
}

function writeStoredScheme(value: GuestTheme | null) {
  try {
    if (value) localStorage.setItem(STORAGE_KEY, value)
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Blocked browser storage still leaves the active session switchable.
  }
}

function applyResolvedScheme() {
  const stored = readStoredScheme()
  const resolved = stored ?? systemScheme()
  theme.value = resolved
  isOverridden.value = stored !== null
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = resolved
    document
      .querySelector<HTMLMetaElement>('meta[name="color-scheme"]')
      ?.setAttribute('content', stored ?? 'light dark')
  }
}

function onStorage(event: StorageEvent) {
  if (event.key === STORAGE_KEY || event.key === null) applyResolvedScheme()
}

export function initGuestTheme() {
  applyResolvedScheme()
  if (initialized || typeof window === 'undefined') return
  initialized = true
  lightQuery?.addEventListener('change', applyResolvedScheme)
  window.addEventListener('storage', onStorage)
}

export function toggleGuestTheme() {
  const next: GuestTheme = theme.value === 'dark' ? 'light' : 'dark'
  writeStoredScheme(next === systemScheme() ? null : next)
  applyResolvedScheme()
}

export function useGuestTheme() {
  return {
    theme: readonly(theme),
    isOverridden: readonly(isOverridden),
    toggleTheme: toggleGuestTheme,
  }
}
