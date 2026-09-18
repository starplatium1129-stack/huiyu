import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope } from 'vue'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { useSceneStore } from '@/stores/sceneStore'
import { useRandomInspiration } from './useRandomInspiration'

let scope = effectScope()
beforeEach(() => {
  setActivePinia(createPinia())
  scope = effectScope()
  useSceneStore().tags = [{ en: 'park', cn: '公园', cat: 'Scene' }]
  usePromptBuilderStore().dataReady = true
})
afterEach(() => { scope.stop(); vi.restoreAllMocks() })
const setup = () => scope.run(() => useRandomInspiration())!

it('real store/caller reaches the default artist pool without loading the full catalog', () => {
  const random = setup()
  const pb = usePromptBuilderStore()
  vi.spyOn(Math, 'random').mockReturnValue(0)
  expect(random.roll()).toBe(true)
  expect(pb.artistStyleIds).toEqual([])
  random.includeArtists.value = true
  expect(random.roll()).toBe(true)
  expect(pb.artistStyleIds).toEqual(['kantoku'])
})

it('rerolls replace generated artists while retaining manual choices and the two-artist limit', () => {
  const random = setup()
  const pb = usePromptBuilderStore()
  pb.setArtistStyleIds(['rella'])
  random.includeArtists.value = true
  const rng = vi.spyOn(Math, 'random').mockReturnValue(0)
  random.roll()
  expect(pb.artistStyleIds).toEqual(['rella', 'kantoku'])
  rng.mockReturnValue(0.4)
  random.roll()
  expect(pb.artistStyleIds[0]).toBe('rella')
  expect(pb.artistStyleIds).toHaveLength(2)
  expect(pb.artistStyleIds[1]).not.toBe('kantoku')
  random.includeArtists.value = false
  random.roll()
  expect(pb.artistStyleIds).toEqual(['rella'])
})

it('manual picker changes become user-owned rather than being silently replaced', () => {
  const random = setup()
  const pb = usePromptBuilderStore()
  random.includeArtists.value = true
  vi.spyOn(Math, 'random').mockReturnValue(0)
  random.roll()
  pb.setArtistStyleIds(['kantoku', 'anmi'])
  random.roll()
  expect(pb.artistStyleIds).toEqual(['kantoku', 'anmi'])
})

it('undo restores all style fields and generated-artist ownership', () => {
  const random = setup()
  const pb = usePromptBuilderStore()
  const before = pb.snapshotStyleLayers()
  random.includeArtists.value = true
  const rng = vi.spyOn(Math, 'random').mockReturnValue(0)
  random.roll()
  const first = pb.snapshotStyleLayers()
  rng.mockReturnValue(0.4)
  random.roll()
  expect(random.undo()).toBe(true)
  expect(pb.snapshotStyleLayers()).toEqual(first)
  random.includeArtists.value = false
  random.roll()
  expect(pb.artistStyleIds).toEqual(before.artistStyleIds)
  expect(random.undo()).toBe(true)
  expect(pb.snapshotStyleLayers()).toEqual(first)
  expect(random.undo()).toBe(false)
})

it.each(['character', 'scene', 'popular', 'project'])('invalidates undo on %s context changes', context => {
  const random = setup()
  const pb = usePromptBuilderStore()
  random.roll()
  expect(random.hasUndo.value).not.toBeNull()
  if (context === 'character') pb.setChar('natsume')
  if (context === 'scene') pb.sceneId = 'new-scene'
  if (context === 'popular') pb.setPopularSubject('other', 'outfit', null)
  if (context === 'project') pb.projectId = 'new-project'
  const state = pb.snapshotStyleLayers()
  expect(random.hasUndo.value).toBeNull()
  expect(random.undo()).toBe(false)
  expect(pb.snapshotStyleLayers()).toEqual(state)
})

it('missing data or missing popular identity causes no state mutation', () => {
  const random = setup()
  const pb = usePromptBuilderStore()
  pb.dataReady = false
  const before = pb.snapshotStyleLayers()
  expect(random.roll()).toBe(false)
  expect(pb.snapshotStyleLayers()).toEqual(before)
  pb.dataReady = true
  pb.setPopularSubject('missing', 'missing', null)
  const popular = pb.snapshotStyleLayers()
  expect(random.roll()).toBe(false)
  expect(pb.snapshotStyleLayers()).toEqual(popular)
})
