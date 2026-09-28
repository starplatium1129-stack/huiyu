import type { CSSProperties } from 'vue'

/**
 * Runtime character theme resolver.
 *
 * The director used to encode every character as a selector in tokens.css. That
 * made the entry stylesheet grow with the catalogue and made a new character
 * require a CSS edit. These values are the small set of existing, deliberately
 * tuned exceptions; characters without an exception use characters.json's
 * accent_color and CSS derives the remaining tokens from it.
 */
export interface CharacterThemeRecord {
  id?: unknown
  accent_color?: unknown
}

export interface CharacterThemeOverride {
  accent: string
  aura?: string
  auraSecondary?: string
}

/** Existing visual calibrations moved out of the entry stylesheet. */
export type CharacterThemeCatalog = Readonly<Record<string, CharacterThemeOverride>>

export const STUDIO_CHARACTER_THEMES: CharacterThemeCatalog = Object.freeze({
  natsume: { accent: '#fbb040', aura: 'rgba(251,176,64,.30)', auraSecondary: 'rgba(230,120,80,.20)' },
  nene: { accent: '#ff75a0', aura: 'rgba(183,132,246,.28)', auraSecondary: 'rgba(255,117,160,.20)' },
  triad: { accent: '#d9a4ef', aura: 'rgba(216,180,254,.28)', auraSecondary: 'rgba(242,187,104,.18)' },
})

const DEFAULT_THEME: CharacterThemeOverride = Object.freeze({
  accent: '#ff75a0',
  aura: 'rgba(183,132,246,.28)',
  auraSecondary: 'rgba(255,117,160,.20)',
})
const HEX_COLOR = /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i

function recordFor(id: string, records: readonly CharacterThemeRecord[]): CharacterThemeRecord | undefined {
  return records.find(record => String(record?.id || '') === id)
}

function dataAccent(record: CharacterThemeRecord | undefined): string | undefined {
  const value = typeof record?.accent_color === 'string' ? record.accent_color.trim() : ''
  return HEX_COLOR.test(value) ? value : undefined
}

export function resolveCharacterTheme(id: string, records: readonly CharacterThemeRecord[] = [], catalog: CharacterThemeCatalog = STUDIO_CHARACTER_THEMES): CharacterThemeOverride {
  const override = catalog[id] || STUDIO_CHARACTER_THEMES[id]
  const accent = override?.accent || dataAccent(recordFor(id, records)) || DEFAULT_THEME.accent
  return {
    accent,
    aura: override?.aura || `color-mix(in srgb, ${accent} 22%, transparent)`,
    auraSecondary: override?.auraSecondary || `color-mix(in srgb, ${accent} 14%, transparent)`,
  }
}

/** CSS custom properties for the .pb host; derived values stay in CSS syntax. */
export function characterThemeStyle(id: string, records: readonly CharacterThemeRecord[] = [], catalog: CharacterThemeCatalog = STUDIO_CHARACTER_THEMES): CSSProperties {
  const theme = resolveCharacterTheme(id, records, catalog)
  return {
    '--character-accent': theme.accent,
    '--character-accent-hover': `color-mix(in srgb, ${theme.accent} 75%, white)`,
    '--character-soft': `color-mix(in srgb, ${theme.accent} 16%, transparent)`,
    '--character-glow': `color-mix(in srgb, ${theme.accent} 32%, transparent)`,
    '--character-aura': theme.aura || `color-mix(in srgb, ${theme.accent} 22%, transparent)`,
    '--character-aura-secondary': theme.auraSecondary || `color-mix(in srgb, ${theme.accent} 14%, transparent)`,
  } as CSSProperties
}

/** Only the document-level atmosphere needs to escape the .pb subtree. */
export function applyCharacterAtmosphere(id: string, records: readonly CharacterThemeRecord[] = [], catalog: CharacterThemeCatalog = STUDIO_CHARACTER_THEMES): void {
  if (typeof document === 'undefined') return
  const theme = resolveCharacterTheme(id, records, catalog)
  const root = document.documentElement
  root.style.setProperty('--character-aura', theme.aura || `color-mix(in srgb, ${theme.accent} 22%, transparent)`)
  root.style.setProperty('--character-aura-secondary', theme.auraSecondary || `color-mix(in srgb, ${theme.accent} 14%, transparent)`)
}

export function clearCharacterAtmosphere(): void {
  if (typeof document === 'undefined') return
  document.documentElement.style.removeProperty('--character-aura')
  document.documentElement.style.removeProperty('--character-aura-secondary')
}
