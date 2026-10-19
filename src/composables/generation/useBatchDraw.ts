import { computed, readonly, ref } from 'vue'
import { TaskSubmissionRejected } from '@/api/acceptedTaskOutcome'
import type { BatchDrawPlan, BatchDrawPlanStorage } from './batchDrawPlan'
import { ArtworkSaveSupersededError, type ArtworkCommitIdentity } from '@/application/artwork/artworkSaveInput'
import { sameTempResultOwner, tempResultOwner, type TempResultOwner } from '@/utils/tempResult'

export interface BatchTargetItem {
  id: string
  title: string
  prose?: string
  subtitle?: string
  avatarUrl?: string
  kind?: 'scene' | 'character'
  characterId?: string
}
export type BatchEngine = 'sd' | 'anima'
export interface BatchDrawJob {
  id: string
  requestKey: string
  taskId?: string
  sceneId: string
  sceneTitle: string
  subtitle?: string
  avatarUrl?: string
  kind?: 'scene' | 'character'
  seed: number
  variant: number
  status: 'pending' | 'running' | 'accepted' | 'unknown' | 'succeeded' | 'failed' | 'cancelled'
  error?: string
  message?: string
  historyId?: string | number
  imageId?: string
  pendingImage?: boolean
  snapshot?: Record<string, unknown>
  submitted?: boolean
  pendingCommit?: ArtworkCommitIdentity
}
export interface BatchDrawRunnerInput {
  scene: BatchTargetItem
  seed: number
  variant: number
  requestKey: string
  taskId?: string
  reconnect: boolean
  snapshot?: Record<string, unknown>
  signal: AbortSignal
  report?: (message: string) => void
  submitting: () => void
  accepted: (taskId: string) => Promise<void>
  admit: () => Promise<void>
  pendingCommit?: ArtworkCommitIdentity
  commitPrepared: (pending: ArtworkCommitIdentity) => Promise<void>
}
export interface BatchDrawRunnerResult {
  ok: boolean
  cancelled?: boolean
  unresolved?: boolean
  error?: string
  historyId?: string | number
  imageId?: string
  pendingImage?: boolean
}
export interface BatchDrawRunOptions {
  run: (input: BatchDrawRunnerInput) => Promise<BatchDrawRunnerResult>
  prepare?: (input: BatchDrawRunnerInput) => Record<string, unknown>
  storage?: BatchDrawPlanStorage
  onFlash?: (message: string) => void
}

