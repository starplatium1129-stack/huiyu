import { afterEach, describe, expect, it } from 'vitest'
import {
  applyCharacterAtmosphere,
  characterThemeStyle,
  clearCharacterAtmosphere,
  resolveCharacterTheme,
} from './characterTheme'

afterEach(() => clearCharacterAtmosphere())

describe('characterTheme', () => {
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

  it('rejects malformed data colors and scopes atmosphere cleanup to document tokens', () => {
    expect(resolveCharacterTheme('new_character', [{ id: 'new_character', accent_color: 'url(//bad)' }]).accent).toBe('#ff75a0')
    applyCharacterAtmosphere('natsume')
    expect(document.documentElement.style.getPropertyValue('--character-aura')).toBe('rgba(251,176,64,.30)')
    clearCharacterAtmosphere()
    expect(document.documentElement.style.getPropertyValue('--character-aura')).toBe('')
  })
})
