import { BATCH_DRAW_PLAN_KEY } from '@/utils/storageKeys'
import { profileDraftStorage, flushProfileWrites } from '@/platform/web/profileStorage'
import type { BatchDrawJob, BatchTargetItem } from './useBatchDraw'
import { sameTempResultOwner, type TempResultOwner } from '@/utils/tempResult'
import { isArtworkCommitIdentity } from '@/application/artwork/artworkSaveInput'

export interface BatchDrawPlan {
  version: 1
  createdAt: number
  engine: 'sd' | 'anima'
  runtimeOwned: boolean
  backendId?: string
  owner?: TempResultOwner
  targets: BatchTargetItem[]
  jobs: BatchDrawJob[]
}
export interface BatchDrawPlanStorage {
  read(): BatchDrawPlan | null
  write(plan: BatchDrawPlan): Promise<void>
  clear(): Promise<void>
}
const statuses = new Set(['pending', 'running', 'accepted', 'unknown', 'succeeded', 'failed', 'cancelled'])
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** Planning snapshots hold frozen input and request identities, never runtime task records or Blob URLs. */
function parseBatchDrawPlan(value: unknown): BatchDrawPlan | null {
  if (!record(value) || value.version !== 1 || !['sd', 'anima'].includes(String(value.engine))
    || typeof value.runtimeOwned !== 'boolean' || typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)
    || !Array.isArray(value.targets) || !Array.isArray(value.jobs) || !value.jobs.length) return null
  if (value.owner !== undefined && (!record(value.owner) || !(value.owner.kind === 'web' && typeof value.owner.origin === 'string'
    || value.owner.kind === 'workspace' && typeof value.owner.workspaceId === 'string' && typeof value.owner.principalId === 'string'))) return null
  const targets = value.targets.filter((target): target is unknown & BatchTargetItem => record(target)
    && typeof target.id === 'string' && typeof target.title === 'string'
    && (target.kind === 'scene' || target.kind === 'character'))
  if (targets.length !== value.targets.length || new Set(targets.map(target => target.id)).size !== targets.length) return null
  const targetIds = new Set(targets.map(target => target.id))
  const jobs = value.jobs.filter((job): job is unknown & BatchDrawJob => record(job) && typeof job.id === 'string'
    && typeof job.requestKey === 'string' && /^[\w-]{1,160}$/.test(job.requestKey)
    && typeof job.sceneId === 'string' && targetIds.has(job.sceneId) && typeof job.sceneTitle === 'string'
    && typeof job.seed === 'number' && Number.isFinite(job.seed) && Number.isInteger(job.variant) && Number(job.variant) >= 0
    && statuses.has(String(job.status)) && (job.taskId === undefined || typeof job.taskId === 'string')
    && (job.imageId === undefined || typeof job.imageId === 'string')
    && (job.historyId === undefined || typeof job.historyId === 'string' || typeof job.historyId === 'number' && Number.isFinite(job.historyId))
    && (job.snapshot === undefined || record(job.snapshot)) && (job.submitted === undefined || typeof job.submitted === 'boolean')
    && (job.pendingCommit === undefined || isArtworkCommitIdentity(job.pendingCommit)))
  if (jobs.length !== value.jobs.length || new Set(jobs.map(job => job.id)).size !== jobs.length
    || new Set(jobs.map(job => job.requestKey)).size !== jobs.length) return null
  return {
    version: 1, createdAt: value.createdAt, engine: value.engine as BatchDrawPlan['engine'], runtimeOwned: value.runtimeOwned,
    ...(typeof value.backendId === 'string' && /^[0-9a-f-]{36}$/.test(value.backendId) ? { backendId: value.backendId } : {}),
    owner: value.owner as TempResultOwner | undefined,
    targets: JSON.parse(JSON.stringify(targets)) as BatchTargetItem[],
    jobs: jobs.map(job => {
      const { resultUrl: _url, message: _message, pendingImage: _pending, ...saved } = job as BatchDrawJob & { resultUrl?: unknown }
      return { ...JSON.parse(JSON.stringify(saved)) as BatchDrawJob, status: ['running', 'accepted'].includes(job.status) ? job.submitted === false ? 'pending' : 'unknown' : job.status }
    }),
  }
}

export function createBatchDrawPlanStorage(): BatchDrawPlanStorage {
  return {
    read() {
      const raw = profileDraftStorage.getItem(BATCH_DRAW_PLAN_KEY)
      if (!raw) return null
      const plan = parseBatchDrawPlan(JSON.parse(raw))
      if (!plan) throw new Error('上次批次计划格式无效，未恢复或重新提交任务。')
      return plan
    },
    async write(plan) {
      if (plan.owner && !sameTempResultOwner(plan.owner)) throw new Error('批次所属资料来源已变化，原计划已保留')
      const jobs = plan.jobs.map(({ pendingImage: _pending, message: _message, ...job }) => job)
      profileDraftStorage.setItem(BATCH_DRAW_PLAN_KEY, JSON.stringify({ ...plan, jobs }))
      // The stable identity must be durable before admitting a model request.
      await flushProfileWrites()
    },
    async clear() { profileDraftStorage.removeItem(BATCH_DRAW_PLAN_KEY); await flushProfileWrites() },
  }
}
