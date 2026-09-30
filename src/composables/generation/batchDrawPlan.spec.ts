import { afterEach, expect, it } from 'vitest'
import { createBatchDrawPlanStorage, parseBatchDrawPlan, type BatchDrawPlan } from './batchDrawPlan'
import { BATCH_DRAW_PLAN_KEY, DIRECTOR_LAYOUT_KEY, isLiveLocalKey } from '@/utils/storageKeys'
import { classifyMigrationKey } from '@/platform/web/migrationClassification'

afterEach(() => sessionStorage.clear())
function plan(): BatchDrawPlan {
  return { version: 1, createdAt: 100, engine: 'anima', runtimeOwned: true,
    targets: [{ id: 'scene', title: '场景', kind: 'scene' }], jobs: [{ id: 'job', requestKey: 'stable-request',
      taskId: 'accepted-task', sceneId: 'scene', sceneTitle: '场景', seed: 0, variant: 0, status: 'accepted',
      snapshot: { prompt: 'original prompt' }, resultUrl: 'blob:old-result', message: 'current progress' }] }
}
it('persists only planning facts, preserves zero seed and restores accepted work as unknown', async () => {
  const storage = createBatchDrawPlanStorage()
  await storage.write(plan())
  const raw = sessionStorage.getItem(BATCH_DRAW_PLAN_KEY)!
  expect(raw).not.toContain('blob:'); expect(raw).not.toContain('current progress')
  expect(storage.read()?.jobs[0]).toMatchObject({ seed: 0, status: 'unknown', taskId: 'accepted-task', requestKey: 'stable-request' })
  await storage.clear(); expect(storage.read()).toBeNull()
})
it('does not turn corrupt or duplicate identities into executable jobs', () => {
  expect(parseBatchDrawPlan({ ...plan(), version: 2 })).toBeNull()
  const duplicate = plan(); duplicate.jobs.push({ ...duplicate.jobs[0], id: 'another-job' })
  expect(parseBatchDrawPlan(duplicate)).toBeNull()
  sessionStorage.setItem(BATCH_DRAW_PLAN_KEY, '{broken')
  expect(() => createBatchDrawPlanStorage().read()).toThrow()
  expect(sessionStorage.getItem(BATCH_DRAW_PLAN_KEY)).toBe('{broken')
})
it('registers window planning as draft and layout as a restorable setting', () => {
  expect(classifyMigrationKey('session', BATCH_DRAW_PLAN_KEY)).toBe('draft')
  expect(isLiveLocalKey(BATCH_DRAW_PLAN_KEY)).toBe(false)
  expect(classifyMigrationKey('local', DIRECTOR_LAYOUT_KEY)).toBe('settings')
  expect(isLiveLocalKey(DIRECTOR_LAYOUT_KEY)).toBe(true)
})
