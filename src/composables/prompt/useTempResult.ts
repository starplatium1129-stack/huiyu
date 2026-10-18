import { runtimeFetch } from '../../platform/runtimeUrl.ts'
import { computed, onScopeDispose, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { usePromptBuilderStore, HistoryEntry } from '../../stores/promptBuilderStore.ts'
import type { DrawEngine } from '../../storage/settingsRepository.ts'
import type { AnimaResult, AnimaResultContext } from '../../types/anima.ts'
import type { useAnimaSession } from '../generation/useAnimaSession.ts'
import type { useLegacySdTasks } from '../generation/useLegacySdTasks.ts'
import { hasRuntimeTasks, isRuntimeTaskId } from '../../api/runtimeTaskAuthority.ts'
import { artworkRepository, type ArtworkRepository } from '../../storage/artworkRepository.ts'
import { ArtworkSaveSupersededError, type ArtworkCommitIdentity, type GeneratedArtworkInput } from '@/application/artwork/artworkSaveInput'
import { registerMigrationArtworkSource } from '@/platform/web/migrationBarrier'
import {
  readTempResult,
  tempResultOwner, resolveTempResultOwner, sameTempResultOwner,
  type TempResultRecord,
  type TempResultOwner,
} from '../../utils/tempResult.ts'

type PromptBuilderStore = ReturnType<typeof usePromptBuilderStore>
type AnimaSession = ReturnType<typeof useAnimaSession>
type SaveIntent = { url: string; input: GeneratedArtworkInput; repository: ArtworkRepository; owner: TempResultOwner;
  prepared?: ArtworkCommitIdentity; markerStable?: boolean; source?: PendingAnimaSource;
  binding?: { beforeAppend(pending: ArtworkCommitIdentity): Promise<void> };
  admission?: SaveIntent['binding']; flight?: Promise<HistoryEntry | null> }
export type PendingAnimaSource = { key: string; result: AnimaResult; context: AnimaResultContext | null;
  repository: ArtworkRepository; owner?: TempResultOwner; intent?: SaveIntent }
// A failed temporary capture is still the only copy. Page disposal cannot
// authorize migration or discard the same save intent that a remount can resume.
const pendingAnimaSources = new Map<string, PendingAnimaSource>()
let releaseAnimaSource: (() => void) | undefined
function updateAnimaSource() {
  if (pendingAnimaSources.size) releaseAnimaSource ??= registerMigrationArtworkSource(() => pendingAnimaSources.size > 0)
  else { releaseAnimaSource?.(); releaseAnimaSource = undefined }
}
function settleAnimaSource(source?: PendingAnimaSource) {
  if (source && pendingAnimaSources.get(source.key) === source) pendingAnimaSources.delete(source.key)
  updateAnimaSource()
}
let tempMutation = 0

export interface TempResultDeps {
  pb: PromptBuilderStore
  sd: ReturnType<typeof useLegacySdTasks>
  drawEngine: Ref<DrawEngine>
  animaState: AnimaSession['state']
  patchAnimaState: AnimaSession['patchState']
  displayResultUrl: ComputedRef<string>
  displayResultSeed: ComputedRef<number | null>
  generationBusy: ComputedRef<boolean>
  livePrompt: ComputedRef<string>
  negativePrompt: ComputedRef<string>
  historyGenerationFields: () => Partial<HistoryEntry>
  /** F3 冻结上下文（SD 路径由 usePromptSdQueue 写入；Anima 读会话 state）。 */
  resultContext: Ref<AnimaResultContext | null>
  autoSaveToGallery: Ref<boolean>
  onResultRetained(result: AnimaResult): Promise<void>
  setDrawEngine: (engine: DrawEngine, options?: { restoreExistingResult?: boolean }) => void
}

/**
 * 绘图页「未入册成片」临时缓冲（2026-09-06 体验报告 F2）。
 *
 * 生命周期契约：
 * - 直出成片保留媒体及当前资料草稿指针；未确认入册身份不得被新图覆盖；
 * - 入册成功（自动或手动「保存快照」）→ 清除；用户点「清除」→ 清除；
 * - 离页/刷新后回页 → restoreTempResult 重建舞台结果（Anima 含完整元数据）。
 *
 * 同时收编「舞台结果 ↔ 作品册条目」锚点（displayedResultHistoryId）与手动
 * 入册动作（原 saveHistory），让「这张图入没入册」有单一事实来源。
 */
export function useTempResult(deps: TempResultDeps) {
  const { pb, sd } = deps

  /** 舞台当前结果对应的作品册条目 id（null=尚未入册；原 P1-14 inpaint 锚点）。 */
  const displayedResultHistoryId = ref<string | number | null>(null)
  const savingResult = ref(false)
  let resultRevision = 0
  let generationRevision = 0
  let disposed = false
  let saveIntent: SaveIntent | null = null
  let legacyResultUrl = '', legacyRecord: TempResultRecord | null = null
  const ownedSources = new Set<string>()
  let generationRuntimeOwned = hasRuntimeTasks(), generationPending = false
  let generationRepository = artworkRepository, generationOwner: TempResultOwner | undefined
  let releaseGenerationSource: (() => void) | undefined
  const sourceFor = (url: string) => [...pendingAnimaSources.values()].find(source => source.result.url === url)
  async function handoffSource(source?: PendingAnimaSource) {
    if (source) await deps.onResultRetained(source.result)
    settleAnimaSource(source)
  }
  function retainAnimaSource(result: AnimaResult, context: AnimaResultContext | null) {
    let source = [...pendingAnimaSources.values()].find(item => item.result.blob === result.blob)
    if (!source) {
      source = { key: result.url, result: { ...result, metadata: freeze(result.metadata) }, context: freeze(context),
        repository: generationRepository, owner: generationOwner }
      pendingAnimaSources.set(source.key, source); updateAnimaSource()
    }
    ownedSources.add(source.key)
    legacyResultUrl = result.url
    if (source.repository !== artworkRepository) throw new Error('原图所属作品库已变化，请回到原工作区保存')
    source.owner ??= tempResultOwner()
    return source
  }
  const sourcePartial = (source: PendingAnimaSource): Omit<TempResultRecord, 'imageId' | 'savedAt'> => {
    const metadata = source.result.metadata
    return { engine: metadata.engine, prompt: metadata.prompt, negative: metadata.negative, seed: metadata.seed,
      size: `${metadata.width}x${metadata.height}`, animaMetadata: metadata, context: source.context }
  }
  watch(deps.displayResultUrl, () => {
    resultRevision += 1
    displayedResultHistoryId.value = null
    releaseSaveIntent()
    legacyResultUrl = ''; legacyRecord = null
  }, { flush: 'sync' })
  // An empty canvas still belongs to the new attempt, including after failure
  // or cancellation. A late startup restore must not replace that attempt.
  watch(deps.generationBusy, busy => {
    if (busy) {
      generationRevision += 1; generationRuntimeOwned = hasRuntimeTasks()
      generationRepository = artworkRepository; generationOwner = undefined
      try { generationOwner = tempResultOwner() } catch { /* Hold until the original source can be identified. */ }
      if (!generationRuntimeOwned) {
        generationPending = true
        releaseGenerationSource ??= registerMigrationArtworkSource(() => generationPending)
      }
    } else queueMicrotask(() => {
      // Completion publishes phase before calling onResult. Let that same stack
      // register its Blob first; failure/cancellation only retires the busy guard.
      if (!deps.generationBusy.value) { generationPending = false; releaseGenerationSource?.(); releaseGenerationSource = undefined }
    })
  }, { flush: 'sync', immediate: true })
  onScopeDispose(() => {
    disposed = true; resultRevision += 1; releaseSaveIntent(); legacyRecord = null
    generationPending = false; releaseGenerationSource?.(); releaseGenerationSource = undefined
  }, true)
  function releaseSaveIntent() {
    const intent = saveIntent; saveIntent = null
    if (!intent?.prepared || intent.markerStable || intent.input.pendingCommit
      || intent.source && pendingAnimaSources.has(intent.source.key)) return
    try {
      const retained = readTempResult(), alias = intent.prepared.entry.image_id!
      if (retained?.imageId !== alias && retained?.pendingCommit?.entry.image_id !== alias)
        void intent.repository.deleteImage(alias).catch(() => {})
    } catch { /* A pointer that cannot be read may still own this media. */ }
  }
  function ownsResult(url: string) {
    const revision = resultRevision
    return () => !disposed && revision === resultRevision && deps.displayResultUrl.value === url
  }
  const storedResultUrl = ref('')
  const resultTemporary = computed(() => Boolean(deps.displayResultUrl.value && storedResultUrl.value === deps.displayResultUrl.value))

  /** 舞台徽章：有结果时如实标注入册状态（未入册的其实已在临时缓冲）。 */
  const resultArchived = computed<boolean | null>(() =>
    deps.displayResultUrl.value ? displayedResultHistoryId.value !== null : null)

  /** 替换式写入：先读旧记录，新记录落稳后回收旧 blob（不炸主链路）。 */
  async function captureTemp(partial: Omit<TempResultRecord, 'imageId' | 'savedAt'>, blob: Blob, url = deps.displayResultUrl.value, current = ownsResult(url)) {
    if (legacyResultUrl !== url && hasRuntimeTasks() && (isRuntimeTaskId(partial.animaMetadata?.id || '') || (sd.resultUrl.value === url && sd.resultTaskId?.value))) {
      if (current()) storedResultUrl.value = url
      return
    }
    if (!current()) return
    const mutation = ++tempMutation, source = sourceFor(url), repository = source?.repository ?? artworkRepository
    try {
      const owner = source?.owner ?? tempResultOwner(), snapshot = freeze(partial)
      if (repository !== artworkRepository || !sameTempResultOwner(owner)) throw new Error('原图属于另一资料来源，请恢复原工作区')
      if (source) source.owner ??= owner
      const { captureTempResult } = await import('./tempResultActions')
      await captureTempResult({ partial: snapshot, blob, repository, owner }, {
        current: () => mutation === tempMutation && current() && repository === artworkRepository && sameTempResultOwner(owner),
        pending: () => source?.intent?.prepared, durable: () => handoffSource(source), flash: message => pb.flash(message),
        publish: record => { storedResultUrl.value = url; legacyResultUrl = url; legacyRecord = record },
      })
    } catch (error) {
      console.warn('[temp-result] capture failed', error)
      if (current()) pb.flash('临时成片保存失败：请入册，或下载原图后明确清除，再离开')
    }
  }

  /** Acknowledged archive/discard clears the pointer before releasing owned temp media. */
  async function releaseTemp(saved?: HistoryEntry, discard = false) {
    const record = readTempResult(), repository = artworkRepository
    if (!discard && (storedResultUrl.value && storedResultUrl.value !== deps.displayResultUrl.value
      || record?.pendingCommit && (!saved || String(record.pendingCommit.entry.id) !== String(saved.id)))) return
    const owner = record ? resolveTempResultOwner(record) : tempResultOwner()
    const revision = tempMutation, archived = saved ? { image_id: saved.image_id } : undefined
    const { releaseTempResult } = await import('./tempResultActions')
    await releaseTempResult({ record, repository, owner, revision, saved: archived }, {
      mutation: () => tempMutation, claim: () => ++tempMutation, cleared: () => { storedResultUrl.value = '' },
    })
  }

  /** 舞台当前结果的 F3 冻结上下文（Anima 在会话 state，SD 在 resultContext ref）。 */
  function currentContext(): AnimaResultContext | null {
    return deps.drawEngine.value !== 'sd'
      ? (deps.animaState.value.resultContext ?? null)
      : deps.resultContext.value
  }

  function matchingLegacy(url: string, metadataId?: string, prompt?: string): TempResultRecord | null {
    const stored = readTempResult()
    return stored && (legacyResultUrl === url && legacyRecord?.imageId === stored.imageId
      || stored.animaMetadata && metadataId && stored.animaMetadata.id === metadataId && stored.prompt === prompt) ? stored : null
  }
  function createSaveIntent(input: GeneratedArtworkInput, url: string, current: () => boolean,
    partial: Omit<TempResultRecord, 'imageId' | 'savedAt'>, record: TempResultRecord | null,
    repository = artworkRepository, owner = record ? resolveTempResultOwner(record) : tempResultOwner()): SaveIntent {
    const source = sourceFor(url)
    const intent: SaveIntent = { input, url, repository, owner, source }
    if (source) source.intent = intent
    if (input.taskId) return intent
    input.pendingCommit = record?.pendingCommit
    input.beforeAppend = pending => {
      // Each flight pins its mounted observer. A remount can bind the next
      // attempt, but cannot authorize an earlier await belonging to a dead view.
      const admission = intent.admission
      if (!admission) throw new ArtworkSaveSupersededError(false)
      return admission.beforeAppend(pending)
    }
    bindSaveIntent(intent, url, current, partial, record)
    return intent
  }
  function bindSaveIntent(intent: SaveIntent, url: string, current: () => boolean,
    partial: Omit<TempResultRecord, 'imageId' | 'savedAt'>, record: TempResultRecord | null) {
    const { repository, owner } = intent, capturedMutation = tempMutation
    intent.url = url
    intent.binding = { beforeAppend: async pending => {
      intent.prepared = pending
      const { admitTempResultSave } = await import('./tempResultActions')
      await admitTempResultSave(pending, { repository, owner, url, partial, record, capturedMutation }, {
        current, mutation: () => tempMutation, claim: () => ++tempMutation, storedUrl: () => storedResultUrl.value,
        retainedSource: () => Boolean(intent.source && pendingAnimaSources.get(intent.source.key) === intent.source),
        markerStable: () => { intent.markerStable = true }, durable: () => handoffSource(intent.source),
        publish: published => { storedResultUrl.value = url; legacyResultUrl = url; legacyRecord = published },
      })
    } }
  }
  function commitIntent(intent: SaveIntent) {
    if (!sameTempResultOwner(intent.owner) || intent.repository !== artworkRepository) throw new Error('作品库身份已变化，请回到原工作区保存原画面')
    if (intent.flight) return intent.flight
    intent.admission = intent.binding
    return intent.flight = pb.commitHistoryEntry(intent.input, intent.repository).then(saved => {
      if (saved) settleAnimaSource(intent.source)
      return saved
    }).finally(() => { intent.flight = undefined; intent.admission = undefined })
  }

  /** Anima/Krea 直出成功：按偏好入册或落临时缓冲（原 onAnimaResult 内联块下沉）。 */
  const freeze = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
  async function handleAnimaResult(result: AnimaResult) {
    const current = ownsResult(result.url)
    try {
      const source = !generationRuntimeOwned || sourceFor(result.url)
        ? retainAnimaSource(result, deps.animaState.value.resultContext ?? null) : undefined
      const autoSave = deps.autoSaveToGallery.value
      const record = matchingLegacy(result.url, result.metadata.id, result.metadata.prompt)
      const repository = source?.repository ?? artworkRepository, owner = source?.owner ?? (record ? resolveTempResultOwner(record) : tempResultOwner())
      if (!sameTempResultOwner(owner) || repository !== artworkRepository) throw new Error('原图所属资料来源已变化，请回到原工作区保存')
      const active = () => current() && repository === artworkRepository && sameTempResultOwner(owner)
      const runtimeTaskId = !source && !record && legacyResultUrl !== result.url && hasRuntimeTasks() && isRuntimeTaskId(result.metadata.id) ? result.metadata.id : undefined
      if (!autoSave) {
        if (current()) displayedResultHistoryId.value = null
        if (runtimeTaskId) { storedResultUrl.value = result.url; return }
      }
      const input = { result: { ...result, metadata: freeze(result.metadata) }, current: active,
        context: freeze(deps.animaState.value.resultContext ?? null), autoSave, runtimeTaskId,
        history: autoSave ? freeze(deps.historyGenerationFields()) : {},
        story: autoSave ? String(pb.story || '').trim() : '', scene: autoSave ? pb.sceneId : null }
      const { handleAnimaResultAction } = await import('./tempResultActions')
      await handleAnimaResultAction(input, { pb, displayedResultHistoryId, captureTemp, releaseTemp,
        commitResult: async entry => {
          if (!active()) return null
          if (!saveIntent || saveIntent.url !== result.url) saveIntent = source?.intent ?? createSaveIntent(entry, result.url, active,
            { engine: result.metadata.engine, prompt: result.metadata.prompt, negative: result.metadata.negative, seed: result.metadata.seed,
              size: `${result.metadata.width}x${result.metadata.height}`, animaMetadata: input.result.metadata, context: input.context }, record, repository, owner)
          const intent = saveIntent
          const saved = await commitIntent(intent)
          if (saved && saveIntent === intent) saveIntent = null
          return saved
        } })
    } catch (error) {
      console.warn('[temp-result] completion capture failed', error)
      if (current()) pb.flash('原图尚未落稳，迁移已暂停；请恢复连接后保存，或下载原图后明确清除')
    }
  }

  /** 手动「保存快照」（原 saveHistory 下沉）：入册成功即释放临时缓冲。 */
  async function saveCurrentResult() {
    if (savingResult.value || displayedResultHistoryId.value !== null) return
    savingResult.value = true
    try {
      const url = deps.displayResultUrl.value
      if (!url) { pb.flash('暂无可保存的成片'); return }
      const current = ownsResult(url)
      const cached = sourceFor(url)
      if ((!saveIntent || saveIntent.url !== url) && cached?.intent) {
        saveIntent = cached.intent
        bindSaveIntent(saveIntent, url, current, sourcePartial(cached), matchingLegacy(url, cached.result.metadata.id, cached.result.metadata.prompt))
      }
      if (!saveIntent || saveIntent.url !== url) {
        const stored = readTempResult()
        const animaResult = deps.drawEngine.value !== 'sd' ? deps.animaState.value.result : null
        const record = matchingLegacy(url, animaResult?.metadata.id, animaResult?.metadata.prompt)
        if (stored?.pendingCommit && !record) { pb.flash('上次入册回执尚未核对，原恢复指针已保留；请先恢复原成片或显式清除'); return }
        if (record && legacyRecord && record.imageId !== legacyRecord.imageId) throw new Error('临时成片指针已变化，请先恢复原记录')
        const repository = cached?.repository ?? artworkRepository, owner = cached?.owner ?? (record ? resolveTempResultOwner(record) : tempResultOwner())
        if (repository !== artworkRepository || !sameTempResultOwner(owner)) throw new Error('原图所属资料来源已变化，请回到原工作区保存')
        if (cached) cached.owner ??= owner
        const frozen = cached ? cached.context : currentContext()
        const snapshot = JSON.parse(JSON.stringify({
          taskId: !record && legacyResultUrl !== url && hasRuntimeTasks() ? deps.drawEngine.value === 'sd' ? sd.resultTaskId?.value : isRuntimeTaskId(deps.animaState.value.result?.metadata.id || '') ? deps.animaState.value.result?.metadata.id : undefined : undefined,
          context: frozen, seed: deps.displayResultSeed.value ?? undefined,
          ...deps.historyGenerationFields(), story: frozen?.story,
          scene: frozen ? (frozen.sceneId ?? null) : undefined,
          parentId: frozen?.parentId,
        })) as Partial<HistoryEntry>
        const resultPrompt = sd.resultPrompt.value
        let blob: Blob
        let prompt = deps.livePrompt.value
        let negative = deps.negativePrompt.value
        if (deps.drawEngine.value !== 'sd') {
          const result = deps.animaState.value.result
          if (!result) { pb.flash('成片数据已失效，请重新生成'); return }
          blob = result.blob
          prompt = result.metadata.prompt
          negative = result.metadata.negative
        } else {
          const response = await runtimeFetch(url, { cache: 'no-store', signal: AbortSignal.timeout(30_000) })
          const contentType = response.headers.get('content-type') || ''
          if (!response.ok || !contentType.startsWith('image/')) {
            pb.flash('成片响应无效，请重新生成')
            return
          }
          blob = await response.blob()
          // 按图取词：SD 结果记录的是提交时实际使用的提示词，面板后续修改不漂移。
          prompt = resultPrompt || frozen?.history?.prompt || prompt
          negative = frozen?.history?.negative ?? negative
        }
        if (!blob.size) { pb.flash('成片数据已失效，请重新生成'); return }
        if (!current()) return
        const input: GeneratedArtworkInput = {
          ...snapshot,
          blob,
          negative,
          prompt,
          pendingCommit: record?.pendingCommit,
        }
        const partial = freeze({ engine: deps.drawEngine.value, prompt, negative, seed: snapshot.seed ?? null,
          size: snapshot.size || '', animaMetadata: animaResult?.metadata ?? null, context: frozen })
        saveIntent = createSaveIntent(input, url, current, partial, record, repository, owner)
      }
      const intent = saveIntent
      if (!intent) return
      // Start persistence now: compatibility defaults and the first repository
      // are captured before loading completion UI. Observe rejection immediately.
      const outcome = commitIntent(intent).then(entry => ({ entry }), error => ({ error }))
      const { finishManualTempSave } = await import('./tempResultActions')
      await finishManualTempSave(outcome, {
        current: () => current() && intent.repository === artworkRepository && sameTempResultOwner(intent.owner),
        pb, displayedResultHistoryId, releaseTemp,
        forget: () => { if (saveIntent === intent) saveIntent = null },
      })
    } catch (e) { if (!disposed && deps.displayResultUrl.value) pb.flash('入册未成功，画面仍在画布上，请重试或下载原图'); console.warn(e) }
    finally { savingResult.value = false }
  }

  /**
   * 回页找回上次未入册的成片（F1/F2 交汇）。只在画布为空时调用；
   * 返回是否发生了恢复（调用方据此提示）。
   */
  async function restoreTempResult(): Promise<boolean> {
    if (deps.displayResultUrl.value || deps.generationBusy.value) return false
    const current = ownsResult('')
    const revision = generationRevision
    const candidates = [...pendingAnimaSources.values()].filter(source => source.repository === artworkRepository
      && (!source.owner || sameTempResultOwner(source.owner)))
    const source = candidates.at(-1)
    try { if (source) source.owner ??= tempResultOwner() }
    catch (error) { pb.flash(error instanceof Error ? error.message : '原图来源暂时无法核对，图片仍保留'); return false }
    let restoreActions: typeof import('./tempResultRestore')
    try { restoreActions = await import('./tempResultRestore') }
    catch { if (current()) pb.flash('成片恢复模块暂时无法读取，原图与恢复身份已保留'); return false }
    const { restorePendingAnimaSource, restoreUnarchivedResult } = restoreActions
    if (source) {
      const restored = await restorePendingAnimaSource(source, deps, {
        current: () => current() && revision === generationRevision && !deps.generationBusy.value
          && source.repository === artworkRepository && Boolean(source.owner && sameTempResultOwner(source.owner)),
        retained: () => pendingAnimaSources.get(source.key) === source,
        adopt: () => { candidates.forEach(candidate => ownedSources.add(candidate.key)) },
        bind: cached => {
          legacyResultUrl = cached.result.url
          if (cached.intent) {
            saveIntent = cached.intent
            bindSaveIntent(saveIntent, cached.result.url, ownsResult(cached.result.url), sourcePartial(cached),
              matchingLegacy(cached.result.url, cached.result.metadata.id, cached.result.metadata.prompt))
          }
        },
        capture: cached => captureTemp(sourcePartial(cached), cached.result.blob, cached.result.url, ownsResult(cached.result.url)),
      })
      if (restored !== null) return restored
    }
    return restoreUnarchivedResult(deps, storedResultUrl,
      () => current() && revision === generationRevision && !deps.generationBusy.value,
      (record, url) => { legacyResultUrl = url; legacyRecord = record })
  }

  /** 用户显式「清除」舞台结果：临时缓冲一并丢弃（显式丢弃优于一切恢复）。 */
  function discardTemp() {
    const animaResult = deps.drawEngine.value !== 'sd' ? deps.animaState.value.result : null
    let legacy = legacyResultUrl === deps.displayResultUrl.value
    try { legacy ||= Boolean(matchingLegacy(deps.displayResultUrl.value, animaResult?.metadata.id, animaResult?.metadata.prompt)) }
    catch { legacy = true }
    const taskId = !legacy && hasRuntimeTasks() ? deps.drawEngine.value === 'sd' ? sd.resultTaskId?.value : animaResult?.metadata.id : undefined
    resultRevision += 1
    ownedSources.forEach(key => settleAnimaSource(pendingAnimaSources.get(key)))
    ownedSources.clear()
    releaseSaveIntent(); legacyRecord = null; legacyResultUrl = ''
    void releaseTemp(undefined, true).catch(() => pb.flash('临时成片清除尚未确认，恢复指针已保留，请恢复连接后重试'))
    if (taskId && isRuntimeTaskId(taskId)) void import('@/api/runtimeTasks').then(api => api.markRuntimeTask(taskId, 'discarded'))
      .catch(() => pb.flash('清除尚未同步到收件箱，请在任务中心核对'))
  }

  return {
    displayedResultHistoryId,
    resultArchived,
    savingResult,
    resultTemporary,
    handleAnimaResult,
    saveCurrentResult,
    restoreTempResult,
    discardTemp,
  }
}
