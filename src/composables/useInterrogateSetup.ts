import { computed, onScopeDispose, ref, shallowRef } from 'vue'
import { ApiClientError } from '@/api/client'
import { interrogateSetupApi, isInterrogateSetupOperation, type InterrogateSetupInput, type InterrogateSetupOperation, type InterrogateSetupPlan } from '@/api/interrogateSetupApi'
import type { ControlOperationView } from '@/types/api'
import { getDesktopCapabilities } from '@/platform/desktop/capabilities'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'
import { useInterrogateReadiness } from './useInterrogateReadiness'

export function useInterrogateSetup() {
  const readiness = useInterrogateReadiness()
  const plan = shallowRef<InterrogateSetupPlan | null>(null)
  const operation = shallowRef<InterrogateSetupOperation | null>(null)
  const checking = ref(false), submitting = ref(false), operationUncertain = ref(false)
  const operationChecked = ref(false), otherBusy = ref(false), workspacePending = ref(false)
  const message = ref(''), error = ref('')
  const cancelState = ref<'idle' | 'pending' | 'accepted' | 'failed'>('idle')
  const running = computed(() => operation.value?.status === 'running')
  const ready = computed(() => !!plan.value?.ready && readiness.available.value)
  const busy = computed(() => submitting.value || running.value)
  const retryAvailable = computed(() => !ready.value && !running.value && !operationUncertain.value
    && (!!error.value || operation.value?.status === 'failed'))
  const enoughSpace = computed(() => plan.value?.freeBytes !== null && plan.value?.freeBytes !== undefined && plan.value.freeBytes >= plan.value.requiredBytes)
  const canPrepare = computed(() => !!plan.value?.supported && enoughSpace.value && operationChecked.value
    && !workspacePending.value && !ready.value && !busy.value && !checking.value && !otherBusy.value && !operationUncertain.value)
  const canCancel = computed(() => running.value && operation.value?.cancelAllowed === true
    && cancelState.value !== 'pending' && cancelState.value !== 'accepted')
  const desktop = getDesktopCapabilities(), life = new AbortController()
  let disposed = false, polling = false, planVersion = 0, operationVersion = 0, settledId = '', readFailure = ''
  let pending: { input: InterrogateSetupInput; previousId: string | null } | null = null
  let planRead: Promise<void> | null = null
  let timer: ReturnType<typeof setTimeout> | undefined, wake: (() => void) | undefined
  const causeText = (cause: unknown) => cause instanceof Error ? cause.message : '操作未完成，请重新检查'
  const matchesPlan = (value: InterrogateSetupOperation) => !!plan.value && value.workspacePath === plan.value.workspacePath && value.planId === plan.value.planId

  async function refreshPlan() {
    if (disposed || !isLocalStudioHost()) return
    if (planRead) { await planRead; return refreshPlan() }
    checking.value = true
    const version = ++planVersion
    const read = (async () => { try {
      const [next, binding] = await Promise.all([interrogateSetupApi.getPlan(life.signal), desktop?.getWorkspace()])
      if (disposed || version !== planVersion) return
      workspacePending.value = !!binding && (binding.restartRequired || binding.activeRoot !== next.workspacePath)
      plan.value = next
      await readiness.refresh(life.signal)
    } catch (cause) {
      if (!disposed && version === planVersion) { plan.value = null; error.value = '读取反推准备计划失败：' + causeText(cause) }
    } finally { if (!disposed && version === planVersion) checking.value = false } })()
    planRead = read
    try { await read } finally { if (planRead === read) planRead = null; if (!disposed) checking.value = false }
  }

  // A receipt is recovered only by its exact ID or by the submitted plan and
  // workspace with a different ID from the pre-submit operation. Never repost.
  function receive(value: ControlOperationView | null): boolean {
    const own = isInterrogateSetupOperation(value) && matchesPlan(value) ? value : null
    if (pending || running.value) {
      const matches = own && (operation.value?.status === 'running' ? own.id === operation.value.id
        : !!pending && own.id !== pending.previousId && own.workspacePath === pending.input.workspacePath && own.planId === pending.input.planId)
      if (!matches) {
        if (operation.value?.status === 'running' && value?.id !== operation.value.id) {
          // The runtime only replaces a terminal operation. Its old result may
          // already be gone; release observation without inventing success.
          pending = null; operation.value = null; operationUncertain.value = false
          otherBusy.value = value?.status === 'running'; operationChecked.value = true
          error.value = ''; message.value = '原准备操作已结束，结果未保留；正在重新检查组件。'
          return true
        }
        if (ready.value && plan.value?.ready) {
          pending = null; operation.value = null; operationUncertain.value = false
          otherBusy.value = value?.status === 'running'; operationChecked.value = true
          error.value = ''; message.value = '反推已就绪，可以直接使用。'
          return false
        }
        throw new Error('尚未确认本次准备的后台状态，请继续核对进度；不会重复提交。')
      }
    } else if (!own) {
      otherBusy.value = value?.status === 'running'
      operationChecked.value = true
      return false
    }
    if (!own) return false
    if (operationUncertain.value) error.value = ''
    operation.value = { ...own, stages: [...own.stages] }
    otherBusy.value = false; operationChecked.value = true; operationUncertain.value = false
    if (own.status === 'running' || own.id === settledId) return false
    settledId = own.id; pending = null
    if (own.status === 'failed') {
      error.value = own.error || own.message
      message.value = '已完成文件与下载进度保留，点击重试可继续准备。'
    } else { error.value = ''; message.value = '准备完成，正在检查反推是否就绪。' }
    return true
  }

  async function reconcile() {
    if (disposed || submitting.value || !isLocalStudioHost()) return
    if (!plan.value) {
      if (checking.value) return
      await refreshPlan()
      if (disposed || !plan.value) return
    }
    const version = ++operationVersion
    try {
      const result = await interrogateSetupApi.getOperation(life.signal)
      if (disposed || submitting.value || version !== operationVersion) return
      if (error.value === readFailure) error.value = ''
      readFailure = ''
      const wasOtherBusy = otherBusy.value
      const finished = receive(result.operation)
      if (finished || wasOtherBusy && !otherBusy.value) {
        await refreshPlan()
        if (disposed) return
        if (operation.value?.status === 'completed') message.value = ready.value ? '反推已准备好，可以直接使用，无需重启。' : '后台准备已结束，请重新检查反推状态。'
      }
    } catch (cause) {
      if (disposed || version !== operationVersion) return
      operationChecked.value = false
      if (pending || running.value) operationUncertain.value = true
      error.value = readFailure = causeText(cause)
    }
  }

  async function poll() {
    if (polling || disposed || !isLocalStudioHost()) return
    polling = true
    try {
      while (!disposed) {
        await new Promise<void>(resolve => { wake = resolve; timer = setTimeout(resolve, 1500) })
        timer = undefined; wake = undefined
        if (!disposed && !submitting.value && plan.value) await reconcile()
      }
    } finally { polling = false }
  }
  async function refresh() {
    if (disposed || submitting.value || checking.value) return
    error.value = ''
    await refreshPlan()
    if (!disposed) await reconcile()
  }
  async function initialize() {
    if (!isLocalStudioHost()) { error.value = '请在本机控制室准备图片反推。'; return }
    await refresh()
    if (!disposed) void poll()
  }
  async function retry() {
    if (!retryAvailable.value || busy.value || checking.value || otherBusy.value || workspacePending.value || disposed) return
    // Refresh the plan and recover any accepted operation before a new POST.
    await refresh()
    if (!disposed && canPrepare.value) await prepare()
  }
  async function prepare() {
    if (!canPrepare.value || !plan.value || disposed) return
    submitting.value = true; operationVersion++; error.value = ''; message.value = ''; cancelState.value = 'idle'
    let posted = false
    const input: InterrogateSetupInput = { workspacePath: plan.value.workspacePath, planId: plan.value.planId, reviewed: true }
    try {
      const binding = await desktop?.getWorkspace()
      if (disposed) return
      if (binding && (binding.restartRequired || binding.activeRoot !== input.workspacePath)) {
        workspacePending.value = true
        throw new Error('AI 工作区已改变，请先在首次配置中完成目录切换，再重新检查。')
      }
      const before = await interrogateSetupApi.getOperation(life.signal)
      if (disposed) return
      if (before.operation?.status === 'running') {
        receive(before.operation)
        message.value = otherBusy.value ? '控制室另有操作正在进行，请等待结束。' : '已恢复后台准备进度。'
        return
      }
      pending = { input, previousId: before.operation?.id ?? null }; operation.value = null; posted = true
      const result = await interrogateSetupApi.prepare(input, life.signal)
      if (!disposed) {
        receive(result.operation)
        if (result.operation.status !== 'running') {
          await refreshPlan()
          if (!disposed && result.operation.status === 'completed') message.value = ready.value ? '反推已准备好，可以直接使用，无需重启。' : '后台准备已结束，请重新检查反推状态。'
        }
      }
    } catch (cause) {
      if (disposed) return
      if (posted && !(cause instanceof ApiClientError && cause.kind === 'http' && cause.status < 500)) {
        operationUncertain.value = true
        error.value = '接收结果尚未确认，正在核对后台进度；请勿重复提交。'
      } else { pending = null; error.value = causeText(cause) }
    } finally {
      if (!disposed) { submitting.value = false; operationVersion++; await reconcile() }
    }
  }
  async function cancel() {
    if (!canCancel.value || !operation.value || disposed) return
    const id = operation.value.id
    cancelState.value = 'pending'
    try {
      await interrogateSetupApi.cancel(id, life.signal)
      if (!disposed && operation.value?.id === id) { cancelState.value = 'accepted'; message.value = '已请求取消，等待后台结束。' }
    } catch (cause) {
      if (!disposed) { cancelState.value = 'failed'; error.value = '取消尚未确认：' + causeText(cause) }
    } finally { if (!disposed) await reconcile() }
  }
  function workspaceChanged() { workspacePending.value = true; planVersion++; void refreshPlan().then(reconcile) }
  window.addEventListener('huiyu:ai-workspace-changed', workspaceChanged)
  onScopeDispose(() => {
    disposed = true; planVersion++; operationVersion++; life.abort(); clearTimeout(timer); wake?.()
    window.removeEventListener('huiyu:ai-workspace-changed', workspaceChanged)
    // Detach HTTP/polling only. The accepted installation belongs to the runtime.
  })
  return { plan, operation, readiness, checking, submitting, running, busy, ready, enoughSpace, canPrepare, canCancel, retryAvailable, retry,
    otherBusy, workspacePending, operationUncertain, cancelState, error, message, initialize, refresh, reconcile, prepare, cancel }
}
