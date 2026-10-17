import { computed, onMounted, onUnmounted, ref } from 'vue'
import { drawingSetupReadiness } from '../utils/localSetupPreparation.ts'
import { localSetupApi } from '../api/localSetupApi.ts'
import { isLocalStudioHost } from '../utils/runtimeEnvironment.ts'
import { getDesktopCapabilities } from '../platform/desktop/capabilities.ts'
import { STARTER_MODEL_SETTING, settingsRepository } from '../storage/settingsRepository'
import { flushProfileWrites } from '../platform/web/profileStorage'
import type { LocalSetupResponse, LocalSetupVerificationResult, LocalSetupDownloadResult } from '../../types/local-setup.ts'

/** Owns first-setup reads, workspace activation and verification evidence. */
export function useLocalSetup() {
  const isLocal = isLocalStudioHost()
  const desktop = isLocal ? getDesktopCapabilities() : undefined
  const snapshot = ref<LocalSetupResponse | null>(null)
  const selectedModel = ref(settingsRepository.get(STARTER_MODEL_SETTING) || 'anima-miaomiao-v1.6')
  function selectSetupModel(modelId:string) {
    if(selectedModel.value===modelId)return
    selectedModel.value=modelId
    // A model change owns a new readiness check; a late previous result is no longer relevant.
    controller?.abort();controller=null;loading.value=false
    void refresh()
  }
  const restarting = ref(false)
  async function restartForSetup() {
    if (!desktop?.restartForSetup || restarting.value || disposed) return
    restarting.value = true
    workspaceError.value = ''
    try {
      await flushProfileWrites()
      if (!disposed) await desktop.restartForSetup()
    } catch (cause) {
      if (!disposed) workspaceError.value = cause instanceof Error ? cause.message : '重启未完成，请完全退出后重新打开绘遇'
    } finally { restarting.value = false }
  }
  const verificationFailures = ref<Record<string, string>>({})
  const workspacePending = ref(false)
  const workspaceActiveRoot = ref<string | null>(null)
  const workspaceSavedRoot = ref('')
  const workspaceUnconfirmed = computed(() => !!desktop && workspaceActiveRoot.value !== snapshot.value?.workspace.path)
  let workspaceRead = 0
  const loading = ref(false), error = ref(''), cancelled = ref(false)
  let controller: AbortController | null = null
  let disposed = false
  const recommendedModels = computed(() => snapshot.value?.models.filter(model => model.required) ?? [])
  const failedModels = computed(() => recommendedModels.value.filter(model => verificationFailures.value[model.id] === model.path))
  function recordVerification(result: LocalSetupVerificationResult) {
    const failures = { ...verificationFailures.value }
    if (result.state === 'sha256-match') delete failures[result.modelId]
    else failures[result.modelId] = result.path
    verificationFailures.value = failures
  }
  function recordDownload(result: LocalSetupDownloadResult) {
    if (result.state === 'failed') {
      if (result.code === 'MODEL_CONFLICT') verificationFailures.value = { ...verificationFailures.value, [result.modelId]: result.path }
      return
    }
    const failures = { ...verificationFailures.value }; delete failures[result.modelId]; verificationFailures.value = failures
    void refresh()
  }
  const readiness = computed(() => snapshot.value ? drawingSetupReadiness(snapshot.value, selectedModel.value) : null)
  const currentCheck = computed(() => !loading.value && !error.value && !cancelled.value && !workspacePending.value && !workspaceUnconfirmed.value)
  const basicComplete = computed(() => currentCheck.value && failedModels.value.length === 0 && readiness.value?.complete === true)
  const nextStep = computed(() => {
    const value = snapshot.value
    if (loading.value) return '等待本次只读检查，或取消后稍后再试。'
    if (error.value || cancelled.value) return '本次检查尚未确认；保留的路径来自上次结果，请重新检查后再判断准备状态。'
    if (!value) return '重新检查以读取当前配置；此操作不会安装文件或启动服务。'
    if (workspacePending.value) return '完全退出并重启绘遇，让已保存的 AI 工作区生效后重新检查。也可以先在绘图画室准备创作草稿。'
    if (workspaceUnconfirmed.value) return '选择 AI 工作区或重新检查以确认当前目录，再准备环境与模型。'
    if (failedModels.value.length) return `${failedModels.value.map(model => model.label).join('、')} 的完整性校验未通过。重新检查不会清除此问题；请核对文件并重新校验 SHA-256 后再尝试出图。`
    return readiness.value!.nextStep
  })
  async function refresh() {
    if (!isLocal || loading.value || disposed) return
    const request = new AbortController()
    controller = request
    loading.value = true; error.value = ''; cancelled.value = false
    // Keep the download owner mounted; a new snapshot still resets read-only verification.
    if (snapshot.value) snapshot.value = { ...snapshot.value }
    if (desktop) void readWorkspaceBinding()
    try {
      const result = await localSetupApi.getStatus({ signal: request.signal, modelId: selectedModel.value })
      if (!disposed && controller === request && !request.signal.aborted) snapshot.value = result
    } catch (cause) {
      if (!disposed && controller === request && !request.signal.aborted) error.value = cause instanceof Error ? cause.message : '读取配置失败，请重新检查。'
    } finally {
      if (!disposed && controller === request) { loading.value = false; controller = null }
    }
  }
  function cancelCheck() {
    ++workspaceRead
    controller?.abort(); controller = null; loading.value = false; error.value = ''; cancelled.value = true
  }

  const workspaceButton = ref<HTMLElement | null>(null)
  const workspaceOpen = ref(false), workspaceDraft = ref(''), workspaceLoading = ref(false), workspaceSaving = ref(false)
  const workspaceError = ref('')
  async function readWorkspaceBinding() {
    if (!desktop || disposed || workspaceSaving.value) return
    const read = ++workspaceRead
    workspaceError.value = ''
    try {
      const result = await desktop.getWorkspace()
      if (!disposed && read === workspaceRead) { workspaceSavedRoot.value = result.root; workspaceActiveRoot.value = result.activeRoot; workspacePending.value = result.restartRequired }
    } catch (cause) {
      if (!disposed && read === workspaceRead) { workspaceActiveRoot.value = null; workspaceError.value = cause instanceof Error ? cause.message : '当前工作区尚未确认，请重新读取。' }
    }
  }
  async function openWorkspace() {
    if (!desktop || workspaceLoading.value || workspaceSaving.value || disposed) return
    workspaceLoading.value = true; workspaceError.value = ''
    ++workspaceRead
    try {
      const result = await desktop.getWorkspace()
      if (!disposed) {
        workspaceDraft.value = result.root
        workspaceSavedRoot.value = result.root
        workspacePending.value = result.restartRequired
        workspaceActiveRoot.value = result.activeRoot
        workspaceOpen.value = true
      }
    } catch (cause) {
      if (!disposed) workspaceError.value = cause instanceof Error ? cause.message : '读取 AI 工作区失败。'
    } finally { if (!disposed) workspaceLoading.value = false }
  }
  function closeWorkspace() { if (!workspaceSaving.value) workspaceOpen.value = false }
  async function chooseWorkspace() {
    if (!desktop || workspaceLoading.value || workspaceSaving.value || disposed) return
    workspaceLoading.value = true; workspaceError.value = ''
    ++workspaceRead
    try {
      const binding = await desktop.getWorkspace()
      if (disposed) return
      const root = await desktop.pickWorkspace(binding.root)
      if (disposed || root === null) return
      workspaceSaving.value = true
      await applyWorkspace(root)
    } catch (cause) {
      if (!disposed) workspaceError.value = cause instanceof Error ? cause.message : '选择文件夹失败，请重试。'
    } finally { if (!disposed) { workspaceLoading.value = false; workspaceSaving.value = false } }
  }
  async function applyWorkspace(root: string) {
    ++workspaceRead
    const result = await desktop!.setWorkspace(root.trim())
    if (disposed) return
    workspaceDraft.value = result.root
    workspaceSavedRoot.value = result.root
    workspacePending.value = result.restartRequired
    workspaceActiveRoot.value = result.activeRoot
    workspaceOpen.value = false
  }
  async function saveWorkspace() {
    if (!desktop || workspaceSaving.value || !workspaceOpen.value || disposed) return
    workspaceSaving.value = true; workspaceError.value = ''
    ++workspaceRead
    try {
      await applyWorkspace(workspaceDraft.value)
    } catch (cause) {
      if (!disposed) workspaceError.value = cause instanceof Error ? cause.message : '保存失败，工作区尚未确认变更。'
    } finally { if (!disposed) workspaceSaving.value = false }
  }
  onMounted(() => { void refresh() })
  onUnmounted(() => { disposed = true; controller?.abort(); controller = null })

  return { isLocal, desktop, snapshot, loading, error, nextStep, basicComplete, currentCheck,
    workspaceButton, workspaceOpen, workspaceDraft, workspaceSavedRoot, workspaceLoading, workspaceSaving, restarting,
    workspaceError, workspacePending, workspaceUnconfirmed,
    refresh, cancelCheck, selectSetupModel, recordDownload, recordVerification,
    openWorkspace, chooseWorkspace, closeWorkspace, saveWorkspace, restartForSetup }
}
