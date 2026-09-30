import { afterEach, expect, it, vi } from 'vitest'
import { orderExplorerScenes } from './sceneExplorerOrdering'
import { buildPreferenceProfile } from '@/utils/sceneUX'
import type { ExplorerScene } from './sceneExplorerPresentation'

afterEach(() => vi.restoreAllMocks())

it('orders by the chosen mode, then resolves relevance ties without mutating input', () => {
  const now = 1_700_000_000_000
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const scenes = [
    { id: 'sc10', title: 'C', char: 'nene' },
    { id: 'sc2', title: 'A', char: 'natsume' },
    { id: 'sc1', title: 'B', char: 'natsume' },
    { id: 'sc3', title: 'D', char: 'natsume' },
    { id: 'sc4', title: 'E', char: 'natsume' },
    { id: 'sc5', title: 'F', char: 'natsume', story: 'quiet', emotion: 'joy', rating: 'All' },
  ] as ExplorerScene[]
  const options = {
    curation: { personaCoreSceneIds: ['sc1', 'sc3', 'sc1'], signatureSceneIds: ['sc3', 'sc2'], curatedSceneIds: ['sc2', 'sc4'] },
    profile: buildPreferenceProfile([{ id: now, scene: 'sc10', character: 'nene', favorite: true }], now),
    usage: { sc2: { uses: 3, lastUsed: now } }, favorites: new Set(['sc3']), relevance: new Map<string, number>(),
  }
  const expected = {
    curation: ['sc1', 'sc3', 'sc2', 'sc4', 'sc5', 'sc10'],
    smart: ['sc1', 'sc3', 'sc2', 'sc10', 'sc4', 'sc5'],
    favorite: ['sc3', 'sc10', 'sc2', 'sc1', 'sc4', 'sc5'],
    used: ['sc2', 'sc10', 'sc1', 'sc3', 'sc4', 'sc5'],
    title: ['sc2', 'sc1', 'sc10', 'sc3', 'sc4', 'sc5'],
    newest: ['sc10', 'sc5', 'sc4', 'sc3', 'sc2', 'sc1'],
  }
  for (const [mode, ids] of Object.entries(expected)) {
    expect(orderExplorerScenes(scenes, { ...options, mode }).map(scene => scene.id)).toEqual(ids)
    const relevance = new Map([['sc2', 2], ['sc10', 2]])
    expect(orderExplorerScenes(scenes, { ...options, mode, relevance }).map(scene => scene.id))
      .toEqual([...ids.filter(id => relevance.has(id)), ...ids.filter(id => !relevance.has(id))])
  }
  expect(scenes.map(scene => scene.id)).toEqual(['sc10', 'sc2', 'sc1', 'sc3', 'sc4', 'sc5'])
})
