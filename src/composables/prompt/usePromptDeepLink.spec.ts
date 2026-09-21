import { describe, expect, it, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import { SCENARIOS, SCENARIO_RES_MAP, substituteScenarioPrompt } from '@/config/scenarios'
import { usePromptDeepLink, type PromptDeepLinkDeps } from './usePromptDeepLink'

describe('history links on a reused workbench', () => {
  it('keeps a rejected busy-workbench link retryable', async () => {
    const record = { id: 42 }
    const applyHistory = vi.fn().mockReturnValueOnce(false)
    const api = usePromptDeepLink({ pb: { history: [record] }, applyHistory } as unknown as PromptDeepLinkDeps)
    expect(await api.applyDeepLink({ regen: '42' })).toBe(false)
    expect(api.deepLinkNeeded({ regen: '42' })).toBe(true)
    expect(await api.applyDeepLink({ regen: '42' })).toBe(true)
    expect(api.deepLinkNeeded({ regen: '42' })).toBe(false)
  })
  it('accepts imported artwork string IDs without coercing them to a number', async () => {
    const record = { id: 'imported-artwork-a' }
    const applyHistory = vi.fn()
    const api = usePromptDeepLink({ pb: { history: [record] }, applyHistory } as unknown as PromptDeepLinkDeps)
    expect(await api.applyDeepLink({ regen: record.id })).toBe(true)
    expect(applyHistory).toHaveBeenCalledWith(record, false)
  })
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
  it.each([{ char: 'natsume' }, { scenario: 'promise', char: 'natsume' }])('leaves a popular subject before applying %j', async query => {
    const pb = { isPopular: true, char: 'nene', story: 'existing draft', manualTags: new Set<string>(),
      setChar(value: string) { this.char = value }, setStory(value: string) { this.story = value }, clearScene: vi.fn(), flash: vi.fn() }
    const selectPopularSource = vi.fn(() => { pb.isPopular = false })
    const api = usePromptDeepLink({ pb, sdSize: ref(''), selectPopularSource } as unknown as PromptDeepLinkDeps)
    await api.applyDeepLink(query)
    expect(selectPopularSource).toHaveBeenCalledExactlyOnceWith('studio')
    expect(pb.char).toBe('natsume')
    expect(pb.isPopular).toBe(false)
    if (!('scenario' in query)) expect(pb.story).toBe('existing draft')
  })
  it.each(['nene', 'natsume', undefined] as const)('applies each story with character %s and preserves unchanged edits', async char => {
    const pb = {
      char: 'natsume', story: 'existing draft', lastRecommendedSize: '', manualTags: new Set<string>(),
      setChar(value: string) { this.char = value },
      setStory(value: string) { this.story = value }, clearScene: vi.fn(), flash: vi.fn(),
    }
    const sdSize = ref('')
    const api = usePromptDeepLink({ pb, sdSize } as unknown as PromptDeepLinkDeps)
    for (const scenario of SCENARIOS) {
      const query = { scenario: scenario.id, ...(char ? { char } : {}) }
      expect(api.deepLinkNeeded(query)).toBe(true)
      expect(await api.applyDeepLink(query)).toBe(true)
      const act = scenario.acts[0]
      expect(pb.char).toBe(char || 'nene')
      expect(pb.story).toBe(`${scenario.name} · ${act.title}：${act.desc}`)
      expect(sdSize.value).toBe(SCENARIO_RES_MAP[act.res].dim.replace('×', 'x'))
      expect(pb.lastRecommendedSize).toBe(sdSize.value)
      expect(pb.clearScene).toHaveBeenCalled()
      expect([...pb.manualTags]).toEqual([...new Set(substituteScenarioPrompt(act.prompt, char || 'nene')
        .split('\n').slice(1).flatMap(line => line.split(',').map(token => token.trim().replace(/[\s-]+/g, '_'))).filter(Boolean))])
      pb.story = 'manual edit after arrival'
      expect(api.deepLinkNeeded(query)).toBe(false)
      expect(pb.story).toBe('manual edit after arrival')
    }
  })
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
