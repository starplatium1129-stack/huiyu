import { assertRequestOwner, clearRequestDraft, writeRequestDraft } from '@/storage/requestDraft'
import { computed, ref, toRaw, type Ref } from 'vue'
import { ApiClientError, type ApiClient } from '@/api/client'
import { AcceptedTaskTerminalError } from '@/api/acceptedTaskOutcome'
import { assertDirectImageRuntime } from '@/api/directImageJobs'
import { cancelDirectImageRequest, DirectImageRequestRejected } from '@/api/directImageRequests'
import { hasRuntimeTasks } from '@/api/runtimeTaskAuthority'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'
import { readTempResult, resolveTempResultOwner, sameTempResultOwner } from '@/utils/tempResult'
import { IMAGE_REQUEST_DRAFT_KEY } from '@/utils/storageKeys'
import { newImageRequestDraft, readImageRequestDraft, type ImageRequestDraft } from '@/storage/imageRequestDraft'
import type { AnimaGenerationState, AnimaResult } from '@/types/anima'
import { nativeAnimaRequestBlocker } from './nativeAnimaCapabilities'
import { automaticMaskBlocker } from './animaBackendReadiness'
import { animaRequestPayload, type AnimaRequest, type AnimaSessionOptions, type AnimaSubmission } from './animaSessionContract'

