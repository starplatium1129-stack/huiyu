import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'
import { ApiClientError } from '@/api/client'
import { inferenceSetupApi, isInferenceSetupOperation, isPreparedInferencePaths, type InferenceSetupApi, type InferenceSetupOperation, type InferenceSetupResult, type InferenceModelInspection, type ModelImportInput, type RuntimePreparationInput, type PreparedInferencePaths } from '@/api/inferenceSetupApi'
import type { InferenceSettings } from '@/api/inferenceSettingsApi'
import { localSetupApi } from '@/api/localSetupApi'
import { waitLocalSetupOperation } from '@/api/localSetupOperation'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'

type Submission = { kind: 'prepare-inference-runtime'; input: RuntimePreparationInput } | { kind: 'import-inference-model'; input: ModelImportInput }

export function useInferenceSetup(configured: Ref<InferenceSettings>, blocked: Ref<boolean>, api: InferenceSetupApi = inferenceSetupApi) {
  const basePython = ref(''), wheelhouse = ref(''), workspacePath = ref(''), runtimeReviewed = ref(false)
  const modelId = ref('anima-miaomiao-v1.6'), sourceDir = ref(''), importReviewed = ref(false)
  const inspection = ref<InferenceModelInspection | null>(null), inspecting = ref(false)
  const preparedPaths = ref<PreparedInferencePaths | null>(null)
  const operation = ref<InferenceSetupOperation | null>(null)
  const busy = ref(false), checking = ref(false), operationUncertain = ref(false)
  const hasRunningOperation = computed(() => operation.value?.status === 'running')
  const message = ref(''), error = ref(''), cancelState = ref<'idle' | 'pending' | 'accepted' | 'failed'>('idle')
  const locked = computed(() => blocked.value || busy.value || checking.value || inspecting.value || operationUncertain.value)
  const canPrepare = computed(() => !locked.value && !preparedPaths.value && runtimeReviewed.value && !!basePython.value.trim() && !!wheelhouse.value.trim() && !!workspacePath.value.trim())
  const canInspect = computed(() => !locked.value && !!sourceDir.value.trim() && !!configured.value.modelsRoot)
  const canImport = computed(() => !locked.value && !!inspection.value && importReviewed.value)
  const canCancel = computed(() => operation.value?.status === 'running' && !['pending', 'accepted'].includes(cancelState.value))
  let disposed = false, observing = false, inspectionVersion = 0
  let inspectionController: AbortController | null = null
  let submission: Submission | null = null, previousOperationId: string | null = null
  let cancelRequest: Promise<void> | null = null
  const local = () => !disposed && isLocalStudioHost()
  const causeText = (cause: unknown) => cause instanceof Error ? cause.message : '操作未完成，请查看控制室日志'
  function invalidateInspection() {
    inspectionVersion++; inspectionController?.abort(); inspection.value = null; importReviewed.value = false
  }
  watch([modelId, sourceDir, () => configured.value.modelsRoot, () => configured.value.python, () => configured.value.worker], invalidateInspection, { flush: 'sync' })
  watch([basePython, wheelhouse, workspacePath], () => { runtimeReviewed.value = false; preparedPaths.value = null }, { flush: 'sync' })

  function matchesPending(value: InferenceSetupOperation): boolean {
    if (!submission || value.id === previousOperationId || value.kind !== submission.kind) return false
    return Object.entries(submission.input).every(([key, valueSent]) => key === 'reviewed' || value[key as keyof InferenceSetupOperation] === valueSent)
  }
  function complete(value: InferenceSetupOperation) {
    if (value.kind === 'prepare-inference-runtime' && isPreparedInferencePaths(value.preparedPaths)) preparedPaths.value = { ...value.preparedPaths }
    if (value.kind === 'import-inference-model') invalidateInspection()
    message.value = value.kind === 'prepare-inference-runtime'
      ? '离线运行库准备完成。可将路径填入设置草稿，再保存并重启；模型与 GPU 出图尚未验证。'
      : '模型目录复制完成。仅通过布局检查，模型加载、GPU 与真实出图尚未验证。'
    if (cancelState.value === 'accepted') message.value += ' 取消请求前操作已完成，以此终态为准。'
  }
  async function observe(result: InferenceSetupResult) {
    if (disposed || observing) return
    observing = true; busy.value = true; operationUncertain.value = false
    operation.value = { ...result.operation, preparedPaths: result.operation.preparedPaths ?? result.preparedPaths }
    const id = operation.value.id
    try {
      await waitLocalSetupOperation(result, {
        timeoutMs: 60 * 60 * 1000,
        // The shared helper cancels on signal abort. Disposal only detaches this observer;
        // cancellation must remain an explicit operation-ID request below.
        onOperation(value) {
          if (disposed) throw new Error('停止观察')
          if (!isInferenceSetupOperation(value) || value.id !== id) throw new Error('后台操作已改变，请重新核对状态')
          operation.value = { ...value, preparedPaths: value.preparedPaths ?? operation.value?.preparedPaths }
        },
        onMessage(value) { message.value = cancelState.value === 'accepted' ? '已请求取消，等待后台确认结束：' + value : value },
      })
      if (!disposed && operation.value) { await cancelRequest; complete(operation.value) }
    } catch (cause) {
      if (!disposed) {
        if (operation.value?.status === 'failed') {
          error.value = causeText(cause)
          message.value = '后台操作已结束。请核对错误与保留文件后再操作。'
        } else {
          operationUncertain.value = true
          error.value = '状态尚未确认，后台操作可能仍在运行。' + causeText(cause)
        }
      }
    } finally {
      observing = false
      if (!disposed) {
        if (operation.value?.status !== 'running' && !operationUncertain.value) { await cancelRequest; submission = null }
        busy.value = hasRunningOperation.value || operationUncertain.value
      }
    }
  }
  async function reconcile() {
    if (!local() || checking.value || observing) return
    checking.value = true
    try {
      const result = await localSetupApi.getOperation()
      if (disposed) return
      const value = result.operation
      const own = isInferenceSetupOperation(value) && (operation.value ? value.id === operation.value.id : submission ? matchesPending(value) : true)
      if (!own) {
        if (submission || operation.value) throw new Error('尚未找到本次操作的确切状态；请勿重复提交，并查看控制室日志')
        if (value?.status === 'running') throw new Error('控制室另有操作正在运行，请等待结束后重试')
        error.value = ''; operationUncertain.value = false; busy.value = false
        return
      }
      error.value = ''
      await observe({ ok: true, operation: value })
    } catch (cause) {
      if (!disposed) { operationUncertain.value = true; error.value = causeText(cause) }
    } finally { if (!disposed) checking.value = false }
  }
  async function start(next: Submission) {
    busy.value = true; error.value = ''; message.value = ''; cancelState.value = 'idle'; operation.value = null
    preparedPaths.value = null
    let posted = false
    try {
      // Remember the existing operation before POST so a lost response never adopts an old receipt.
      const before = await localSetupApi.getOperation()
      if (disposed) return
      if (before.operation?.status === 'running') throw new Error('控制室另有操作正在运行，请等待结束后重试')
      previousOperationId = before.operation?.id ?? null
      submission = next
      posted = true
      const result = next.kind === 'prepare-inference-runtime' ? await api.prepareRuntime(next.input) : await api.importModel(next.input)
      if (!disposed) await observe(result)
    } catch (cause) {
      if (disposed) return
      if (posted && !(cause instanceof ApiClientError && cause.kind === 'http')) {
        operationUncertain.value = true
        error.value = '请求结果尚未确认，正在核对后台操作；请勿重复提交。'
        await reconcile()
      } else { error.value = causeText(cause); submission = null }
    } finally { if (!disposed) busy.value = hasRunningOperation.value || operationUncertain.value }
  }
  async function prepare() {
    if (!local() || !canPrepare.value) return
    await start({ kind: 'prepare-inference-runtime', input: { basePython: basePython.value.trim(), wheelhouse: wheelhouse.value.trim(), workspacePath: workspacePath.value.trim(), reviewed: true } })
  }
  async function inspect() {
    if (!local() || !canInspect.value) return
    invalidateInspection()
    const version = inspectionVersion
    inspecting.value = true; error.value = ''; message.value = ''
    inspectionController = new AbortController()
    try {
      const result = await api.inspectModel({ modelId: modelId.value, sourceDir: sourceDir.value.trim() }, inspectionController.signal)
      if (!disposed && version === inspectionVersion) inspection.value = { ...result }
    } catch (cause) { if (!disposed && version === inspectionVersion) error.value = causeText(cause) }
    finally { if (!disposed) inspecting.value = false }
  }
  async function importModel() {
    if (!local() || !canImport.value) return
    invalidateInspection()
    await start({ kind: 'import-inference-model', input: { modelId: modelId.value, sourceDir: sourceDir.value.trim(), modelsRoot: configured.value.modelsRoot, reviewed: true } })
  }
  async function cancel() {
    if (!local() || !canCancel.value || cancelRequest) return
    const id = operation.value!.id
    cancelState.value = 'pending'
    cancelRequest = (async () => {
      try {
        await localSetupApi.cancelEnvironment(id)
        if (!disposed && operation.value?.id === id) {
          cancelState.value = 'accepted'
          if (operation.value.status === 'running') message.value = '已请求取消，等待后台确认结束…'
        }
      } catch (cause) {
        if (!disposed) { cancelState.value = 'failed'; error.value = '取消结果未确认，可重试取消。' + causeText(cause) }
      } finally { cancelRequest = null }
    })()
    await cancelRequest
  }
  onScopeDispose(() => { disposed = true; inspectionVersion++; inspectionController?.abort() })
  return { basePython, wheelhouse, workspacePath, runtimeReviewed, modelId, sourceDir, importReviewed, inspection, inspecting, preparedPaths,
    operation, busy, checking, locked, canPrepare, canInspect, canImport, canCancel, message, error, cancelState, operationUncertain,
    prepare, inspect, importModel, cancel, reconcile }
}
