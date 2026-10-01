import { expect, it, vi } from 'vitest'
import { createWebArtworkRepository } from '../../platform/web/artworkRepository'
import { ARTWORK_HISTORY_KEY } from '../../platform/web/artworkStorage'
import type { TaskRecord } from '../../../types/tasks'
import { saveTaskResult } from './saveTaskResult'

const task: TaskRecord = {
  taskId: 'one', workspaceId: 'isolated', principalId: 'owner', requestKey: 'key', requestFingerprint: 'fp',
  kind: 'anima', provider: 'comfy', providerFingerprint: 'provider-fp', upstreamId: 'upstream', status: 'succeeded',
  recoveryState: 'normal', revision: 1, runtimeEpoch: 'epoch', createdAt: 1, updatedAt: 2, submissionIntentAt: 1,
  submissionObservedAt: 1, cancelRequestedAt: null, upstreamSettled: true, executionDeadline: 100,
  input: { prompt: 'Neutral fixture', width: 1, height: 1 }, inputMediaRefs: [], resultState: 'available',
  resultRefs: [{ index: 0, alias: 'result', sha256: 'a'.repeat(64), bytes: 1, mime: 'image/png' }],
  deliveryState: 'unseen', errorCode: null, metadata: {}, checkpoint: null, parentBatchId: null, stepIndex: null,
}
function fixture() {
  const store = new Map<string, unknown>()
  const repository = createWebArtworkRepository({ kv: {
    get: async key => structuredClone(store.get(key)), set: async (key, value) => { store.set(key, structuredClone(value)) },
  } })
  const full = vi.spyOn(repository, 'readHistory'), read = vi.spyOn(repository, 'readArtwork')
  const markSaved = vi.fn(async () => {})
  return { repository, store, full, read, markSaved }
}
it('saves task results through a single-record check and commit, retaining idempotence without full reads', async () => {
  const f = fixture(), append = vi.spyOn(f.repository, 'appendArtwork')
  const first = await saveTaskResult(task, 0, f)
  expect(first).toMatchObject({ id: 'task-one-0', image_id: 'result', prompt: 'Neutral fixture' })
  expect(await saveTaskResult(task, 0, f)).toEqual(first)
  expect(f.read.mock.calls).toEqual([['task-one-0'], ['task-one-0']])
  expect(append).toHaveBeenCalledOnce()
  expect(f.full).not.toHaveBeenCalled()
  expect(f.markSaved).toHaveBeenCalledTimes(2)
})
it('confirms a lost acknowledgement by the same record and image before marking saved', async () => {
  const f = fixture(), append = f.repository.appendArtwork
  vi.spyOn(f.repository, 'appendArtwork').mockImplementation(async entry => { await append(entry); throw new Error('ack lost') })
  expect(await saveTaskResult(task, 0, f)).toMatchObject({ image_id: 'result' })
  expect(f.read).toHaveBeenCalledTimes(2)
  expect(f.markSaved).toHaveBeenCalledOnce()
  expect(f.full).not.toHaveBeenCalled()
})
it('does not mark unknown or conflicting results saved', async () => {
  const f = fixture()
  vi.spyOn(f.repository, 'appendArtwork').mockRejectedValue(new Error('commit unknown'))
  await expect(saveTaskResult(task, 0, f)).rejects.toThrow('commit unknown')
  f.store.set(ARTWORK_HISTORY_KEY, [{ id: 'task-one-0', image_id: 'different' }])
  await expect(saveTaskResult(task, 0, f)).rejects.toThrow('另一张图片')
  expect(f.markSaved).not.toHaveBeenCalled()
})

it('archives the actual runtime recipe and frozen subject without persisting gateway fields', async () => {
  const f = fixture()
  const accepted = { ...task, kind: 'creative', input: { prompt: 'Requested prompt', negative: '', seed: 41, cfg: 4, steps: 30,
    width: 1024, height: 1024, modelId: 'requested-model', adultEnabled: true, initImage: 'private-input', superResModel: 'gateway-resource' },
    metadata: { prompt: 'Actual prompt with style trigger', modelId: 'actual-model', cfg: 1, steps: 12, seed: 0, loras: [], styleLoraId: 'style-a',
      context: { characterId: 'subject-a', outfitId: 'outfit-a', blueprintId: 'blueprint-a', story: 'Frozen story',
        history: { sceneTitle: 'Frozen title', model: 'stale-model', seed: 99, cfg: 99, shot: 'close-up' } } },
  } as TaskRecord
  const result = await saveTaskResult(accepted, 0, f)
  expect(result).toMatchObject({ prompt: 'Actual prompt with style trigger', model: 'actual-model', checkpoint: 'actual-model', cfg: 1, steps: 12, seed: 0,
    engine: 'krea2', size: '1024x1024', styleLoraId: 'style-a', loras: [], loraId: null, loraStrength: null,
    characterId: 'subject-a', outfitId: 'outfit-a', scene: 'blueprint-a', story: 'Frozen story', shot: 'close-up' })
  const stored = await f.repository.readArtwork(result.id)
  for (const field of ['adultEnabled', 'initImage', 'superResModel', 'context']) expect(stored).not.toHaveProperty(field)
  expect(f.full).not.toHaveBeenCalled()
})

it('keeps unavailable generation fields absent in persistence rather than borrowing recipe form defaults', async () => {
  const f = fixture()
  const result = await saveTaskResult({ ...task, input: { prompt: 'Legacy task' }, metadata: { context: { history: { seed: 99, model: 'form-model', cfg: 7, size: '832x1216' } } } }, 0, f)
  const stored = await f.repository.readArtwork('task-one-0')
  for (const field of ['seed', 'model', 'checkpoint', 'size', 'cfg', 'steps', 'sampler']) {
    expect(stored).not.toHaveProperty(field)
    expect(result).not.toHaveProperty(field)
  }
})