const busy = (state: AnimaGenerationState) => ['submitting', 'running', 'cancelling'].includes(state.phase)
/** Owns a single frozen request across page lifetimes; transports own acceptance/observation. */
export function useAnimaTask(options: AnimaSessionOptions, client: ApiClient, state: Ref<AnimaGenerationState>, view: {
  capture(overrides?: Partial<AnimaRequest>): AnimaSubmission | null
  patch(patch: Partial<AnimaGenerationState>): void
  stash(): void; discardStashed(): void
}) {
  const pending = ref<ImageRequestDraft | null>(null), storageError = ref('')
  let serial = 0, disposed = false, flight = false, controller: AbortController | null = null
  let activeRuntime = '', cancellation: Promise<void> | null = null
  let resultIdentityWrite: Promise<void> | null = null
  const completed = new WeakMap<Blob, AnimaSubmission>()
  const hasPending = computed(() => Boolean(pending.value || storageError.value))
  function restorePending() {
    try { pending.value = readImageRequestDraft(IMAGE_REQUEST_DRAFT_KEY); storageError.value = '' }
    catch (error) { storageError.value = error instanceof Error ? error.message : String(error) }
    if (pending.value && sameTempResultOwner(pending.value.owner)) options.activateResult(pending.value.submission.family)
    if (hasPending.value && !busy(state.value)) view.patch({ phase: 'failed', backendStatus: 'unknown', statusText: storageError.value || '原图片请求已保留，可重新查询进度与结果', errorMsg: '', errorReport: null })
    return hasPending.value
  }
  async function acknowledge(draft: ImageRequestDraft) {
    await clearRequestDraft(IMAGE_REQUEST_DRAFT_KEY, draft)
    if (pending.value?.key === draft.key) pending.value = null
  }
  async function acknowledgeResult(result: AnimaResult) {
    const draft = pending.value
    if (draft?.resultId === result.metadata.id) { await resultIdentityWrite; await acknowledge(draft) }
  }
  async function discardResult(result: AnimaResult) {
    const draft = pending.value
    if (draft?.resultId === result.metadata.id) await acknowledge(draft)
  }
  function resultSubmission(): AnimaSubmission | null {
    const result = state.value.result, submission = result && completed.get(toRaw(result.blob))
    return result && submission && Number.isSafeInteger(result.metadata.seed) && result.metadata.seed >= 0
      ? JSON.parse(JSON.stringify({ ...submission, request: { ...submission.request, seed: result.metadata.seed } })) as AnimaSubmission : null
  }
  async function generate(overrides: Partial<AnimaRequest> = {}, frozen?: AnimaSubmission, recoverOnly = false): Promise<void> {
    if (disposed || flight || busy(state.value)) return
    restorePending()
    if (storageError.value) { options.flash(storageError.value); return }
    let draft = pending.value
    if (recoverOnly && !draft) { options.flash('当前没有待查询的图片请求'); return }
    const submission = draft?.submission ?? (frozen ? JSON.parse(JSON.stringify({ ...frozen, request: { ...frozen.request, ...overrides } })) as AnimaSubmission : view.capture(overrides))
    if (!submission) return
    const { request, family } = submission, runtime = hasRuntimeTasks()
    const provider = state.value.provider === 'native' ? 'native' : 'comfy'
    if (!draft) {
      if (frozen && family !== options.getFamily()) { options.flash('创作引擎已更换，请重新确认后提交'); return }
      if (!state.value.online && !state.value.managedStartAvailable) { options.flash(`绘图服务尚未就绪。${state.value.checkMsg}`); return }
      const blocker = state.value.provider === 'native' && nativeAnimaRequestBlocker(state.value.models, request)
        || request.maskPrompt && automaticMaskBlocker(state.value)
      if (blocker) { options.flash(blocker); return }
    }
    const requestSerial = ++serial, abort = new AbortController()
    flight = true
    controller = abort; activeRuntime = runtimeResourceIdentity()
    const current = () => !disposed && !abort.signal.aborted && requestSerial === serial
    const resuming = Boolean(draft?.submitted)
    let posted = false, accepted = resuming
    try {
      if (draft) {
        assertRequestOwner(draft, runtime)
        const retained = readTempResult()
        if (draft.resultId && retained?.animaMetadata?.id === draft.resultId) {
          resolveTempResultOwner(retained)
          await acknowledge(draft)
          await options.restoreResult()
          view.patch({ phase: state.value.result ? 'succeeded' : 'idle', backendStatus: undefined, statusText: '原成片已交给临时缓冲恢复', errorMsg: '', errorReport: null })
          return
        }
      }
      view.patch({ phase: 'submitting', backendStatus: undefined, statusText: resuming ? '查询原请求…' : '准备绘图…', errorMsg: '', errorReport: null })
      // All lazy code and local preparation precede durable admission.
      const transport = runtime ? await import('./runtimeImageSession') : await import('./animaJobPolling')
      if (!resuming && isLocalStudioHost()) await client.request('/api/local-setup/llama', { method: 'DELETE', signal: abort.signal, timeoutMs: 15_000, validate: value => value.ok === true })
      if (!current()) return
      assertDirectImageRuntime(activeRuntime)
      if (!draft) {
        draft = newImageRequestDraft(submission, runtime)
        pending.value = draft
        await writeRequestDraft(IMAGE_REQUEST_DRAFT_KEY, draft)
      }
      assertRequestOwner(draft, runtime)
      if (!draft.submitted) { draft.submitted = true; await writeRequestDraft(IMAGE_REQUEST_DRAFT_KEY, draft) }
      if (!current()) return
      assertDirectImageRuntime(activeRuntime)
      view.stash()
      view.patch({ phase: 'submitting', backendStatus: undefined, job: null, currentNode: null, resultContext: null, progress: null, elapsedSeconds: 0,
        progressText: resuming ? '正在查询原请求…' : '正在提交绘图…', statusText: resuming ? '恢复原图片任务…' : '提交任务…', errorMsg: '', errorReport: null })
      const owned = draft
      const onResult = async (result: AnimaResult) => {
        assertRequestOwner(owned, hasRuntimeTasks())
        view.patch({ phase: 'running', statusText: '成片已生成，正在保存恢复信息…', progressText: '正在保存成片…' })
        owned.resultId = result.metadata.id
        const stable = writeRequestDraft(IMAGE_REQUEST_DRAFT_KEY, owned)
        resultIdentityWrite = stable
        void stable.catch(() => {})
        completed.set(toRaw(result.blob), JSON.parse(JSON.stringify(submission)) as AnimaSubmission)
        if (runtime) { await stable; await acknowledge(owned) } // The private inbox already owns the result.
        // Register direct bytes synchronously, before awaiting the draft flush.
        // Its durable handoff awaits this same identity write before clearing it.
        if (current()) await options.onResult(result)
        await stable
        if (current() && state.value.result?.url === result.url) view.patch(pending.value?.key === owned.key
          ? { phase: 'failed', backendStatus: 'unknown', statusText: '原图尚未落稳，可继续保存或明确清除', errorMsg: '', errorReport: null }
          : { phase: 'succeeded', backendStatus: undefined, statusText: runtime ? '生成完成 · 已保存在收件箱' : '生成完成', progressText: '生成完成' })
      }
      assertRequestOwner(draft, hasRuntimeTasks())
      if ('runRuntimeAnima' in transport) await transport.runRuntimeAnima({ input: animaRequestPayload(request), key: draft.key, resume: resuming,
        signal: abort.signal, family, context: submission.context, state, isCurrent: () => current() && sameTempResultOwner(owned.owner),
        onSubmitting: () => { assertRequestOwner(owned, hasRuntimeTasks()); posted = true }, onAccepted: () => { accepted = true }, discardStashed: view.discardStashed, onResult })
      else await transport.runDirectAnima({ client, request, family, signal: abort.signal, current, requestKey: draft.key, resume: resuming,
        state, context: submission.context, patch: view.patch, discardStashed: view.discardStashed, onResult })
    } catch (error) {
      if (!current()) return
      const definitive = error instanceof DirectImageRequestRejected || error instanceof AcceptedTaskTerminalError
        || runtime && posted && !accepted && error instanceof ApiClientError && error.kind === 'http' && error.status < 500
      if (definitive && draft) {
        try { await acknowledge(draft) } catch (failure) { options.flash(failure instanceof Error ? failure.message : String(failure)) }
      }
      const { imageFailurePatch } = await import('./runtimeImageSession')
      if (!current()) return
      view.patch(error instanceof AcceptedTaskTerminalError && error.status === 'cancelled'
        ? { phase: 'cancelled', statusText: '任务已取消', errorMsg: '', errorReport: null }
        : { ...imageFailurePatch(error, hasPending.value ? '原请求已保留，请重新查询' : '生成失败', provider), ...(hasPending.value ? { backendStatus: 'unknown' } : {}) })
    } finally { if (controller === abort) controller = null; flight = false }
  }
  async function cancelOnce() {
    const draft = pending.value
    if (!draft?.submitted) { serial++; controller?.abort(); view.patch({ phase: 'cancelled', statusText: '已停止准备', errorMsg: '' }); return }
    const currentSerial = serial
    view.patch({ phase: 'cancelling', statusText: '正在记录取消请求…', errorMsg: '' })
    try {
      assertRequestOwner(draft, hasRuntimeTasks())
      if (draft.transport === 'runtime') {
        const { cancelRuntimeTaskKey } = await import('@/api/runtimeTasks')
        assertRequestOwner(draft, hasRuntimeTasks())
        const task = await cancelRuntimeTaskKey(draft.key)
        if (serial !== currentSerial) return
        if (!task || task.status === 'cancelled' && task.upstreamSettled && task.recoveryState === 'normal') {
          await acknowledge(draft)
          serial++; controller?.abort()
          view.patch({ phase: 'cancelled', backendStatus: undefined, statusText: '任务已取消', errorMsg: '', errorReport: null })
          return
        }
      } else await cancelDirectImageRequest(draft.submission.family, draft.key, activeRuntime, client)
      if (serial !== currentSerial || pending.value?.key !== draft.key) return
      serial++; controller?.abort()
      view.patch({ phase: 'failed', backendStatus: 'unknown', statusText: '取消意图已记录，请查询原请求确认结果', errorMsg: '', errorReport: null })
    } catch (error) { if (serial === currentSerial) view.patch({ statusText: '取消尚未确认，可重试停止或查询原请求', errorMsg: error instanceof Error ? error.message : String(error) }) }
  }
  function cancel() { return cancellation ??= cancelOnce().finally(() => { cancellation = null }) }
  function dispose() { disposed = true; serial++; controller?.abort(); controller = null }
  return { generate, recover: () => generate({}, undefined, true), restorePending, hasPending, acknowledgeResult, discardResult, resultSubmission, cancel, dispose }
}
