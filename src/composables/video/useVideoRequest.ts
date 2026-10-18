import { computed, shallowRef, ref, onActivated, onDeactivated, onScopeDispose } from 'vue'
import { acceptVideoRequest, cancelVideoRequest } from '@/api/videoRequests'
import { DirectRequestRejected } from '@/api/directGenerationRequests'
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
  async function accepted(owned: TaskRequestDraft, value: Result) {
    assertRequestOwner(owned, hasRuntimeTasks())
    if (request.value?.key !== owned.key) throw new Error('原视频请求身份已变化')
    owned.taskId = value.id
    await writeRequestDraft(slot, owned)
    check(); request.value = { ...owned }; verified.value = value
    return value
  }
  function update(value: Result) {
    check()
    if (request.value?.taskId === value.id) verified.value = value
  }
  async function retire(owned: TaskRequestDraft) {
    assertRequestOwner(owned, hasRuntimeTasks())
    await onRetired?.(owned)
    await clearRequestDraft(slot, owned)
    request.value = null; verified.value = null
  }
  async function confirmAdoption() {
    check()
    const owned = request.value
    if (!owned) return
    owned.details = { ...owned.details, adopted: true }
    await writeRequestDraft(slot, owned)
    request.value = { ...owned }
  }
  async function observe(signal: AbortSignal) {
    check()
    const owned = request.value
    if (!owned) return null
    try { return await accepted(owned, await acceptVideoRequest(owned, { signal: observeSignal(signal), resume: true })) }
    catch (error) {
      if (error instanceof DirectRequestRejected && request.value?.key === owned.key) await retire(owned)
      throw error
    }
  }
  async function submit(input: Record<string, unknown>, signal: AbortSignal, context?: Record<string, unknown>, details?: Record<string, unknown>) {
    check()
    const observation = observeSignal(signal)
    observation.throwIfAborted()
    if (pending.value) throw new Error('请先核对原视频请求，不能重复提交')
    const owned = newTaskRequestDraft(kind, input, hasRuntimeTasks(), context, details)
    if (request.value) { await clearRequestDraft(slot, request.value); request.value = null }
    owned.submitted = true; request.value = owned; verified.value = null
    await writeRequestDraft(slot, owned)
    try { return await accepted(owned, await acceptVideoRequest(owned, { signal: observation })) }
    catch (error) {
      // Only a durable rejection proves that no execution was accepted.
      if (error instanceof DirectRequestRejected && request.value?.key === owned.key) {
        await retire(owned)
      }
      throw error
    }
  }
  async function cancel(signal?: AbortSignal) {
    check()
    const owned = request.value
    if (!owned) return null
    const value = await cancelVideoRequest(owned, observeSignal(signal))
    if (value) return accepted(owned, value)
    await retire(owned)
    return null
  }
  return { request, pending, unconfirmed, issue, check, update, observe, submit, cancel, confirmAdoption }
}
