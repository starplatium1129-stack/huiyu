import { computed, shallowRef, ref, onActivated, onDeactivated, onScopeDispose } from 'vue'
import { acceptVideoRequest, cancelVideoRequest } from '@/api/videoRequests'
import { DirectRequestRejected } from '@/api/directGenerationRequests'
import { TaskSubmissionRejected } from '@/api/acceptedTaskOutcome'
import { hasRuntimeTasks } from '@/api/runtimeTasks'
import type { VideoJob, VideoBatch } from '@/api/videoApi'
import { assertRequestOwner, clearRequestDraft, writeRequestDraft } from '@/storage/requestDraft'
import { newTaskRequestDraft, readTaskRequestDraft, type TaskRequestDraft } from '@/storage/taskRequestDraft'

type Result = VideoJob | VideoBatch
export const videoRequestSettled = (value: Result | null) => Boolean(value && value.upstreamSettled && !value.unknown
  && ('shots' in value ? value.status !== 'running' && !value.needsReview : ['succeeded', 'failed', 'cancelled'].includes(value.status)))

/** The submission journal owns admission; route selections only own presentation. */
export function useVideoRequest(kind: 'video' | 'batch', slot: string, onRetired?: (draft: TaskRequestDraft) => Promise<void>) {
  let lifetime = new AbortController()
  let commandVersion = 0
  onDeactivated(() => lifetime.abort())
  onActivated(() => { if (lifetime.signal.aborted) lifetime = new AbortController() })
  onScopeDispose(() => lifetime.abort())
  const observeSignal = (signal?: AbortSignal) => signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
  const request = shallowRef<TaskRequestDraft | null>(null), verified = shallowRef<Result | null>(null), issue = ref('')
  try {
    request.value = readTaskRequestDraft(slot)
    if (request.value && request.value.kind !== kind) throw new Error('原视频请求类型不符，已保留记录')
    const draft = request.value, tokens = draft?.details?.tokens
    if (draft?.kind === 'batch' && !draft.details?.retrySource && (!Array.isArray(tokens) || !tokens.length
      || !Array.isArray(draft.input.shots) || tokens.length !== draft.input.shots.length
      || tokens.some(token => typeof token !== 'string' || !token) || new Set(tokens).size !== tokens.length))
      throw new Error('原镜头来源凭据无效，已保留请求；请在任务中心核对')
  } catch (error) { issue.value = error instanceof Error ? error.message : '原视频请求无法读取' }
  const adopting = computed(() => Boolean(request.value && Array.isArray(request.value.details?.tokens) && request.value.details?.adopted !== true))
  const unconfirmed = computed(() => Boolean(issue.value || adopting.value || request.value && (!verified.value || verified.value.unknown || verified.value.needsReview)))
  const pending = computed(() => Boolean(unconfirmed.value || request.value && !videoRequestSettled(verified.value)))
  function check() {
    if (issue.value) throw new Error(issue.value)
    if (request.value) assertRequestOwner(request.value, hasRuntimeTasks())
  }
  function guard(owned: TaskRequestDraft, signal: AbortSignal, version: number) {
    signal.throwIfAborted()
    if (version !== commandVersion || request.value?.key !== owned.key) throw new DOMException('原视频读取已由新操作接管', 'AbortError')
    check(); assertRequestOwner(owned, hasRuntimeTasks())
  }
  async function accepted(value: Result, current: () => void) {
    current()
    const next = { ...request.value!, taskId: value.id }
    await writeRequestDraft(slot, next)
    current()
    // Adoption can finish during the flush. Publish the latest journal details,
    // never the older snapshot captured by an observation or command.
    request.value = { ...request.value!, taskId: value.id }; verified.value = value
    return value
  }
  function update(value: Result) {
    check()
    if (request.value?.taskId === value.id) verified.value = value
  }
  async function retire(owned: TaskRequestDraft, current: () => void) {
    current()
    await onRetired?.(owned)
    current()
    await clearRequestDraft(slot, owned)
    current()
    request.value = null; verified.value = null
  }
  async function confirmAdoption() {
    check()
    const owned = request.value
    if (!owned) return
    const signal = observeSignal(), version = commandVersion
    const current = () => guard(owned, signal, version)
    current()
    const next = { ...owned, details: { ...owned.details, adopted: true } }
    await writeRequestDraft(slot, next)
    current()
    request.value = { ...request.value!, details: { ...request.value!.details, adopted: true } }
  }
  async function observe(signal: AbortSignal) {
    check()
    const owned = request.value
    if (!owned) return null
    const observation = observeSignal(signal), version = commandVersion
    const current = () => guard(owned, observation, version)
    try {
      current()
      return await accepted(await acceptVideoRequest(owned, { signal: observation, resume: true }), current)
    }
    catch (error) {
      current()
      if (error instanceof DirectRequestRejected) await retire(owned, current)
      throw error
    }
  }
  async function submit(input: Record<string, unknown>, signal: AbortSignal, context?: Record<string, unknown>, details?: Record<string, unknown>) {
    check()
    const observation = observeSignal(signal)
    observation.throwIfAborted()
    if (pending.value) throw new Error('请先核对原视频请求，不能重复提交')
    const version = ++commandVersion
    if (request.value) {
      const previous = request.value
      await clearRequestDraft(slot, previous)
      guard(previous, observation, version); request.value = null
    }
    const owned = { ...newTaskRequestDraft(kind, input, hasRuntimeTasks(), context, details), submitted: true }
    const current = () => guard(owned, observation, version)
    request.value = owned; verified.value = null
    await writeRequestDraft(slot, owned)
    try {
      current()
      return await accepted(await acceptVideoRequest(owned, { signal: observation }), current)
    }
    catch (error) {
      current()
      // Only a durable rejection proves that no execution was accepted.
      if (error instanceof DirectRequestRejected || error instanceof TaskSubmissionRejected && error.requestKey === owned.key) await retire(owned, current)
      throw error
    }
  }
  async function cancel(signal?: AbortSignal) {
    check()
    const owned = request.value
    if (!owned) return null
    const observation = observeSignal(signal), version = ++commandVersion
    const current = () => guard(owned, observation, version)
    current()
    const value = await cancelVideoRequest(owned, observation)
    if (value) return accepted(value, current)
    await retire(owned, current)
    return null
  }
  return { request, pending, unconfirmed, issue, check, update, observe, submit, cancel, confirmAdoption }
}
