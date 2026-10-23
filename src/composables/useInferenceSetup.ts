import { computed, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue'
import { ApiClientError } from '@/api/client'
import { inferenceSetupApi, isInferenceSetupOperation, isPreparedInferencePaths, type InferenceSetupOperation, type InferenceSetupResult, type InferenceModelInspection, type ModelImportInput, type RuntimePreparationInput, type PreparedInferencePaths, type ManagedInferenceInput, type NativeSetupPlan } from '@/api/inferenceSetupApi'
import type { InferenceSettings } from '@/api/inferenceSettingsApi'
import { localSetupApi } from '@/api/localSetupApi'
import { waitLocalSetupOperation } from '@/api/localSetupOperation'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'
import { getDesktopCapabilities } from '@/platform/desktop/capabilities'
import { readSetupRecovery, saveSetupRecovery, type SetupRecovery } from '@/storage/inferenceSetupRecovery'
import { flushProfileWrites } from '@/platform/web/profileStorage'

type Submission = { kind: 'prepare-inference-runtime'; input: RuntimePreparationInput }
  | { kind: 'import-inference-model'; input: ModelImportInput }
  | { kind: 'install-native-runtime' | 'download-native-model' | 'download-native-resource' | 'prepare-native-engine'; input: ManagedInferenceInput }

export function useInferenceSetup(configured: Ref<InferenceSettings>, blocked: Ref<boolean>, onActivated: () => void) {
  const desktop = getDesktopCapabilities()
  const plan = shallowRef<NativeSetupPlan | null>(null)
  const basePython = ref(''), wheelhouse = ref(''), workspacePath = ref(''), runtimeReviewed = ref(false), reviewed = ref(false)
  const hfToken = ref('')
  const checkpointPath = ref('')
  const resourceId = ref(''), resourceReviewed = ref(false)
  const selectedResource = computed(() => plan.value?.resources.find(value => value.id === resourceId.value))
  const modelId = ref(''), sourceDir = ref(''), importModelId = ref('anima-miaomiao-v1.6'), importReviewed = ref(false)
  const inspection = shallowRef<InferenceModelInspection | null>(null), inspecting = ref(false)
  const preparedPaths = shallowRef<PreparedInferencePaths | null>(null)
  const operation = shallowRef<InferenceSetupOperation | null>(null)
  const busy = ref(false), checking = ref(false), activating = ref(false), restarting = ref(false), operationUncertain = ref(false)
  const workspaceOpen = ref(false), workspaceOpening = ref(false), workspaceDraft = ref(''), workspaceSaving = ref(false), workspacePending = ref(false)
  const workspaceButton = ref<HTMLElement | null>(null), workspaceError = ref('')
  const message = ref(''), error = ref(''), cancelState = ref<'idle' | 'pending' | 'accepted' | 'failed'>('idle')
  const hasRunningOperation = computed(() => operation.value?.status === 'running')
  const locked = computed(() => blocked.value || busy.value || checking.value || inspecting.value || activating.value || restarting.value || workspaceOpening.value || workspaceSaving.value || operationUncertain.value)
  const currentPlan = computed(() => !!plan.value && plan.value.freeBytes !== null && !workspacePending.value && plan.value.workspacePath === workspacePath.value && plan.value.selectedModelId === modelId.value)
  const canDownloadResource = computed(() => !locked.value && currentPlan.value && resourceReviewed.value && selectedResource.value
    && !selectedResource.value.prepareError && selectedResource.value.freeBytes !== null
    && selectedResource.value.freeBytes >= selectedResource.value.requiredBytes)
  const selectedModel = computed(() => plan.value?.models.find(model => model.id === modelId.value))
  const runtimeSpaceEnough = computed(() => !!plan.value && plan.value.freeBytes !== null && plan.value.freeBytes >= plan.value.runtime.requiredBytes)
  const modelSpaceEnough = computed(() => !!plan.value && !!selectedModel.value && plan.value.freeBytes !== null && plan.value.freeBytes >= selectedModel.value.requiredBytes)
  const canInstall = computed(() => !locked.value && currentPlan.value && plan.value?.supported && reviewed.value && !plan.value.runtime.installed && runtimeSpaceEnough.value)
  const checkpointReady = computed(() => !selectedModel.value?.checkpointFilename || selectedModel.value.installed || !!checkpointPath.value.trim())
  const canDownload = computed(() => !locked.value && currentPlan.value && plan.value?.supported && reviewed.value && plan.value.runtime.installed && selectedModel.value && !selectedModel.value.installed && modelSpaceEnough.value && checkpointReady.value)
  const canActivate = computed(() => !locked.value && currentPlan.value && plan.value?.supported && plan.value.runtime.installed && selectedModel.value?.installed)
  const nativeEnabled = computed(() => currentPlan.value && plan.value?.supported && plan.value.workspaceMatches && plan.value.activeEngine === 'native' && !plan.value.restartRequired && plan.value.runtime.installed && selectedModel.value?.installed)
  const setupRequiredBytes = computed(() => (plan.value?.runtime.installed ? 0 : plan.value?.runtime.requiredBytes ?? 0) + (selectedModel.value?.requiredBytes ?? 0))
  const setupSpaceEnough = computed(() => plan.value?.freeBytes !== null && plan.value?.freeBytes !== undefined && plan.value.freeBytes >= setupRequiredBytes.value)
  const canSetup = computed(() => !locked.value && currentPlan.value && plan.value?.supported && selectedModel.value && reviewed.value && setupSpaceEnough.value && !nativeEnabled.value && checkpointReady.value)
  const canPrepare = computed(() => !locked.value && currentPlan.value && !preparedPaths.value && runtimeReviewed.value && !!basePython.value.trim() && !!wheelhouse.value.trim())
  const canInspect = computed(() => !locked.value && currentPlan.value && !!sourceDir.value.trim() && !!configured.value.modelsRoot)
  const canImport = computed(() => !locked.value && currentPlan.value && !!inspection.value && importReviewed.value)
  const canCancel = computed(() => hasRunningOperation.value && operation.value?.cancelAllowed !== false && !['pending', 'accepted'].includes(cancelState.value))
  let disposed = false, observing = false, inspectionVersion = 0, planVersion = 0, workspaceOpenVersion = 0
  let inspectionController: AbortController | null = null, planController: AbortController | null = null, activationController: AbortController | null = null
  let recovery: SetupRecovery | null = null
  let cancelRequest: Promise<void> | null = null
  const local = () => !disposed && isLocalStudioHost()
  const causeText = (cause: unknown) => cause instanceof Error ? cause.message : '操作未完成，请查看控制室日志'
  async function ensureCurrentWorkspace() {
    const binding = await desktop?.getWorkspace()
    if (binding && (binding.restartRequired || binding.activeRoot !== plan.value?.workspacePath)) {
      workspacePending.value = true; workspaceDraft.value = binding.root; reviewed.value = false; preparedPaths.value = null
      throw new Error('AI 工作区已改变，请重启绘遇后重新检查；当前操作尚未提交')
    }
  }
  function workspaceChanged() {
    workspaceOpenVersion++; workspaceOpening.value = false
    workspacePending.value = true; reviewed.value = false; preparedPaths.value = null; invalidateInspection()
    planVersion++; planController?.abort(); checking.value = false
    void refreshPlan()
  }
  const focused = () => { if (!locked.value) void refreshPlan() }
  if (desktop) {
    window.addEventListener('huiyu:ai-workspace-changed', workspaceChanged)
    window.addEventListener('focus', focused)
  }
  function invalidateInspection() {
    inspectionVersion++; inspectionController?.abort(); inspection.value = null; importReviewed.value = false
  }
  watch([importModelId, sourceDir, () => configured.value.modelsRoot, () => configured.value.python, () => configured.value.worker], invalidateInspection, { flush: 'sync' })
  watch([basePython, wheelhouse, workspacePath], () => { runtimeReviewed.value = false; preparedPaths.value = null }, { flush: 'sync' })
  watch([modelId, () => plan.value?.planId, workspacePending], () => { reviewed.value = false }, { flush: 'sync' })
  watch(modelId, () => { checkpointPath.value = '' }, { flush: 'sync' })
  watch([resourceId, () => plan.value?.planId, () => selectedResource.value?.root, workspacePending], () => { resourceReviewed.value = false }, { flush: 'sync' })

  async function refreshPlan() {
    if (!local() || checking.value) return
    checking.value = true
    if (!workspaceOpen.value) workspaceError.value = ''
    const revision = ++planVersion
    planController?.abort(); planController = new AbortController()
    try {
      const [result, binding] = await Promise.all([inferenceSetupApi.getPlan(planController.signal, modelId.value || undefined), desktop?.getWorkspace()])
      if (disposed || revision !== planVersion) return
      if (binding && binding.activeRoot !== result.workspacePath) throw new Error('当前 AI 工作区与运行时目录不一致，请重启绘遇后重新检查')
      workspacePending.value = binding?.restartRequired ?? false
      // Background readiness owns the saved state, not an open directory draft.
      if (!workspaceOpen.value) workspaceDraft.value = binding?.root ?? result.workspacePath
      if (workspacePath.value !== result.workspacePath) {
        workspacePath.value = result.workspacePath; invalidateInspection()
        if (operation.value?.status !== 'running') operation.value = null
      }
      plan.value = result
      if (!result.resources.some(value => value.id === resourceId.value)) resourceId.value = result.resources[0]?.id ?? ''
      if (!result.models.some(model => model.id === modelId.value)) modelId.value = result.models[0]?.id ?? ''
      if (error.value.startsWith('读取原生配置清单失败：')) error.value = ''
      return true
    } catch (cause) {
      if (!disposed && revision === planVersion) { plan.value = null; error.value = '读取原生配置清单失败：' + causeText(cause) }
    } finally { if (!disposed && revision === planVersion) checking.value = false }
  }
  function belongsToWorkspace(value: InferenceSetupOperation): boolean {
    if (!plan.value) return false
    if (value.workspacePath) return value.workspacePath === plan.value.workspacePath
    // Legacy imports have no workspace field; only recover the current configured target.
    return value.kind === 'import-inference-model' && value.modelsRoot === configured.value.modelsRoot
      && configured.value.modelsRoot === plan.value.paths.modelsRoot
  }
  function complete(value: InferenceSetupOperation) {
    if (!belongsToWorkspace(value)) throw new Error('此准备结果属于其他工作区，请重新检查当前目录')
    if (isPreparedInferencePaths(value.preparedPaths)) preparedPaths.value = { ...value.preparedPaths }
    if (value.kind === 'import-inference-model') invalidateInspection()
    message.value = value.kind === 'prepare-inference-runtime' ? '离线运行库准备完成。可填入高级路径并保存；真实生成尚未验证。'
      : value.kind === 'import-inference-model' ? '完整目录已复制。此导入仅检查布局，请继续核对组件与兼容性。'
      : value.kind === 'prepare-native-engine' ? '准备完成，原生引擎设置已保存。'
      : value.kind === 'install-native-runtime' ? '运行库已就绪。'
      : value.kind === 'download-native-resource' ? `所选资源已完成完整文件校验${value.resourceRoot ? `，保存于 ${value.resourceRoot}` : ''}。回到创作页重新检测资源；若刚修改了模型目录，请先重启绘遇。实际生成效果仍待设备验收。`
      : '原生模型已下载并完成组件校验，接下来启用原生引擎。'
    if (cancelState.value === 'accepted') message.value += ' 取消请求前操作已完成，以此终态为准。'
    if (value.kind === 'prepare-native-engine') onActivated()
  }
  async function observe(result: InferenceSetupResult) {
    if (disposed || observing) return
    observing = true; busy.value = true; operationUncertain.value = false
    operation.value = { ...result.operation, preparedPaths: result.operation.preparedPaths ?? result.preparedPaths }
    const id = operation.value.id
    let finished = false
    try {
      await waitLocalSetupOperation(result, {
        timeoutMs: 4 * 60 * 60 * 1000,
        // Disposing detaches this observer. Cancel only through the explicit operation-ID request.
        onOperation(value) {
          if (disposed) throw new Error('停止观察')
          if (!isInferenceSetupOperation(value) || value.id !== id || !belongsToWorkspace(value)) throw new Error('后台操作或工作区已改变，请重新核对状态')
          operation.value = { ...value, preparedPaths: value.preparedPaths ?? operation.value?.preparedPaths }
        },
        onMessage(value) { if (!disposed) message.value = cancelState.value === 'accepted' ? '已请求取消，等待后台确认结束：' + value : value },
      })
      if (!disposed && operation.value) { await cancelRequest; complete(operation.value); finished = true }
    } catch (cause) {
      if (!disposed) {
        if (operation.value?.status === 'failed') {
          error.value = causeText(cause)
          message.value = operation.value.interrupted ? '上次准备因运行时退出而中断，已完成文件保留；确认原安装器退出后，可重新核对清单。' : '当前步骤已结束，已完成文件保留。核对错误后可重试此步骤。'
          finished = true
        } else { operationUncertain.value = true; error.value = '状态尚未确认，后台操作可能仍在运行。' + causeText(cause) }
      }
    } finally {
      observing = false
      if (!disposed) {
        if (!hasRunningOperation.value && !operationUncertain.value) { await cancelRequest }
        busy.value = hasRunningOperation.value || operationUncertain.value
        if (finished) await refreshPlan()
      }
    }
  }
  async function reconcile() {
    if (!local() || checking.value || observing || !plan.value) return
    checking.value = true
    try {
      recovery = readSetupRecovery(plan.value.workspacePath)
      if (recovery && recovery.workspace !== plan.value.workspacePath) throw new Error('原操作属于其他 AI 工作区，请切回原目录核对结果')
      const result = await localSetupApi.getOperation(undefined, recovery?.id ?? operation.value?.id)
      if (disposed) return
      if (recovery && !result.operation && result.runtimeId !== recovery.runtimeId) {
        await saveSetupRecovery(recovery.workspace, null); recovery = null; operation.value = null
        operationUncertain.value = false; busy.value = false; error.value = ''; message.value = '上次请求未被后台接收，可以重新确认清单。'; return
      }
      const value = result.operation
      // A completed historic receipt is not evidence for the current plan. The
      // plan reads installed resources; recover only an operation still in flight.
      if (!operation.value && !recovery && value?.status !== 'running') {
        operationUncertain.value = false; busy.value = false
        return
      }
      const own = isInferenceSetupOperation(value) && belongsToWorkspace(value)
        && (operation.value ? value.id === operation.value.id : recovery ? value.id === recovery.id : true)
      if (!own) {
        if (recovery || (operation.value?.status === 'running' && belongsToWorkspace(operation.value))) throw new Error('尚未找到原编号的记录；请勿重复提交。重新检查仍无记录时，完全退出并重启绘遇后再次检查')
        operation.value = null; operationUncertain.value = false; busy.value = false
        if (value?.status === 'running') {
          error.value = ''; message.value = '另一项准备正在进行，可在对应入口查看进度。完成后再检查原生引擎。'
        }
        return
      }
      error.value = ''; checking.value = false
      await observe({ ok: true, operation: value })
    } catch (cause) { if (!disposed) { operationUncertain.value = true; error.value = causeText(cause) } }
    finally { if (!disposed) checking.value = false }
  }
  async function selectModel(value: string) {
    if (locked.value) return
    modelId.value = value; hfToken.value = ''; reviewed.value = false
    await refreshPlan()
  }
  async function recheck() {
    if (!local() || checking.value || (busy.value && !operationUncertain.value) || observing) return
    // Explicit checks also recover background work after a failed initial read.
    // Internal plan refreshes must not start another operation observer.
    if (await refreshPlan()) await reconcile()
  }
  async function start(next: Submission) {
    busy.value = true; error.value = ''; message.value = ''; cancelState.value = 'idle'; operation.value = null; preparedPaths.value = null
    let posted = false
    try {
      await ensureCurrentWorkspace()
      const before = await localSetupApi.getOperation()
      if (disposed) return
      if (before.operation?.status === 'running') throw new Error('控制室另有操作正在运行，请等待结束后重试')
      if (!before.runtimeId) throw new Error('运行时版本尚不支持操作恢复，请更新并重启绘遇')
      const id = crypto.randomUUID()
      recovery = { id, workspace: workspacePath.value, runtimeId: before.runtimeId }
      await saveSetupRecovery(recovery.workspace, recovery)
      if (disposed) return
      await ensureCurrentWorkspace()
      next.input.operationId = id; posted = true
      hfToken.value = ''
      const result = next.kind === 'prepare-inference-runtime' ? await inferenceSetupApi.prepareRuntime(next.input)
        : next.kind === 'import-inference-model' ? await inferenceSetupApi.importModel(next.input)
        : next.kind === 'prepare-native-engine' ? await inferenceSetupApi.prepareEngine(next.input)
        : next.kind === 'install-native-runtime' ? await inferenceSetupApi.installRuntime(next.input)
        : next.kind === 'download-native-resource' ? await inferenceSetupApi.downloadResource(next.input) : await inferenceSetupApi.downloadModel(next.input)
      if ('hfToken' in next.input) delete next.input.hfToken
      if (result.operation.id !== recovery?.id) throw new Error('返回的操作编号与提交编号不同，请核对原操作')
      if (!disposed) await observe(result)
    } catch (cause) {
      if ('hfToken' in next.input) delete next.input.hfToken
      if (disposed) return
      if (posted && !(cause instanceof ApiClientError && cause.kind === 'http' && cause.status >= 400 && cause.status < 500 && cause.code !== 'OPERATION_EXISTS')) {
        operationUncertain.value = true; error.value = '请求结果尚未确认，正在核对后台操作；请勿重复提交。'; await reconcile()
      } else {
        error.value = causeText(cause)
        try { if (recovery) await saveSetupRecovery(recovery.workspace, null); recovery = null }
        catch (saveError) { operationUncertain.value = true; error.value += '；' + causeText(saveError) }
        await refreshPlan()
      }
    } finally { if ('hfToken' in next.input) delete next.input.hfToken; if (!disposed) busy.value = hasRunningOperation.value || operationUncertain.value }
  }
  function managedInput(): ManagedInferenceInput { return { workspacePath: workspacePath.value, planId: plan.value!.planId, reviewed: true, modelId: modelId.value,
    ...(selectedModel.value?.checkpointFilename && checkpointPath.value.trim() ? { checkpointPath: checkpointPath.value.trim() } : {}),
    ...(hfToken.value.trim() ? { hfToken: hfToken.value.trim() } : {}) } }
  async function prepareEngine() { if (local() && canSetup.value) await start({ kind: 'prepare-native-engine', input: { ...managedInput(), modelId: modelId.value } }) }
  async function installRuntime() { if (local() && canInstall.value) await start({ kind: 'install-native-runtime', input: managedInput() }) }
  async function downloadModel() { if (local() && canDownload.value) await start({ kind: 'download-native-model', input: { ...managedInput(), modelId: modelId.value } }) }
  async function downloadResource() {
    if (local() && canDownloadResource.value) await start({ kind: 'download-native-resource', input: {
      workspacePath: workspacePath.value, planId: plan.value!.planId, reviewed: true, modelId: resourceId.value, resourceRoot: selectedResource.value!.root,
    } })
  }
  async function activate() {
    if (!local() || !canActivate.value) return
    activating.value = true; error.value = ''; message.value = ''
    activationController = new AbortController()
    try {
      await ensureCurrentWorkspace()
      const input = managedInput()
      hfToken.value = ''
      const result = await inferenceSetupApi.activate(input, activationController.signal).finally(() => { delete input.hfToken })
      if (!disposed) { message.value = result.restartRequired ? '原生引擎设置已保存。请重启绘遇后确认当前运行引擎，再生成第一张图片。' : '原生引擎设置已保存。正在重新检查当前运行引擎。'; onActivated(); await refreshPlan() }
    } catch (cause) {
      if (!disposed) {
        error.value = '启用请求结果尚未确认：' + causeText(cause)
        message.value = '设置可能已保存。请根据重新读取的当前引擎与重启提示继续；当前引擎确认为原生前不视为启用完成。'
        await refreshPlan(); if (!disposed) onActivated()
      }
    } finally { activationController = null; if (!disposed) activating.value = false }
  }
  async function prepare() {
    if (local() && canPrepare.value) await start({ kind: 'prepare-inference-runtime', input: { basePython: basePython.value.trim(), wheelhouse: wheelhouse.value.trim(), workspacePath: workspacePath.value, reviewed: true } })
  }
  async function inspect() {
    if (!local() || !canInspect.value) return
    invalidateInspection(); const version = inspectionVersion
    inspecting.value = true; error.value = ''; message.value = ''; inspectionController = new AbortController()
    try {
      const result = await inferenceSetupApi.inspectModel({ modelId: importModelId.value, sourceDir: sourceDir.value.trim() }, inspectionController.signal)
      if (!disposed && version === inspectionVersion) inspection.value = { ...result }
    } catch (cause) { if (!disposed && version === inspectionVersion) error.value = causeText(cause) }
    finally { if (!disposed) inspecting.value = false }
  }
  async function importModel() {
    if (!local() || !canImport.value) return
    invalidateInspection()
    await start({ kind: 'import-inference-model', input: { modelId: importModelId.value, sourceDir: sourceDir.value.trim(), modelsRoot: configured.value.modelsRoot, reviewed: true } })
  }
  async function cancel() {
    if (!local() || !canCancel.value || cancelRequest) return
    const id = operation.value!.id; cancelState.value = 'pending'
    cancelRequest = (async () => {
      try {
        await localSetupApi.cancelEnvironment(id)
        if (!disposed && operation.value?.id === id) { cancelState.value = 'accepted'; if (hasRunningOperation.value) message.value = '已请求取消，等待后台确认结束…' }
      } catch (cause) { if (!disposed) { cancelState.value = 'failed'; error.value = '取消结果未确认，可重试取消。' + causeText(cause) } }
      finally { cancelRequest = null }
    })()
    await cancelRequest
  }
  async function openWorkspace() {
    if (!desktop || disposed || locked.value || workspaceOpen.value) return
    const revision = ++workspaceOpenVersion
    workspaceOpening.value = true; workspaceError.value = ''
    try {
      const binding = await desktop.getWorkspace()
      if (disposed || revision !== workspaceOpenVersion) return
      workspaceDraft.value = binding.root; workspacePending.value = binding.restartRequired; workspaceOpen.value = true
    } catch (cause) { if (!disposed && revision === workspaceOpenVersion) workspaceError.value = causeText(cause) }
    finally { if (!disposed && revision === workspaceOpenVersion) workspaceOpening.value = false }
  }
  function closeWorkspace() {
    if (workspaceSaving.value) return
    workspaceOpenVersion++; workspaceOpening.value = false; workspaceOpen.value = false
  }
  async function saveWorkspace() {
    if (!desktop || locked.value || !workspaceOpen.value || disposed) return
    workspaceSaving.value = true; workspaceError.value = ''
    try {
      const result = await desktop.setWorkspace(workspaceDraft.value.trim())
      if (!disposed) {
        workspaceDraft.value = result.root; workspacePending.value = result.restartRequired; workspaceOpen.value = false
        preparedPaths.value = null; reviewed.value = false; message.value = ''; if (!hasRunningOperation.value) operation.value = null
        await refreshPlan()
      }
    } catch (cause) { if (!disposed) workspaceError.value = causeText(cause) }
    finally { if (!disposed) workspaceSaving.value = false }
  }
  async function openFolder() {
    if (!desktop || disposed) return
    try { if (!await desktop.openWorkspace()) throw new Error('打开工作区失败，请根据完整路径打开文件夹') }
    catch (cause) { if (!disposed) workspaceError.value = causeText(cause) }
  }
  async function restart() {
    if (!desktop?.restartForSetup || locked.value || disposed) return
    restarting.value = true; error.value = ''
    try {
      await flushProfileWrites()
      if (disposed) return
      await desktop.restartForSetup()
    }
    catch (cause) { if (!disposed) error.value = '重启未完成，请完全退出并重新打开绘遇。' + causeText(cause) }
    finally { if (!disposed) restarting.value = false }
  }
  // Aborting an activation observer only detaches the client; a submitted save
  // may still complete. The next mount must read the plan and active engine.
  onScopeDispose(() => {
    hfToken.value = ''
    disposed = true; workspaceOpenVersion++; planVersion++; inspectionVersion++; planController?.abort(); inspectionController?.abort(); activationController?.abort()
    window.removeEventListener('huiyu:ai-workspace-changed', workspaceChanged); window.removeEventListener('focus', focused)
  })
  return { resourceId, resourceReviewed, selectedResource, canDownloadResource, downloadResource, checkpointPath, hfToken, selectModel, desktop, plan, selectedModel, currentPlan, nativeEnabled, reviewed, setupRequiredBytes, setupSpaceEnough, canSetup, canInstall, canDownload, canActivate,
    basePython, wheelhouse, workspacePath, runtimeReviewed, modelId, importModelId, sourceDir, importReviewed, inspection, inspecting, preparedPaths,
    operation, busy, checking, activating, restarting, locked, canPrepare, canInspect, canImport, canCancel, message, error, cancelState, operationUncertain,
    workspaceOpen, workspaceDraft, workspaceSaving, workspacePending, workspaceButton, workspaceError,
    recheck, prepareEngine, installRuntime, downloadModel, activate, prepare, inspect, importModel, cancel, reconcile,
    openWorkspace, closeWorkspace, saveWorkspace, openFolder, restart }
}
