import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, ref } from 'vue'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { useSceneStore } from '@/stores/sceneStore'
import { profileLocalStorage } from '@/platform/web/profileStorage'
import type { PopularCharacter } from '@/types/character'
import { parsePromptBuilderDraft } from '@/utils/promptBuilderPersistence'
import { applyInterrogateResult } from './applyInterrogateResult'
import { usePopularPromptAssembly } from './usePopularPromptAssembly'

beforeEach(() => { setActivePinia(createPinia()); localStorage.clear(); vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it('coalesces edits, keeps snapshots detached and cancels the timer on store disposal', () => {
  const pb = usePromptBuilderStore()
  pb.dataReady = true
  pb.story = 'First'; pb.saveDraft()
  pb.story = 'Second'; pb.saveDraft()
  const snapshot = pb.snapshotDraft()
  pb.selections.emotion.push('calm')
  expect(snapshot.selections?.emotion).toEqual([])
  vi.advanceTimersByTime(280)
  expect(JSON.parse(localStorage.getItem('aics_pb_last_draft')!).story).toBe('Second')
  pb.story = 'Disposed'; pb.saveDraft(); pb.$dispose()
  vi.advanceTimersByTime(500)
  expect(JSON.parse(localStorage.getItem('aics_pb_last_draft')!).story).toBe('Second')
})

it('restores touched parameters and shared fields for both original and edited scene stories', () => {
  useSceneStore().scenes = [{ id: 's', title: 'River', story: 'Original' }]
  const pb = usePromptBuilderStore()
  for (const story of ['Original', 'Edited']) {
    localStorage.setItem('aics_pb_last_draft', JSON.stringify({ updatedAt: 1, story, sceneId: 's',
      sceneBaseStory: 'Original', directorMode: 'pro', sdParams: { cfg: 0 }, sdParamsTouched: ['cfg'],
      manualTags: ['blue_sky'], projectId: 'project', subject: 'popular', characterId: 'character', outfitId: 'outfit' }))
    expect(pb.restoreDraft()).toBe(true)
    expect(pb.story).toBe(story)
    expect(pb.sdParams.cfg).toBe(0)
    expect(pb.sdParamsTouched.has('cfg')).toBe(true)
    expect(pb.manualTags).toEqual(new Set(['blue_sky']))
    expect(pb.subject).toEqual({ kind: 'popular', characterId: 'character', outfitId: 'outfit', blueprintId: null })
    expect(pb.projectId).toBe('project')
  }
})

it('reports storage failures and leaves corrupt saved drafts unapplied', () => {
  const pb = usePromptBuilderStore(); pb.story = 'Keep'; pb.dataReady = true
  localStorage.setItem('aics_pb_last_draft', '{broken')
  expect(pb.restoreDraft()).toBe(false); expect(pb.story).toBe('Keep')
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  // Spy on our plain storage boundary, not happy-dom's proxied Storage instance:
  // an instance override can survive mockRestore and poison subsequent writes.
  const write = vi.spyOn(profileLocalStorage, 'setItem').mockImplementation(() => { throw new Error('quota') })
  try {
    pb.saveDraft(); vi.advanceTimersByTime(280)
    expect(write).toHaveBeenCalledWith('aics_pb_last_draft', expect.any(String))
    expect(warning).toHaveBeenCalled()
  } finally {
    write.mockRestore()
    pb.$dispose()
  }
})

it.each(['anima', 'krea2'] as const)('keeps an applied reference outfit in the %s prompt after draft restoration', async engine => {
  const character: PopularCharacter = {
    id: 'fixture-target', displayName: 'Fixture', originalName: 'Fixture', franchise: 'Fixture',
    aliases: [], identityProse: 'An adult woman with black hair and blue eyes',
    identityTokens: ['1girl', 'solo', 'black_hair', 'blue_eyes'], exactTokens: ['fixture_target'], exactPrefixes: [],
    recommendedEngine: 'anima', supportedEngines: ['anima', 'krea2'], adultEligibility: 'adult',
    outfits: [{ id: 'default', name: 'Default', tokens: ['school_uniform'], prose: 'a school uniform', default: true }],
  }
  useSceneStore().popularCharacters = [character]
  const pb = usePromptBuilderStore()
  pb.setPopularSubject(character.id, 'default')
  pb.dataReady = true
  await applyInterrogateResult(pb, { engine: 'wd14', mode: 'tag', tags: ['kimono', 'sitting'] })
  expect(pb.outfitOverride?.tokens).toEqual(['kimono'])
  expect(pb.manualTags).toEqual(new Set(['sitting']))
  const assembly = usePopularPromptAssembly(pb, ref(engine), ref('fixture-model'))
  const prompt = assembly.positivePrompt.value
  expect(prompt).toContain('kimono')
  expect(prompt).not.toMatch(/school[_ ]uniform/)
  const snapshot = pb.snapshotDraft()
  snapshot.outfitOverride!.tokens.push('mutated_snapshot')
  expect(pb.outfitOverride?.tokens).toEqual(['kimono'])
  await nextTick()
  vi.advanceTimersByTime(280)
  pb.clearOutfitOverride()
  expect(pb.restoreDraft()).toBe(true)
  expect(pb.outfitOverride?.tokens).toEqual(['kimono'])
  expect(assembly.positivePrompt.value).toBe(prompt)
  pb.$dispose()
})

it('autosaves reference-outfit-only edits and clearing without a manualTags change', async () => {
  const pb = usePromptBuilderStore()
  pb.setPopularSubject('fixture-target', 'default')
  pb.dataReady = true
  const savedOverride = () => JSON.parse(localStorage.getItem('aics_pb_last_draft')!).outfitOverride
  pb.setOutfitOverride(['kimono'], '校服/水手服')
  await nextTick(); vi.advanceTimersByTime(280)
  expect(savedOverride()).toEqual({ tokens: ['kimono'], replaced: '校服/水手服' })
  pb.outfitOverride!.tokens.push('yukata')
  await nextTick(); vi.advanceTimersByTime(280)
  expect(savedOverride().tokens).toEqual(['kimono', 'yukata'])
  pb.clearOutfitOverride()
  await nextTick(); vi.advanceTimersByTime(280)
  expect(savedOverride()).toBeNull()
  pb.$dispose()
})

it.each([
  { subject: 'popular', characterId: 'target', outfitId: 'default' },
  { subject: 'popular', characterId: 'target', outfitId: 'default', outfitOverride: { tokens: [null, 1, ' '] } },
  { subject: 'studio', story: 'Studio scene', outfitOverride: { tokens: ['kimono'], replaced: null } },
])('does not carry a previous outfit into a draft without a valid popular override: %j', draft => {
  const pb = usePromptBuilderStore()
  pb.setPopularSubject('previous', 'default')
  pb.setOutfitOverride(['yukata'], null)
  localStorage.setItem('aics_pb_last_draft', JSON.stringify({ updatedAt: 1, ...draft }))
  expect(pb.restoreDraft()).toBe(true)
  expect(pb.outfitOverride).toBeNull()
  pb.$dispose()
})

it('validates and detaches persisted outfit arrays at the storage boundary', () => {
  const raw = { updatedAt: 1, subject: 'popular', outfitOverride: { tokens: [' kimono ', 7, '', 'kimono'], replaced: false } }
  const draft = parsePromptBuilderDraft(raw)!
  expect(draft.outfitOverride).toEqual({ tokens: ['kimono'], replaced: null })
  raw.outfitOverride.tokens.push('yukata')
  expect(draft.outfitOverride?.tokens).toEqual(['kimono'])
})

it('detaches and restores reference ownership, and clears it when restoring an older draft', async () => {
  const pb = usePromptBuilderStore()
  pb.setPopularSubject('fixture-target', 'default')
  pb.dataReady = true
  pb.manualTags = new Set(['sitting', 'park', 'paper_lantern'])
  pb.referenceInput = { tags: ['sitting', 'park'] }
  const snapshot = pb.snapshotDraft()
  snapshot.referenceInput!.tags.push('mutated_snapshot')
  expect(pb.referenceInput).toEqual({ tags: ['sitting', 'park'] })
  await nextTick(); vi.advanceTimersByTime(280)
  pb.clearReferenceInput()
  expect(pb.restoreDraft()).toBe(true)
  expect(pb.referenceInput).toEqual({ tags: ['sitting', 'park'] })
  pb.clearReferenceInput()
  expect(pb.manualTags).toEqual(new Set(['paper_lantern']))
  localStorage.setItem('aics_pb_last_draft', JSON.stringify({ updatedAt: 1, story: 'Older draft', manualTags: ['park'] }))
  pb.referenceInput = { tags: ['park'] }
  expect(pb.restoreDraft()).toBe(true)
  expect(pb.referenceInput).toBeNull()
  expect(pb.manualTags).toEqual(new Set(['park']))
  pb.$dispose()
})

it('validates and detaches persisted source tags without inferring provenance for legacy manual tags', () => {
  const raw = { updatedAt: 1, story: 'Fixture', manualTags: ['sitting'], referenceInput: { tags: [' sitting ', 7, '', 'sitting'] } }
  const draft = parsePromptBuilderDraft(raw)!
  expect(draft.referenceInput).toEqual({ tags: ['sitting'] })
  raw.referenceInput.tags.push('park')
  expect(draft.referenceInput?.tags).toEqual(['sitting'])
  expect(parsePromptBuilderDraft({ updatedAt: 1, manualTags: ['sitting'] })?.referenceInput).toBeNull()
})