/** Serial plan controller. Page disposal stops observation, never cancels accepted runtime tasks. */
export function useBatchDraw({ run, prepare, storage, onFlash = () => {} }: BatchDrawRunOptions) {
  const jobs = ref<BatchDrawJob[]>([]), running = ref(false), cancelRequested = ref(false)
  const restored = ref(false), storageError = ref(''), engine = ref<BatchEngine>('anima')
  const resetting = ref(false)
  let targets = new Map<string, BatchTargetItem>(), createdAt = 0, runtimeOwned = false
  let owner: TempResultOwner | undefined, unreadable = false
  let disposed = false, observer: AbortController | null = null
  let activeJobId = '', submissionStarted = false
  let persistenceTail = Promise.resolve()
  const checkOwner = () => { if (owner && !sameTempResultOwner(owner)) throw new Error('原批次所属资料来源已变化，请恢复原连接') }
  const progress = computed(() => {
    const count = (status: BatchDrawJob['status']) => jobs.value.filter(job => job.status === status).length
    const succeeded = count('succeeded'), failed = count('failed'), cancelled = count('cancelled')
    const unresolved = count('unknown') + count('accepted')
    const remaining = count('pending') + jobs.value.filter(job => job.status === 'cancelled' && !job.taskId && job.submitted === false).length
    return { total: jobs.value.length, done: succeeded + failed + cancelled, succeeded, failed, cancelled, unresolved, remaining }
  })

  function snapshot(): BatchDrawPlan {
    return JSON.parse(JSON.stringify({ version: 1, createdAt, engine: engine.value, runtimeOwned, owner, targets: [...targets.values()], jobs: jobs.value })) as BatchDrawPlan
  }
  async function persist(): Promise<boolean> {
    if (!storage) return true
    const plan = snapshot(), write = persistenceTail.then(() => storage.write(plan))
    persistenceTail = write.then(() => {}, () => {})
    try { await write; storageError.value = ''; return true }
    catch (error) { storageError.value = error instanceof Error ? error.message : '批次计划尚未保存'; onFlash(storageError.value); return false }
  }
  function restorePlan() {
    try {
      const plan = storage?.read()
      if (plan) {
        jobs.value = plan.jobs; targets = new Map(plan.targets.map(target => [target.id, target]))
        engine.value = plan.engine; createdAt = plan.createdAt; runtimeOwned = plan.runtimeOwned; owner = plan.owner; restored.value = true
      }
      unreadable = false; storageError.value = ''
    } catch (error) { unreadable = true; storageError.value = error instanceof Error ? error.message : '上次批次计划暂时无法读取' }
  }
  restorePlan()

  function runnerInput(job: BatchDrawJob, reconnect: boolean): BatchDrawRunnerInput {
    const input: BatchDrawRunnerInput = {
      scene: { ...targets.get(job.sceneId)! }, seed: job.seed, variant: job.variant,
      requestKey: job.requestKey, taskId: job.taskId, snapshot: job.snapshot, reconnect,
      signal: observer!.signal,
      submitting: () => { input.signal.throwIfAborted(); checkOwner(); submissionStarted = true },
      admit: async () => {
        input.signal.throwIfAborted()
        job.submitted = true
        if (!await persist()) throw new Error('请求身份尚未写稳，尚未提交；请恢复连接后查询原请求')
        input.signal.throwIfAborted()
        checkOwner()
      },
      pendingCommit: job.pendingCommit,
      commitPrepared: async pending => {
        if (disposed) throw new ArtworkSaveSupersededError(false)
        checkOwner()
        job.pendingCommit = JSON.parse(JSON.stringify(pending)) as ArtworkCommitIdentity
        input.pendingCommit = job.pendingCommit
        if (!await persist()) throw new Error('原入册身份尚未写稳，图片和请求已保留')
        if (disposed) throw new ArtworkSaveSupersededError(false)
        checkOwner()
      },
      report: message => { if (!disposed) job.message = message },
      accepted: async taskId => {
        if (disposed) return
        input.taskId = taskId
        submissionStarted = true
        job.taskId = taskId; job.status = 'accepted'
        if (!await persist()) throw new Error('任务已接收，计划更新尚未保存；请先恢复资料连接。')
      },
    }
    return input
  }

  async function execute(list: BatchDrawJob[], message: string): Promise<void> {
    if (running.value || resetting.value || disposed || !list.length) return
    running.value = true; cancelRequested.value = false; observer = new AbortController()
    onFlash(message)
    try {
      for (const job of list) {
        if (disposed || cancelRequested.value) break
        activeJobId = job.id; submissionStarted = false
        const reconnect = job.submitted !== false && (job.status === 'unknown' || job.status === 'accepted')
        if (engine.value === 'sd' && !reconnect) {
          job.status = 'failed'; job.error = 'SD 新生成已退役；未提交项已保留，不能创建替代任务。'
          if (!await persist()) break
          continue
        }
        job.status = reconnect ? 'unknown' : 'running'; job.error = undefined
        if (storage && !await persist()) { if (!reconnect) job.status = 'pending'; break }
        if (disposed) break
        // Stop may arrive while the request identity is being saved, before any admission.
        if (cancelRequested.value && !reconnect) { job.status = 'cancelled'; break }
        let result: BatchDrawRunnerResult
        try { result = await run(runnerInput(job, reconnect)) }
        catch (error) {
          const rejected = error instanceof TaskSubmissionRejected && error.requestKey === job.requestKey
          result = { ok: false, cancelled: rejected && error.code === 'TASK_REQUEST_CANCELLED', unresolved: runtimeOwned && !rejected, error: error instanceof Error ? error.message : String(error) }
        }
        if (disposed && result.historyId == null) break
        if (result.historyId != null) job.historyId = result.historyId
        if (result.imageId) job.imageId = result.imageId
        job.pendingImage = result.pendingImage === true
        job.status = result.unresolved ? 'unknown' : result.cancelled ? 'cancelled' : result.ok ? 'succeeded' : 'failed'
        job.error = result.ok || result.cancelled ? undefined : result.error || '生成失败'
        if (!await persist() || result.unresolved || disposed) break
      }
      if (cancelRequested.value && !disposed) {
        jobs.value.filter(job => job.status === 'pending').forEach(job => { job.status = 'cancelled' })
        await persist()
      }
    } finally { running.value = false; observer = null; activeJobId = ''; submissionStarted = false }
    if (disposed) return
    const { total, succeeded, failed, cancelled, remaining, unresolved } = progress.value
    onFlash(unresolved ? '批次已暂停：先核对已接收任务，再继续剩余项。' : remaining
      ? `批次已暂停：${succeeded} 张成功，${remaining} 张未执行`
      : failed || cancelled ? `批量结束：${succeeded}/${total} 张成功，${failed} 张失败，${cancelled} 张已取消` : `批量完成：${succeeded}/${total} 张全部入册`)
  }

  async function start(items: BatchTargetItem[], count: number, baseSeed: number, unitLabel = '个项目',
    planOptions: { engine?: Exclude<BatchEngine, 'sd'>; runtimeOwned?: boolean } = {}): Promise<void> {
    if (running.value || resetting.value || disposed || !items.length) return
    if (unreadable) { restorePlan(); if (unreadable) { onFlash(storageError.value); return } }
    if (planOptions.engine && planOptions.engine !== 'anima') { onFlash('SD 新生成已退役，请使用当前 Anima/Krea 2 配方'); return }
    if (progress.value.unresolved) { onFlash('请先核对本批已接收任务，再开启新计划。'); return }
    targets = new Map(items.map(item => [item.id, { ...item }]))
    try { owner = tempResultOwner() } catch (error) { onFlash(error instanceof Error ? error.message : String(error)); return }
    createdAt = Date.now(); engine.value = planOptions.engine || 'anima'; runtimeOwned = planOptions.runtimeOwned === true; restored.value = false
    const amount = Number.isFinite(count) ? Math.max(1, Math.min(3, Math.floor(count))) : 1
    jobs.value = [...targets.values()].flatMap(item => Array.from({ length: amount }, (_, variant) => ({
      id: crypto.randomUUID(), requestKey: crypto.randomUUID(), sceneId: item.id, sceneTitle: item.title,
      subtitle: item.subtitle, avatarUrl: item.avatarUrl, kind: item.kind, variant,
      seed: Number.isFinite(baseSeed) && baseSeed >= 0 ? baseSeed + variant * 1000 : -1, status: 'pending' as const, submitted: false,
    })))
    observer = new AbortController()
    for (const job of jobs.value) {
      try { job.snapshot = prepare?.(runnerInput(job, false)) }
      catch (error) { job.status = 'failed'; job.error = error instanceof Error ? error.message : String(error) }
    }
    observer = null
    await execute(jobs.value.filter(job => job.status === 'pending'), `批量出图开始：${jobs.value.length} 张（${items.length} ${unitLabel}）`)
    if (!jobs.value.some(job => job.status !== 'failed')) await persist()
  }
  async function resume(): Promise<void> {
    if (running.value || resetting.value || disposed) return
    if (unreadable) { restorePlan(); if (unreadable) { onFlash(storageError.value); return } }
    const unresolved = jobs.value.filter(job => job.status === 'unknown' || job.status === 'accepted')
    const remaining = jobs.value.filter(job => job.status === 'pending' || job.status === 'cancelled' && !job.taskId && job.submitted === false)
    await execute([...unresolved, ...remaining], '正在核对原任务，继续本批剩余项…')
  }
  async function retryFailed(): Promise<void> {
    if (running.value || resetting.value || disposed) return
    if (engine.value === 'sd') { onFlash('旧 SD 批次只核对已接收任务，不能重新生成失败项'); return }
    if (progress.value.unresolved) { onFlash('请先核对本批已接收任务，再重试失败项。'); return }
    const list = jobs.value.filter(job => job.status === 'failed' || job.status === 'cancelled')
    list.forEach(job => {
      if (job.pendingImage || job.pendingCommit) { job.status = 'unknown'; job.error = undefined; return }
      job.requestKey = crypto.randomUUID(); job.taskId = undefined
      job.status = 'pending'; job.error = undefined; job.submitted = false
    })
    await execute(list, `重跑 ${list.length} 张失败 / 未执行任务`)
  }
  function cancel() {
    if (!running.value) return
    cancelRequested.value = true
    onFlash('正在停止批量…（当前张完成后停止）')
  }
  async function reset() {
    if (running.value || resetting.value || disposed || progress.value.unresolved || unreadable) return
    resetting.value = true
    try {
      if (storage) { await persistenceTail; await storage.clear() }
      if (disposed) return
      storageError.value = ''
      targets.clear(); jobs.value = []; restored.value = false; cancelRequested.value = false
    }
    catch (error) { storageError.value = error instanceof Error ? error.message : '旧批次计划暂时无法清除'; return }
    finally { resetting.value = false }
  }
  function dispose() {
    if (disposed) return
    jobs.value.filter(job => job.status === 'running' || job.status === 'accepted').forEach(job => {
      job.status = job.status === 'running' && job.id === activeJobId && !submissionStarted && job.submitted === false ? 'pending' : 'unknown'
    })
    disposed = true; observer?.abort()
    if (jobs.value.length && !resetting.value) void persist()
  }
  return { jobs: readonly(jobs), running: readonly(running), progress, engine: readonly(engine), runtimeOwned: () => runtimeOwned,
    restored: readonly(restored), storageError: readonly(storageError), resetting: readonly(resetting), start, resume, retryFailed, cancel, reset, dispose, cancelRequested: readonly(cancelRequested) }
}
