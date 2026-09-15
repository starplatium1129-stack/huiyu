import { describe, expect, it } from 'vitest'
import type { SceneDraft, SceneMaintenanceSnapshot } from '@/types/api'
import type { SceneBlueprint } from '@/utils/popularContent'
import { buildSceneChangeSet, cloneSceneSnapshot, freezeSceneSnapshot, hasSceneChanges, parseSceneSnapshot } from './sceneChanges'

const scene = (id: string, title = 'fixture'): SceneDraft => ({ id, title, story: 'fixture', char: 'nene', rating: 'All', extension: { keep: true },
  category: 'fixture', lora: '', emotion: '', season: '', time: '', timeOfDay: '', location: '', weather: '', camera: '', lighting: '', tags: [], usage: [], storyJa: '', prompt: '', negative: '' })
const blueprint = (id: string) => ({ id, title: 'blueprint', characterId: 'nene', promptProse: 'fixture', promptTokens: ['fixture'], negativeTokens: ['fixture'] }) as SceneBlueprint
const base = (): SceneMaintenanceSnapshot => ({ scenes: [scene('sc001'), scene('sc999')], tags: [], curation: {}, blueprints: [blueprint('bp_001')] })

describe('scene change sets', () => {
  it('sends only new/changed records and explicit removals, preserving extension fields', () => {
    const baseline = base()
    const draft = cloneSceneSnapshot(baseline)
    draft.scenes = [scene('sc001', 'edited'), scene('sc1000')]
    const changes = buildSceneChangeSet(baseline, draft)
    expect(changes).toEqual({ version: 1, scenes: { upsert: draft.scenes, remove: ['sc999'] } })
    draft.scenes[0].extension = { keep: false }
    expect(changes.scenes.upsert[0].extension).toEqual({ keep: true })
    expect(baseline.scenes[0].title).toBe('fixture')
  })
  it('ignores object property order and collection reorder, but detects array content order', () => {
    const baseline = base()
    const draft = cloneSceneSnapshot(baseline)
    draft.scenes.reverse()
    draft.scenes[1] = Object.fromEntries(Object.entries(draft.scenes[1]).reverse()) as SceneDraft
    expect(hasSceneChanges(buildSceneChangeSet(baseline, draft))).toBe(false)
    draft.scenes[0].tags = ['a', 'b']
    expect(buildSceneChangeSet(baseline, draft).scenes.upsert.map(s => s.id)).toEqual(['sc999'])
  })
  it('includes only companions that changed, including explicit empty replacements', () => {
    const baseline = base()
    baseline.tags = [{ id: 't', en: 'a', cn: '甲', cat: 'Scene', weight: 1 }]
    baseline.curation = { curatedSceneIds: ['sc001'] }
    const draft = cloneSceneSnapshot(baseline)
    draft.tags = []
    draft.curation = {}
    draft.blueprints = [blueprint('bp_002')]
    expect(buildSceneChangeSet(baseline, draft)).toEqual({ version: 1, scenes: { upsert: [], remove: [] },
      blueprints: { upsert: draft.blueprints, remove: ['bp_001'] }, tags: [], curation: {} })
  })
  it('clones and deeply freezes the entire baseline without freezing editable data', () => {
    const draft = base()
    const frozen = freezeSceneSnapshot(draft)
    expect(Object.isFrozen(frozen)).toBe(true)
    expect(Object.isFrozen(frozen.scenes[0].extension)).toBe(true)
    expect(Object.isFrozen(frozen.curation)).toBe(true)
    draft.scenes[0].title = 'new'
    expect(frozen.scenes[0].title).toBe('fixture')
    expect(() => { frozen.scenes.push(scene('sc002')) }).toThrow()
  })
  it('rejects duplicate, noncanonical and over-limit collections', () => {
    const baseline = base()
    expect(() => buildSceneChangeSet(baseline, { ...base(), scenes: [scene('sc001'), scene('sc001')] })).toThrow('唯一')
    expect(() => buildSceneChangeSet(baseline, { ...base(), scenes: [scene('sc0001')] })).toThrow('不规范')
    expect(() => buildSceneChangeSet(baseline, { ...base(), scenes: Array(10001).fill(scene('sc001')) })).toThrow('10000')
    expect(() => buildSceneChangeSet(baseline, { ...base(), blueprints: Array(2001).fill(blueprint('b')) })).toThrow('2000')
    const empty = { scenes: [], blueprints: [], tags: [], curation: {} }
    expect(hasSceneChanges(buildSceneChangeSet(empty, empty))).toBe(false)
  })
  it('requires explicit complete snapshots and retains their content byte semantics', () => {
    const snapshot = base()
    snapshot.scenes[0].prompt = 'unchanged  spacing'
    expect(parseSceneSnapshot(JSON.stringify({ ...snapshot, version: 1 }))).toEqual(snapshot)
    expect(() => parseSceneSnapshot(JSON.stringify({ scenes: snapshot.scenes }))).toThrow('缺少')
    expect(() => parseSceneSnapshot(JSON.stringify({ ...snapshot, scenes: [] }))).toThrow('不能为空')
    expect(() => parseSceneSnapshot(JSON.stringify({ ...snapshot, version: 2 }))).toThrow('版本')
  })
})
