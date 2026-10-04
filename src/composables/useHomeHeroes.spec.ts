import { effectScope, nextTick, type EffectScope } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { maintenanceApi } from '@/api/maintenanceApi'
import { confirmAction } from '@/composables/useConfirm'
import { setRuntimeOrigin } from '@/platform/runtimeUrl'
import type { HomeHeroManifestResult } from '@/types/api'
import { useHomeHeroes } from './useHomeHeroes'
import { useSceneShowcaseUpload } from './scene/useSceneShowcaseUpload'

vi.mock('@/api/maintenanceApi', () => ({
  maintenanceApi: { getHomeHero: vi.fn(), resetHomeHero: vi.fn() }, maintenanceFailure: () => null,
}))
vi.mock('@/composables/useConfirm', () => ({ confirmAction: vi.fn() }))
const empty = (): HomeHeroManifestResult => ({ ok: true, version: 1, entries: {} })
const uploaded = (): HomeHeroManifestResult => ({ ok: true, version: 2, entries: {
  nene: { image: '/scene-showcase/home/nene.jpg?v=2', updatedAt: '2026-09-28T12:00:00Z', source: 'upload' },
} })
const scopes: EffectScope[] = []
function scoped<T>(setup: () => T): T {
  const scope = effectScope(); scopes.push(scope)
  return scope.run(setup)!
}
beforeEach(() => {
  vi.mocked(maintenanceApi.getHomeHero).mockResolvedValue(empty())
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ entries: [] }) }))
})
afterEach(() => {
  scopes.splice(0).forEach(scope => scope.stop())
  setRuntimeOrigin(null)
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})

describe('home and maintenance hero sources', () => {
  it('uses current bundled covers for both characters despite legacy showcase entries', async () => {
    const legacy = uploaded(); delete legacy.entries.nene!.source
    vi.mocked(maintenanceApi.getHomeHero).mockResolvedValue(legacy)
    const { heroes } = scoped(useHomeHeroes)
    await flushPromises()
    for (const id of ['nene', 'natsume'] as const) {
      expect(heroes.value[id].image).toBe(`/assets/characters/${id}-home-cg-1024.webp`)
      expect(heroes.value[id].updatedAt).toBe('')
    }
  })

  it('refreshes an explicit upload and returns to the bundled cover after reset', async () => {
    const home = scoped(useHomeHeroes)
    const maintenance = scoped(() => useSceneShowcaseUpload({ errorMessage: String }))
    await flushPromises()
    vi.mocked(maintenanceApi.getHomeHero).mockResolvedValue(uploaded())
    await Promise.all([home.reload(), maintenance.loadHomeHeroes()])
    maintenance.previewHero(maintenance.homeHeroes.value[0])
    expect(maintenance.heroUrl.value).toBe(home.heroes.value.nene.image)
    expect(maintenance.heroUrl.value).toContain('/scene-showcase/home/nene.jpg?v=2')
    vi.mocked(confirmAction).mockResolvedValue(true)
    vi.mocked(maintenanceApi.resetHomeHero).mockResolvedValue({ ok: true, character: 'nene', action: 'reset', backup: 'fixture' })
    vi.mocked(maintenanceApi.getHomeHero).mockResolvedValue(empty())
    await maintenance.resetHero()
    await home.reload()
    expect(maintenance.heroUrl.value).toBe('/assets/characters/nene-home-cg-1024.webp')
    expect(maintenance.heroUrl.value).toBe(home.heroes.value.nene.image)
    expect(maintenance.homeHeroes.value[0].updatedAt).toBe('')
  })

  it('keeps the confirmed character even if selection changes while confirmation is pending', async () => {
    let confirm!: (value: boolean) => void
    vi.mocked(confirmAction).mockReturnValue(new Promise(resolve => { confirm = resolve }))
    vi.mocked(maintenanceApi.resetHomeHero).mockResolvedValue({ ok: true, character: 'nene', action: 'reset', backup: 'fixture' })
    const maintenance = scoped(() => useSceneShowcaseUpload({ errorMessage: String }))
    await flushPromises()
    maintenance.previewHero(maintenance.homeHeroes.value[0])
    const pending = maintenance.resetHero()
    maintenance.previewHero(maintenance.homeHeroes.value[1])
    confirm(true); await pending
    expect(maintenanceApi.resetHomeHero).toHaveBeenCalledWith('nene', { signal: expect.any(AbortSignal) })
  })

  it('reports a successful reset separately from a failed preview refresh', async () => {
    const maintenance = scoped(() => useSceneShowcaseUpload({ errorMessage: String }))
    await flushPromises()
    maintenance.previewHero(maintenance.homeHeroes.value[0])
    vi.mocked(confirmAction).mockResolvedValue(true)
    vi.mocked(maintenanceApi.resetHomeHero).mockResolvedValue({ ok: true, character: 'nene', action: 'reset', backup: 'fixture' })
    vi.mocked(maintenanceApi.getHomeHero).mockRejectedValue(new Error('offline'))
    await maintenance.resetHero()
    expect(maintenance.showcaseFeedback.value).toContain('已恢复内置图，但预览未能刷新')
    expect(maintenance.showcaseError.value).toBe(true)
  })

  it('rejects stale responses and cancels pending reads on disposal', async () => {
    let finishOld!: (value: HomeHeroManifestResult) => void
    vi.mocked(maintenanceApi.getHomeHero).mockReturnValueOnce(new Promise(resolve => { finishOld = resolve }))
    const { heroes, reload } = scoped(useHomeHeroes)
    const oldSignal = vi.mocked(maintenanceApi.getHomeHero).mock.calls[0][0]!.signal!
    await reload()
    expect(oldSignal.aborted).toBe(true)
    finishOld(uploaded()); await flushPromises()
    expect(heroes.value.nene.image).toContain('/assets/')
    vi.mocked(maintenanceApi.getHomeHero).mockReturnValue(new Promise(() => {}))
    void reload()
    const currentSignal = vi.mocked(maintenanceApi.getHomeHero).mock.lastCall![0]!.signal!
    scopes[0].stop()
    expect(currentSignal.aborted).toBe(true)
  })

  it('clears a previous runtime override when the connection identity changes', async () => {
    vi.mocked(maintenanceApi.getHomeHero).mockResolvedValue(uploaded())
    const { heroes } = scoped(useHomeHeroes)
    await flushPromises()
    expect(heroes.value.nene.image).toContain('/scene-showcase/')
    vi.mocked(maintenanceApi.getHomeHero).mockRejectedValue(new Error('offline'))
    setRuntimeOrigin('http://127.0.0.1:39999', true, 'next-workspace')
    await nextTick(); await flushPromises()
    expect(heroes.value.nene.image).toBe('/assets/characters/nene-home-cg-1024.webp')
  })
})
