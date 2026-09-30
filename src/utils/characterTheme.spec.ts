import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  applyCharacterAtmosphere,
  characterThemeStyle,
  clearCharacterAtmosphere,
  resolveCharacterTheme,
  STUDIO_CHARACTER_THEMES,
} from './characterTheme'
import { POPULAR_CHARACTER_THEMES } from './characterThemeCatalog'

afterEach(() => clearCharacterAtmosphere())

describe('characterTheme', () => {
  it('preserves all 162 calibrated theme and CSS outputs from the pre-split catalog', () => {
    const ids = Object.keys({ ...STUDIO_CHARACTER_THEMES, ...POPULAR_CHARACTER_THEMES }).sort()
    const values = ids.map(id => [id, resolveCharacterTheme(id, [], POPULAR_CHARACTER_THEMES), characterThemeStyle(id, [], POPULAR_CHARACTER_THEMES)])
    expect(ids).toHaveLength(162)
    expect(createHash('sha256').update(JSON.stringify(values)).digest('hex')).toBe('936448b91d9495813f8d9acd07054da875c8c14fde0c0a6f30ee951790307ab7')
  })
  it('keeps a tuned character palette while exposing derived custom properties', () => {
    const theme = resolveCharacterTheme('natsume', [])
    const style = characterThemeStyle('natsume', []) as Record<string, string>

    expect(theme.accent).toBe('#fbb040')
    expect(theme.aura).toBe('rgba(251,176,64,.30)')
    expect(style['--character-accent']).toBe('#fbb040')
    expect(style['--character-soft']).toContain('16%')
  })

  it('uses a valid data accent for a character without a tuned override', () => {
    const records = [{ id: 'new_character', accent_color: '#123abc' }]
    const theme = resolveCharacterTheme('new_character', records)
    const style = characterThemeStyle('new_character', records) as Record<string, string>

    expect(theme.accent).toBe('#123abc')
    expect(style['--character-accent-hover']).toContain('#123abc')
    expect(style['--character-aura']).toContain('22%')
  })

  it('sets and clears atmosphere document tokens', () => {
    applyCharacterAtmosphere('natsume')
    expect(document.documentElement.style.getPropertyValue('--character-aura')).toBe('rgba(251,176,64,.30)')
    clearCharacterAtmosphere()
    expect(document.documentElement.style.getPropertyValue('--character-aura')).toBe('')
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
