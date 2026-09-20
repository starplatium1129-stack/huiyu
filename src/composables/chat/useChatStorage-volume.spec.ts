import { afterEach, describe, expect, it } from 'vitest'
import { useChatStorage } from './useChatStorage'
import { CHAT_VOLUME_KEY } from '@/utils/storageKeys'

afterEach(() => localStorage.clear())

describe('chat volume persistence', () => {
  it('mute remains zero after saving and reopening the room', () => {
    const storage = useChatStorage()
    storage.load()
    storage.setVolume(0)
    expect(localStorage.getItem(CHAT_VOLUME_KEY)).toBe('0')
    const restored = useChatStorage()
    restored.load()
    expect(restored.state.settings.volume).toBe(0)
  })

  it('clamps invalid or out-of-range values without replacing valid zero', () => {
    const storage = useChatStorage()
    for (const [input, expected] of [[-10, 0], [120, 100], [NaN, 80], [Infinity, 80], [24.8, 25]]) {
      storage.setVolume(input)
      expect(storage.state.settings.volume).toBe(expected)
    }
  })
})
