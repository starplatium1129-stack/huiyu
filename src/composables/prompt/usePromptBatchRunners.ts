import { runtimeFetch } from '../../platform/runtimeUrl.ts'
import { hasRuntimeTasks } from '../../api/runtimeTaskAuthority'
import { createBatchDrawPlanStorage } from '../generation/batchDrawPlan'
import { readPreparedBatch, recoverBatchTask, batchFailure, batchHistoryFromMetadata } from './batchGenerationPlan'
import { pendingBatchSaves, pendingBatchImage, persistBatchArtwork, batchSaveAuthority, ownsPendingSave, updateArtworkSource, type BatchArtworkSource } from './batchArtworkSave'
import { createPromptBatchRecipe } from './promptBatchRecipe'
import { useTrackedTask } from '../useTaskCenter.ts'
import type { usePromptBuilderStore } from '../../stores/promptBuilderStore.ts'
import { createBatchAnimaTransport } from './batchAnimaJob.ts'
import { nativeAnimaRequestBlocker } from '../generation/nativeAnimaCapabilities'
import type { SceneBlueprint, PopularCharacter } from '../../utils/popularContent.ts'
import type { useAnimaSession } from '../generation/useAnimaSession.ts'
import type { useLegacySdTasks, LegacySdObserveOptions } from '../generation/useLegacySdTasks.ts'
import type { usePromptAssembly } from './usePromptAssembly.ts'
import { useBatchDraw } from '../generation/useBatchDraw.ts'
import type { SDQueueJob } from '../generation/useSDQueue.ts'
import { artworkRepository } from '@/storage/artworkRepository'
import { tempResultOwner, type TempResultOwner } from '@/utils/tempResult'
import type { Scene } from '@/types/scene'
import type { PromptPlan } from '@/types/prompt'
import { resolveModelProfile } from '@/utils/promptPolicy'
import { ref } from 'vue'

type PromptBuilderStore = ReturnType<typeof usePromptBuilderStore>
type AnimaSession = ReturnType<typeof useAnimaSession>
type PromptAssembly = ReturnType<typeof usePromptAssembly>

export interface PromptBatchRunnersDeps {
  pb: PromptBuilderStore
  sd: ReturnType<typeof useLegacySdTasks>
  negativePrompt: PromptAssembly['negativePrompt']
  animaState: AnimaSession['state']
  /** 历史 SD 批次仅通过原任务查询与收集结果。 */
  runJob: (job: Omit<SDQueueJob, 'id'>, opts?: LegacySdObserveOptions & { disableLora?: boolean }) => Promise<string | null>
  sceneBlueprints: () => SceneBlueprint[]
  scenes?: () => Scene[]
  currentPlan?: () => PromptPlan | null
  popularCharacters?: () => PopularCharacter[]
  currentBasePrompt?: () => string
  /** 绘图台当前完整编译出的实时提示词（含所有标签、镜头、光影、画面指令） */
  currentLivePrompt?: () => string
}

/**
 * 绘图页批量出图 runner 编排（支持「多场景蓝图」与「同词条多角色漫游」）。
 *
 * 调度与进度归 useBatchDraw，配方快照归 promptBatchRecipe；
 * 这里持有任务运输、恢复与历史记录入册。
 */
