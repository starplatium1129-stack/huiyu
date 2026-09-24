import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { useSDQueue, SD_QUEUE_LIMIT, type SDJobOutcome, type SDQueueJob } from './useSDQueue'

function job(id: string, prompt = 'queue fixture'): SDQueueJob {
  return {
    id, title: id, prompt, negative: '', sceneId: null, sceneTitle: '', char: 'nene',
    story: '', size: '832x1216', seed: -1, cfg: 6, steps: 30, sampler: 'Euler a',
    scheduler: '', checkpoint: 'wai', hiresFix: false, hiresScale: 1.5,
    hiresUpscaler: 'Auto', hiresSteps: 20, denoisingStrength: 0.4, faceDetailer: false,
  }
}

function fixture() {
  const pending: Array<(outcome: SDJobOutcome) => void> = []
  const queue = useSDQueue({ run: () => new Promise<SDJobOutcome>(resolve => pending.push(resolve)) })
  const settle = async () => {
    const resolve = pending.shift()
    assert.ok(resolve)
    resolve({ status: 'success' })
    await Promise.resolve()
  }
  return { queue, pending, settle }
}

describe('useSDQueue · snapshot restore boundaries', () => {
  it('deduplicates within the snapshot and preserves the first occurrence', () => {
    const { queue, pending } = fixture()
    assert.equal(queue.restore([job('a'), job('a', 'duplicate'), job('b')]), 2)
    assert.deepEqual(queue.queue.value.map(item => item.id), ['a', 'b'])
    assert.equal(queue.queue.value[0].prompt, 'queue fixture')
    assert.equal(queue.paused.value, true)
    assert.equal(pending.length, 0)
  })

  it('reports only the jobs actually admitted when an oversized snapshot is restored', () => {
    const { queue } = fixture()
    assert.equal(queue.restore(Array.from({ length: 20 }, (_, index) => job(`r${index}`))), SD_QUEUE_LIMIT)
    assert.equal(queue.total.value, SD_QUEUE_LIMIT)
  })

  it('includes the running job in the eight-job capacity', async () => {
    const { queue, settle } = fixture()
    queue.enqueue(job('active'))
    const active = queue.activeJob.value
    assert.equal(queue.restore(Array.from({ length: 10 }, (_, index) => job(`r${index}`))), SD_QUEUE_LIMIT - 1)
    assert.equal(queue.total.value, SD_QUEUE_LIMIT)
    assert.equal(queue.activeJob.value?.id, active?.id)
    await settle()
  })

  it('does not change state or pause execution when no capacity remains', async () => {
    const { queue, settle } = fixture()
    for (let index = 0; index < SD_QUEUE_LIMIT; index++) queue.enqueue(job(`q${index}`))
    const ids = queue.queue.value.map(item => item.id)
    assert.equal(queue.paused.value, false)
    assert.equal(queue.restore([job('overflow')]), 0)
    assert.equal(queue.paused.value, false)
    assert.deepEqual(queue.queue.value.map(item => item.id), ids)
    queue.pause()
    await settle()
  })

  it('skips active and waiting IDs as well as repeated incoming IDs', async () => {
    const { queue, settle } = fixture()
    queue.enqueue(job('active'))
    const activeId = queue.activeJob.value!.id
    assert.equal(queue.restore([job('waiting')]), 1)
    assert.equal(queue.restore([job(activeId), job('waiting'), job('new'), job('new')]), 1)
    assert.deepEqual(queue.queue.value.map(item => item.id), ['waiting', 'new'])
    await settle()
  })

  it('rejects empty IDs and blank prompts without consuming capacity', () => {
    const { queue } = fixture()
    assert.equal(queue.restore([job(''), job(' '), job('empty', ''), job('blank', ' \n '), job('valid')]), 1)
    assert.deepEqual(queue.queue.value.map(item => item.id), ['valid'])
  })

  it('preserves completed progress when merging into an existing batch', async () => {
    const { queue, settle } = fixture()
    queue.enqueue(job('a'))
    queue.enqueue(job('b'))
    await settle()
    assert.equal(queue.done.value, 1)
    assert.equal(queue.restore([job('c')]), 1)
    assert.equal(queue.done.value, 1)
    assert.equal(queue.batchTotal.value, 3)
    assert.equal(queue.paused.value, true)
    await settle()
  })

  it('starts a fresh paused batch after the previous batch has finished', async () => {
    const { queue, settle } = fixture()
    queue.enqueue(job('completed'))
    await settle()
    assert.equal(queue.done.value, 1)
    assert.equal(queue.total.value, 0)
    assert.equal(queue.restore([job('next')]), 1)
    assert.equal(queue.done.value, 0)
    assert.equal(queue.batchTotal.value, 1)
    assert.equal(queue.paused.value, true)
  })
})
