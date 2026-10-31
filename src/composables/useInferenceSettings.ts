import { computed, onScopeDispose, reactive, ref } from 'vue'
import { inferenceSettingsApi, inferenceSettingKeys, type InferenceSettings, type InferenceSettingsResponse, type InferenceDiagnostics, type InferenceProbeResponse, type InferenceDiscovery } from '@/api/inferenceSettingsApi'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'

export function useInferenceSettings() {
  const isLocal = isLocalStudioHost()
  const draft = reactive<InferenceSettings>({ engine: 'native', acceleration: 'native', memoryPolicy: 'resident', adapterMemoryPolicy: 'offload', modelsRoot: '', lorasRoot: '', python: '', adapterPython: null, worker: '' })
  const snapshot = ref<InferenceSettingsResponse | null>(null)
  const diagnostics = ref<InferenceDiagnostics | null>(null)
  const discovery = ref<InferenceDiscovery | null>(null)
  const probe = ref<InferenceProbeResponse | null>(null)
  const probing = ref(false)
  const probeError = ref('')
  let probeController: AbortController | null = null
  const loading = ref(false)
  const saving = ref(false)
  const error = ref('')
  const notice = ref('')
  const dirty = computed(() => !!snapshot.value && inferenceSettingKeys.some(key => draft[key] !== snapshot.value!.configured[key]))
  const adoptionChanges = computed(() => !!snapshot.value && !!discovery.value && inferenceSettingKeys.some(key => discovery.value!.suggested[key] !== snapshot.value!.configured[key]))
  let disposed = false
  let controller: AbortController | null = null
  function apply(result: InferenceSettingsResponse, previous: InferenceSettings) {
    for (const key of inferenceSettingKeys) {
      if (!snapshot.value || draft[key] === previous[key]) {
        if (key === 'engine') draft.engine = result.configured.engine
        else if (key === 'acceleration') draft.acceleration = result.configured.acceleration
        else if (key === 'memoryPolicy') draft.memoryPolicy = result.configured.memoryPolicy
        else if (key === 'adapterMemoryPolicy') draft.adapterMemoryPolicy = result.configured.adapterMemoryPolicy
        else if (key === 'adapterPython') draft.adapterPython = result.configured.adapterPython
        else draft[key] = result.configured[key]
      }
    }
    snapshot.value = { ...result, active: { ...result.active }, configured: { ...result.configured }, environmentOverrides: [...result.environmentOverrides] }
  }
  async function refresh() {
    if (!isLocal || loading.value || saving.value || disposed) return
    loading.value = true
    error.value = ''
    controller = new AbortController()
    const previous = { ...(snapshot.value?.configured ?? draft) }
    try {
      const result = await inferenceSettingsApi.getStatus(controller.signal)
      if (disposed) return
      apply(result, previous)
      diagnostics.value = { ...result.diagnostics, files: { ...result.diagnostics.files } }
      discovery.value = { ...result.discovery, suggested: { ...result.discovery.suggested }, missing: [...result.discovery.missing] }
    } catch (cause) {
      if (!disposed) error.value = cause instanceof Error ? cause.message : '读取推理设置失败'
    } finally { if (!disposed) loading.value = false }
  }
  async function save() {
    if (!isLocal || !snapshot.value || loading.value || saving.value || !dirty.value || disposed) return
    saving.value = true
    error.value = ''
    notice.value = ''
    controller = new AbortController()
    const submitted = { ...draft }
    let saved = false
    try {
      const result = await inferenceSettingsApi.save(submitted, controller.signal)
      if (disposed) return
      apply(result, submitted)
      diagnostics.value = null
      discovery.value = null
      saved = true
      notice.value = result.restartRequired ? '已保存。请重启绘遇运行时后生效；当前任务继续使用原设置。' : '已保存，配置与当前运行时一致。'
    } catch (cause) {
      if (!disposed) error.value = cause instanceof Error ? cause.message : '保存失败，请重试；已保留输入'
    } finally { if (!disposed) saving.value = false }
    if (saved && !disposed) await refresh()
  }
  async function diagnose() {
    if (!isLocal || probing.value || disposed) return
    probing.value = true
    probeError.value = ''
    probe.value = null
    probeController = new AbortController()
    try {
      const result = await inferenceSettingsApi.diagnose(probeController.signal)
      if (!disposed) probe.value = { ...result, probe: { ...result.probe, dependencies: { ...result.probe.dependencies } } }
    } catch (cause) {
      if (!disposed) probeError.value = cause instanceof Error ? cause.message : '依赖检查失败'
    } finally { if (!disposed) probing.value = false }
  }
  async function adopt() {
    if (!discovery.value?.canAdopt || !adoptionChanges.value || dirty.value || loading.value || saving.value || disposed) return
    Object.assign(draft, discovery.value.suggested)
    await save()
  }
  onScopeDispose(() => { disposed = true; controller?.abort(); probeController?.abort() })
  return { isLocal, draft, snapshot, diagnostics, discovery, adoptionChanges, adopt, loading, saving, error, notice, dirty, refresh, save, probe, probing, probeError, diagnose }
}
