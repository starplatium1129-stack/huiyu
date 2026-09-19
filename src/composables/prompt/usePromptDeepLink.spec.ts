import { describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { usePromptDeepLink, type PromptDeepLinkDeps } from './usePromptDeepLink'

describe('history links on a reused workbench', () => {
  it('loads a new record and does not overwrite edits for an unchanged link', async () => {
    const record = { id: 42 }
    const pb = { history: [] as { id: number }[], loadHistory: vi.fn(async () => { pb.history = [record] }) }
    const applyHistory = vi.fn()
    const api = usePromptDeepLink({ pb, applyHistory } as unknown as PromptDeepLinkDeps)
    expect(api.deepLinkNeeded({ regen: '42' })).toBe(true)
    expect(await api.applyDeepLink({ regen: '42' })).toBe(true)
    expect(pb.loadHistory).toHaveBeenCalledOnce()
    expect(applyHistory).toHaveBeenCalledWith(record, false)
    expect(api.deepLinkNeeded({ regen: '42' })).toBe(false)
    expect(api.deepLinkNeeded({ regen: '43' })).toBe(true)
    api.deepLinkNeeded({})
    expect(api.deepLinkNeeded({ regen: '42' })).toBe(true)
  })
  it('does not apply a delayed history result after the workbench is disposed', async () => {
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const pb = { history: [] as { id: number }[], loadHistory: async () => { await waiting; pb.history = [{ id: 9 }] } }
    const applyHistory = vi.fn()
    const scope = effectScope()
    const api = scope.run(() => usePromptDeepLink({ pb, applyHistory } as unknown as PromptDeepLinkDeps))!
    const result = api.applyDeepLink({ regen: '9' })
    scope.stop()
    release()
    expect(await result).toBe(false)
    expect(applyHistory).not.toHaveBeenCalled()
  })

})

describe('context links on a reused workbench', () => {
  it('replays mood-only changes and does not replay an unchanged link over manual edits', async () => {
    const scene = { id: 'scene-a' }
    const pb = {
      history: [], scenes: [scene], sceneId: 'scene-a', char: 'nene', colorMood: 'calm',
      subject: { kind: 'studio' },
      setColorMood: vi.fn((value: string) => { pb.colorMood = value }),
    }
    const selectScene = vi.fn((value: typeof scene) => { pb.sceneId = value.id })
    const api = usePromptDeepLink({ pb, selectScene } as unknown as PromptDeepLinkDeps)
    const first = { scene: 'scene-a', mood: 'love' }
    expect(api.deepLinkNeeded(first)).toBe(true)
    expect(await api.applyDeepLink(first)).toBe(true)
    expect(pb.colorMood).toBe('love')
    expect(api.deepLinkNeeded(first)).toBe(false)
    const next = { scene: 'scene-a', mood: 'sad' }
    expect(api.deepLinkNeeded(next)).toBe(true)
    expect(await api.applyDeepLink(next)).toBe(true)
    expect(pb.colorMood).toBe('sad')
  })
})
