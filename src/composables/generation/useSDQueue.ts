import { ref, computed, readonly } from 'vue'

/**
 * 串行出图队列 — 从重构前 tools/prompt-builder/queue.js 迁移。
 * 规则：最多 8 个任务；一次只跑一个；失败保留在队首并自动暂停，
 * 让用户先处理原因（降尺寸 / 跳 LoRA / 换采样器）再恢复。
 */

export const SD_QUEUE_LIMIT = 8

export interface SDQueueJob {
  context?: import('@/types/anima').AnimaResultContext
  id: string
  title: string
  prompt: string
  negative: string
  sceneId: string | null
  sceneTitle: string
  char: string
  story: string
  size: string
  seed: number
  cfg: number
  steps: number
  sampler: string
  scheduler: string
  checkpoint: string
  lora?: string
  hiresFix: boolean
  hiresScale: number
  hiresUpscaler: string
  hiresSteps: number
  denoisingStrength: number
  faceDetailer: boolean
}

export interface SDJobOutcome {
  status: 'success' | 'success-with-warning' | 'cancelled' | 'failure'
  error?: unknown
}

export type SDJobRunner = (job: SDQueueJob) => Promise<SDJobOutcome>

export function useSDQueue(options: {
  run: SDJobRunner
  onFlash?: (msg: string) => void
  isBusy?: () => boolean
}) {
  const { run, onFlash = () => {}, isBusy = () => false } = options

  const queue = ref<SDQueueJob[]>([])
  const activeJob = ref<SDQueueJob | null>(null)
  const paused = ref(false)

  /**
   * 本轮已完成张数（2026-09-06 体验报告 F6）。
   *
   * 原「第 N / 共 M」用 total（等待+在途）反推位置：每出完一张 total 就缩 1，
   * 运行时位置恒等于 1、分母持续缩水，用户无法回答「现在做到哪一步」。
   * 现在固定语义：done 只增不减（成功才计数），本轮总量 = done + 等待 + 在途，
   * 分母不再随完成漂移；失败/取消任务 retain 回队首仍计为等待，不算完成。
   */
  const done = ref(0)

  const total = computed(() => queue.value.length + (activeJob.value ? 1 : 0))
  /** 本轮总量（已完成 + 等待 + 在途）：进度展示用，与容量上限无关。 */
  const batchTotal = computed(() => done.value + total.value)
  const canEnqueue = computed(() => total.value < SD_QUEUE_LIMIT)

  function makeId() {
    return 'queue_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7)
  }

  function enqueue(job: Omit<SDQueueJob, 'id'>): boolean {
    if (!canEnqueue.value) {
      onFlash(`生成队列最多保留 ${SD_QUEUE_LIMIT} 个`)
      return false
    }
    if (!job.prompt) { onFlash('请先生成 Prompt'); return false }
    // 上一轮已全部跑完（无等待无在途）时重新开一轮：done 归零，批次语义重启。
    if (!queue.value.length && !activeJob.value) done.value = 0
    queue.value.push({ ...job, id: makeId() } as SDQueueJob)
    onFlash('已加入队列：' + (job.title || '未命名'))
    void process()
    return true
  }

  function remove(id: string) {
    queue.value = queue.value.filter(j => j.id !== id)
  }

  function clear() {
    queue.value = []
    // 清空等待即终结本轮：无在途任务时完成数一并归零，下一轮从 0 计。
    if (!activeJob.value) done.value = 0
  }

  async function process(): Promise<void> {
    if (paused.value || activeJob.value || !queue.value.length) return
    if (isBusy()) return

    const job = queue.value.shift()!
    activeJob.value = job
    let retained = false
    const retain = (message?: string) => {
      if (retained) return
      retained = true
      // 失败任务放回队首并暂停，避免连环失败烧显卡
      queue.value.unshift(job)
      paused.value = true
      if (message) onFlash(message)
    }

    try {
      const outcome = await run(job)
      if (outcome?.status === 'success') {
        done.value += 1
      } else if (outcome?.status === 'success-with-warning') {
        done.value += 1
        onFlash(String(outcome.error || '任务完成，但结果未能写入作品册'))
      } else {
        retain(outcome?.status === 'cancelled'
          ? '队列已停止并暂停，当前任务已保留'
          : '队列已暂停，失败任务已保留在队首')
      }
    } catch (e) {
      console.error('queue task failed unexpectedly', e)
      retain('队列已暂停，失败任务已保留在队首')
    } finally {
      activeJob.value = null
      if (!paused.value) void process()
    }
  }

  function pause() { paused.value = true }
  function resume() { paused.value = false; void process() }

  /**
   * 恢复一组排队任务（2026-08-30 UX 审计 P0-5：队列快照持久化）。
   *
   * 只灌回 pending 队列并置暂停——恢复后不自动开跑，由用户确认面板状态后
   * 再点「继续」，避免挂载即烧显存。返回实际新并入的任务数（去重后）。
   */
  function restore(jobs: SDQueueJob[]): number {
    if (!Array.isArray(jobs) || !jobs.length) return 0
    const capacity = Math.max(0, SD_QUEUE_LIMIT - total.value)
    if (!capacity) return 0
    // Account for the running job and deduplicate both existing and incoming IDs.
    const existing = new Set([activeJob.value?.id, ...queue.value.map(j => j.id)])
    const fresh: SDQueueJob[] = []
    for (const job of jobs) {
      if (!job || typeof job.id !== 'string' || !job.id.trim()
        || typeof job.prompt !== 'string' || !job.prompt.trim() || existing.has(job.id)) continue
      existing.add(job.id)
      fresh.push(job)
      if (fresh.length === capacity) break
    }
    if (!fresh.length) return 0
    // Merging into a live batch must not erase its already-completed progress.
    if (!total.value) done.value = 0
    queue.value = [...queue.value, ...fresh]
    paused.value = true
    return fresh.length
  }

  return {
    queue: readonly(queue),
    activeJob: readonly(activeJob),
    paused: readonly(paused),
    done: readonly(done),
    total, batchTotal, canEnqueue,
    enqueue, remove, clear, pause, resume, process, restore,
  }
}
