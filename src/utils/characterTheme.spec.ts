import { afterEach, describe, expect, it } from 'vitest'
import {
  applyCharacterAtmosphere,
  characterThemeStyle,
  clearCharacterAtmosphere,
  resolveCharacterTheme,
  STUDIO_CHARACTER_THEMES,
} from './characterTheme'

afterEach(() => clearCharacterAtmosphere())

describe('characterTheme', () => {
  it('keeps a tuned character palette while exposing derived custom properties', () => {
    const records = [{ id: 'natsume', accent_color: '#123abc' }]
    const theme = resolveCharacterTheme('natsume', records)
    const style = characterThemeStyle('natsume', records) as Record<string, string>

    expect(theme).toEqual(STUDIO_CHARACTER_THEMES.natsume)
    expect(style['--character-accent']).toBe(theme.accent)
    expect(style['--character-soft']).toContain(theme.accent)
  })

  it('uses a valid data accent for a character without a tuned override', () => {
    const records = [{ id: 'new_character', accent_color: '#123abc' }]
    const theme = resolveCharacterTheme('new_character', records)
    const style = characterThemeStyle('new_character', records) as Record<string, string>

    expect(theme.accent).toBe('#123abc')
    expect(style['--character-accent-hover']).toContain('#123abc')
    expect(style['--character-aura']).toContain(theme.accent)
  })

  it('sets and clears atmosphere document tokens', () => {
    applyCharacterAtmosphere('natsume')
    const theme = resolveCharacterTheme('natsume')
    expect(document.documentElement.style.getPropertyValue('--character-aura')).toBe(theme.aura)
    expect(document.documentElement.style.getPropertyValue('--character-aura-secondary')).toBe(theme.auraSecondary)
    clearCharacterAtmosphere()
    expect(document.documentElement.style.getPropertyValue('--character-aura')).toBe('')
    expect(document.documentElement.style.getPropertyValue('--character-aura-secondary')).toBe('')
  })
})

describe('character theme data boundary', () => {
  it('falls back for missing and malformed colors, including invalid hex lengths', () => {
    const fallback = resolveCharacterTheme('').accent
    for (const accent_color of [undefined, '', '#12345', '#1234567', 'red', 'url(test)']) {
      expect(resolveCharacterTheme('new-character', [{ id: 'new-character', accent_color }]).accent).toBe(fallback)
    }
  })

  it('accepts every CSS hexadecimal color length', () => {
    for (const accent_color of ['#123', '#1234', '#123456', '#12345678']) {
      expect(resolveCharacterTheme('new-character', [{ id: 'new-character', accent_color }]).accent).toBe(accent_color)
    }
  })
})
