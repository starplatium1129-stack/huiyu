import { describe, expect, it } from 'vitest'
import { useSDQueue, type SDJobOutcome, type SDQueueJob } from './useSDQueue'

/**
 * useSDQueue 进度语义（2026-09-06 体验报告 F6）。
 *
 * 修复前：total = 等待+在途，每出完一张分母缩 1，「第 N 张」恒为 1。
 * 修复后：done（成功数）只增不减，batchTotal = done + 等待 + 在途，分母固定。
 * 验收四场景：三张队列 / 失败重试 / 途中追加 / 快照恢复。
 */

function makeJob(title: string): Omit<SDQueueJob, 'id'> {
  return {
    title, prompt: 'p', negative: '', sceneId: null, sceneTitle: '', char: 'nene',
    story: '', size: '832x1216', seed: -1, cfg: 6, steps: 30, sampler: 'Euler a',
    scheduler: '', checkpoint: 'wai', hiresFix: false, hiresScale: 1.5,
    hiresUpscaler: 'Auto', hiresSteps: 20, denoisingStrength: 0.4, faceDetailer: false,
  }
}

/** 可控 runner：返回 { resolveWith } 让每个任务手动落终态。 */
function controllableRunner() {
  const pending: Array<{ job: SDQueueJob; settle: (outcome: SDJobOutcome) => void }> = []
  const run = (job: SDQueueJob) => new Promise<SDJobOutcome>((resolve) => {
    pending.push({ job, settle: resolve })
  })
  const settleActive = async (outcome: SDJobOutcome) => {
    const item = pending.shift()
    if (!item) throw new Error('no active job to settle')
    item.settle(outcome)
    // 等 queue 状态机跑完 finally → 下一个 process()
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  return { run, settleActive, pendingCount: () => pending.length }
}

describe('useSDQueue · 批次进度计数（F6）', () => {
  it('三张队列：分母固定为 3，位置随完成递增', async () => {
    const { run, settleActive } = controllableRunner()
    const q = useSDQueue({ run })

    q.enqueue(makeJob('A'))
    q.enqueue(makeJob('B'))
    q.enqueue(makeJob('C'))
    expect(q.activeJob.value?.title).toBe('A')
    expect(q.done.value).toBe(0)
    expect(q.batchTotal.value).toBe(3)

    await settleActive({ status: 'success' })
    // 旧算法此刻显示「第 1 / 共 2」；现在 done=1、分母仍为 3
    expect(q.done.value).toBe(1)
    expect(q.batchTotal.value).toBe(3)
    expect(q.activeJob.value?.title).toBe('B')

    await settleActive({ status: 'success' })
    expect(q.done.value).toBe(2)
    expect(q.batchTotal.value).toBe(3)

    await settleActive({ status: 'success' })
    expect(q.done.value).toBe(3)
    expect(q.batchTotal.value).toBe(3)
    expect(q.total.value).toBe(0)
  })

  it('失败任务保留队首并暂停：不计完成、分母不变，恢复后重跑同一任务', async () => {
    const { run, settleActive } = controllableRunner()
    const q = useSDQueue({ run })
    q.enqueue(makeJob('A'))
    q.enqueue(makeJob('B'))

    await settleActive({ status: 'failure' })
    expect(q.paused.value).toBe(true)
    expect(q.done.value).toBe(0)
    expect(q.batchTotal.value).toBe(2)
    expect(q.queue.value[0]?.title).toBe('A')
    expect(q.activeJob.value).toBeNull()

    q.resume()
    expect(q.activeJob.value?.title).toBe('A')
    await settleActive({ status: 'success' })
    expect(q.done.value).toBe(1)
    expect(q.batchTotal.value).toBe(2)
    expect(q.activeJob.value?.title).toBe('B')
    await settleActive({ status: 'success' })
    expect(q.done.value).toBe(2)
  })

  it('入册警告仍计为生成完成，并把恢复提示交给调用方', async () => {
    const warnings: string[] = []
    const { run, settleActive } = controllableRunner()
    const q = useSDQueue({ run, onFlash: message => warnings.push(message) })
    q.enqueue(makeJob('A'))
    await settleActive({ status: 'success-with-warning', error: '成片未能入册' })
    expect(q.done.value).toBe(1)
    expect(q.paused.value).toBe(false)
    expect(warnings).toContain('成片未能入册')
  })

  it('途中追加：本轮总量随追加增长，完成数不回退', async () => {
    const { run, settleActive } = controllableRunner()
    const q = useSDQueue({ run })
    q.enqueue(makeJob('A'))
    q.enqueue(makeJob('B'))
    await settleActive({ status: 'success' })
    expect(q.done.value).toBe(1)

    q.enqueue(makeJob('C'))
    expect(q.batchTotal.value).toBe(3)
    await settleActive({ status: 'success' })
    await settleActive({ status: 'success' })
    expect(q.done.value).toBe(3)
    expect(q.total.value).toBe(0)
  })

  it('全部跑完后再次入队：重新开一轮（done 归零）', async () => {
    const { run, settleActive } = controllableRunner()
    const q = useSDQueue({ run })
    q.enqueue(makeJob('A'))
    await settleActive({ status: 'success' })
    expect(q.done.value).toBe(1)
    expect(q.total.value).toBe(0)

    q.enqueue(makeJob('B'))
    expect(q.done.value).toBe(0)
    expect(q.batchTotal.value).toBe(1)
    await settleActive({ status: 'success' })
  })

  it('快照恢复：恢复的任务构成新一轮（done=0，总量=恢复数），且保持暂停', () => {
    const { run } = controllableRunner()
    const q = useSDQueue({ run })
    const restored = q.restore([
      { ...makeJob('R1'), id: 'r1' },
      { ...makeJob('R2'), id: 'r2' },
    ])
    expect(restored).toBe(2)
    expect(q.paused.value).toBe(true)
    expect(q.done.value).toBe(0)
    expect(q.batchTotal.value).toBe(2)
  })

  it('清空等待且无在途：本轮终结，done 归零', async () => {
    const { run, settleActive } = controllableRunner()
    const q = useSDQueue({ run })
    q.enqueue(makeJob('A'))
    q.enqueue(makeJob('B'))
    q.pause()
    await settleActive({ status: 'success' })
    expect(q.done.value).toBe(1)
    q.clear()
    expect(q.done.value).toBe(0)
    expect(q.batchTotal.value).toBe(0)
  })
})
