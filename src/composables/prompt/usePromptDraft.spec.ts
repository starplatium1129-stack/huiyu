import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { useSceneStore } from '@/stores/sceneStore'

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
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota') })
  pb.saveDraft(); vi.advanceTimersByTime(280)
  expect(warning).toHaveBeenCalled()
})