export function usePromptBatchRunners(deps: PromptBatchRunnersDeps) {
  const { pb, sd, runJob } = deps
  const animaTransport = createBatchAnimaTransport()
  const startError = ref('')
  const rejectStart = (message: string) => { startError.value = message; return false }
  let recipe: ReturnType<typeof createPromptBatchRecipe> | undefined
  const clone = <T,>(value: T): T => value == null ? value : JSON.parse(JSON.stringify(value)) as T
  function captureBatch() {
    recipe = createPromptBatchRecipe({
      source: {
        subject: pb.subject, char: pb.char, selections: pb.selections, manualTags: [...pb.manualTags],
        directorSources: pb.directorSources, loraMeta: pb.loraMeta,
        outfitOverride: pb.outfitOverride, activeScene: pb.activeScene, sceneBlueprints: pb.sceneBlueprints,
        emotionPrompt: pb.emotionPrompt, tags: pb.tags, artistStyleIds: pb.directorMode === 'pro' ? pb.artistStyleIds : [],
        colorMood: pb.colorMood, visualDescription: pb.visualDescription, projectId: pb.projectId,
        negativeCustom: pb.sdParams.negativeCustom,
      },
      characters: deps.popularCharacters?.() || pb.popularCharacters,
      blueprints: deps.sceneBlueprints(), scenes: deps.scenes?.(), sourcePlan: deps.currentPlan?.(), state: deps.animaState.value,
      profile: resolveModelProfile(pb.modelProfiles, deps.animaState.value.modelId, deps.animaState.value.family),
      negativePrompt: deps.negativePrompt.value,
    })
    return recipe
  }

  const pendingSaves = pendingBatchSaves
  let planOwner: { repository: typeof artworkRepository; authority: string; owner?: TempResultOwner } = { repository: artworkRepository, authority: batchSaveAuthority() }
  const checkPlanOwner = () => {
    planOwner.owner ??= tempResultOwner()
    if (!ownsPendingSave(planOwner)) throw new Error('批次所属作品库已变化，请回到原工作区继续；原计划未写入其他资料库')
  }
  const batchStorage = createBatchDrawPlanStorage()
  const batchDraw = useBatchDraw({
    storage: { async write(plan) { checkPlanOwner(); await batchStorage.write(plan) },
      async clear() { checkPlanOwner(); await batchStorage.clear() }, read() {
      if (planOwner.repository !== artworkRepository || planOwner.authority !== batchSaveAuthority()) throw new Error('批次资料来源已更换，请回到原工作区读取计划')
      const plan = batchStorage.read()
      planOwner.owner = plan?.owner
      plan?.jobs.forEach(job => { if (pendingSaves.has(job.requestKey)) { job.pendingImage = true; job.status = 'unknown' } })
      return plan
    } },
    prepare: input => {
      if (!recipe) throw new Error('批次参数快照尚未准备')
      return clone(recipe.prepare(input)) as unknown as Record<string, unknown>
    },
    onFlash: (message) => pb.flash(message),
    run: async (input) => {
      try { checkPlanOwner() }
      catch (error) { return { ok: false, unresolved: true, error: error instanceof Error ? error.message : String(error) } }
      const plan = readPreparedBatch(input.snapshot)
      if (!plan) return { ok: false, unresolved: input.reconnect, error: '原批次参数快照不可用；请核对任务中心中的原任务。' }
      if (hasRuntimeTasks() !== batchDraw.runtimeOwned()) return { ok: false, unresolved: true, error: '原批次生成环境已改变，请恢复原工作区后核对任务。' }
      const saved = pendingSaves.get(input.requestKey)
      if (saved) return persistBatchArtwork(input, saved, pb.commitHistoryEntry)
      const owner = { ...planOwner, runtimeOwned: batchDraw.runtimeOwned() }
      const save = (source: BatchArtworkSource) => persistBatchArtwork(input, { ...owner, source }, pb.commitHistoryEntry)
      try {
        if (input.pendingCommit) {
          const blob = await owner.repository.getImage(input.pendingCommit.entry.image_id!, input.signal)
          checkPlanOwner()
          if (!blob?.size) return { ok: false, unresolved: true, error: '原入册图片暂不可读，原记录与媒体身份已保留；不会重新生成' }
          return save({ kind: 'image', entry: { ...input.pendingCommit.entry, blob, pendingCommit: input.pendingCommit } })
        }
        if (input.reconnect && batchDraw.runtimeOwned()) {
          const result = await recoverBatchTask(input)
          return save({ kind: 'task', taskId: result.taskId })
        }
        if (plan.engine === 'sd') {
          if (!input.reconnect) return { ok: false, error: 'SD 新生成已退役；仅核对原批次中已接收的任务。' }
          if (input.reconnect && !input.taskId) return { ok: false, unresolved: true, error: '当前生成环境未提供可恢复的 SD 接收编号；请核对原任务，本批不会重新提交。' }
          let generationError: unknown
          const url = await runJob(plan.job, { disableLora: plan.disableLora, requestKey: input.requestKey, signal: input.signal,
            onAcceptedId: input.accepted, resumeId: input.taskId,
            onError: error => { generationError = error },
            onAccepted: task => input.accepted(task.taskId) })
          if (!url) return batchFailure(input, generationError || new Error(sd.errorMsg.value || 'SD 生成失败'), batchDraw.runtimeOwned())
          input.signal.throwIfAborted()
          const response = await runtimeFetch(url, { cache: 'no-store', signal: input.signal })
          if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) throw new Error('成片响应不是图片')
          const blob = await response.blob()
          return save({ kind: 'image', entry: { ...plan.history, blob, seed: input.seed >= 0 ? input.seed : sd.resultSeed.value ?? undefined,
            ...(input.taskId && batchDraw.runtimeOwned() ? { taskId: input.taskId } : sd.resultTaskId?.value ? { taskId: sd.resultTaskId.value } : {}) } })
        }
        const nativeBlocker = !input.reconnect && deps.animaState.value.provider === 'native' && nativeAnimaRequestBlocker(deps.animaState.value.models, plan.request)
        if (nativeBlocker) return { ok: false, error: nativeBlocker }
        if (!input.reconnect) await input.admit()
        checkPlanOwner()
        const result = await animaTransport.run(plan.request, plan.context, () => batchDraw.cancelRequested.value, input.report,
          { requestKey: input.requestKey, onAccepted: input.accepted, signal: input.signal, resumeId: input.reconnect ? input.taskId : undefined,
            onSubmitting: input.submitting,
            reconnect: input.reconnect, family: plan.engine })
        if ('taskId' in result) return save({ kind: 'task', taskId: result.taskId })
        return save({ kind: 'image', entry: { ...batchHistoryFromMetadata(plan, result.metadata), blob: result.blob, seed: result.seed } })
      } catch (error) {
        if (!input.taskId && !input.reconnect && batchDraw.cancelRequested.value && error instanceof Error && error.name === 'AbortError') return { ok: false, cancelled: true }
        return batchFailure(input, error, batchDraw.runtimeOwned())
      }
    },
  })

  const disposeBatch = batchDraw.dispose
  batchDraw.dispose = () => { animaTransport.dispose(); disposeBatch() }
  const resetBatch = batchDraw.reset
  batchDraw.reset = async () => {
    const keys = batchDraw.jobs.value.map(job => job.requestKey)
    await resetBatch()
    if (!batchDraw.jobs.value.length) { keys.forEach(key => pendingSaves.delete(key)); updateArtworkSource() }
  }

  /** 按场景蓝图启动批量出图 */
  async function onBatchStart(payload: { sceneIds: string[]; count: number }) {
    startError.value = ''
    if (batchDraw.running.value || batchDraw.resetting.value) return
    if (batchDraw.progress.value.unresolved) return rejectStart('请先核对本批已接收任务，再开启新计划。')
    const captured = captureBatch()
    const scenes = captured.sceneTargets(payload.sceneIds)
    if (!scenes.length) return rejectStart('所选场景没有可用的描述')
    const baseSeed = captured.selectedSeed()
    planOwner = { repository: artworkRepository, authority: batchSaveAuthority(), owner: tempResultOwner() }
    // The persisted transport lane is Anima; each prepared recipe retains its Anima/Krea family.
    const previousJobs = batchDraw.jobs.value
    await batchDraw.start(scenes, payload.count, baseSeed, '个场景', { engine: 'anima', runtimeOwned: hasRuntimeTasks() })
    return batchDraw.jobs.value !== previousJobs
  }

  /** 按多角色启动批量漫游出图（相同词条，不同角色） */
  async function onBatchStartCharacters(payload: { characterIds: string[]; count: number; basePrompt?: string }) {
    startError.value = ''
    if (batchDraw.running.value || batchDraw.resetting.value) return
    if (batchDraw.progress.value.unresolved) return rejectStart('请先核对本批已接收任务，再开启新计划。')
    const captured = captureBatch()
    let targets: ReturnType<typeof captured.characterTargets>
    try { targets = captured.characterTargets(payload.characterIds, payload.basePrompt) }
    catch (error) { return rejectStart(error instanceof Error ? error.message : String(error)) }
    if (!targets.length) return rejectStart('所选角色无效')
    const baseSeed = captured.selectedSeed()
    planOwner = { repository: artworkRepository, authority: batchSaveAuthority(), owner: tempResultOwner() }
    const previousJobs = batchDraw.jobs.value
    await batchDraw.start(targets, payload.count, baseSeed, '位角色', { engine: 'anima', runtimeOwned: hasRuntimeTasks() })
    return batchDraw.jobs.value !== previousJobs
  }

  /** 只重跑失败/已取消的张：自适应从场景蓝图或角色表恢复 */
  async function onRetryFailed() {
    if (batchDraw.running.value || batchDraw.resetting.value) return
    const failedJobs = batchDraw.jobs.value
      .filter(job => job.status === 'failed' || job.status === 'cancelled')
    if (!failedJobs.length) return

    await batchDraw.retryFailed()
  }

  useTrackedTask(() => ({ kind: 'batch', title: `批量出图 · ${batchDraw.progress.value.total} 张`, route: '/prompt-builder?taskCenter=batch', resultRoute: batchDraw.progress.value.succeeded ? '/gallery?batch=' + encodeURIComponent(String(batchDraw.jobs.value.filter(job => job.historyId != null).at(-1)?.historyId || '')) : undefined, status: batchDraw.running.value ? 'running' : !batchDraw.jobs.value.length ? 'idle' : batchDraw.progress.value.unresolved || batchDraw.progress.value.remaining ? 'interrupted' : batchDraw.progress.value.failed ? 'failed' : batchDraw.progress.value.cancelled ? 'cancelled' : 'succeeded', progress: batchDraw.progress.value.total ? batchDraw.progress.value.done / batchDraw.progress.value.total * 100 : null, message: `${batchDraw.jobs.value.find(job => job.status === 'running' || job.status === 'accepted')?.message || ''} ${batchDraw.progress.value.succeeded} 张成功 · ${batchDraw.progress.value.failed} 张失败 · ${batchDraw.progress.value.remaining} 张未执行 · ${batchDraw.progress.value.unresolved} 张待核对` }), { cancel: batchDraw.cancel, retry: () => batchDraw.progress.value.unresolved || batchDraw.progress.value.remaining ? batchDraw.resume() : onRetryFailed() })
  return { batchDraw, startError, onBatchStart, onBatchStartCharacters, onRetryFailed, pendingImage: pendingBatchImage }
}
