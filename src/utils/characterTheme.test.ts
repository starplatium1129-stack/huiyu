import { describe, expect, it } from 'vitest'
import { resolveCharacterTheme } from './characterTheme'

describe('character theme data boundary', () => {
  it('uses data for ordinary characters and preserves calibrated overrides', () => {
    expect(resolveCharacterTheme('new-character', [{ id: 'new-character', accent_color: '#123456' }]).accent).toBe('#123456')
    expect(resolveCharacterTheme('furina', [{ id: 'furina', accent_color: '#123456' }]).accent).toBe('#38bdf8')
  })

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
