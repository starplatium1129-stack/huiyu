import { afterEach, describe, expect, it } from 'vitest'
import { useChatStorage } from './useChatStorage'

afterEach(() => localStorage.clear())

describe('chat volume persistence', () => {

  it('clamps invalid or out-of-range values without replacing valid zero', () => {
    const storage = useChatStorage()
    for (const [input, expected] of [[-10, 0], [120, 100], [NaN, 80], [Infinity, 80], [24.8, 25]]) {
      storage.setVolume(input)
      expect(storage.state.settings.volume).toBe(expected)
    }
  })
})
