import { computed, onScopeDispose, reactive, ref } from 'vue'
import { inferenceSettingsApi, inferenceSettingKeys, type InferenceSettings, type InferenceSettingsApi, type InferenceSettingsResponse, type InferenceDiagnostics, type InferenceProbeResponse } from '@/api/inferenceSettingsApi'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'

export function useInferenceSettings(api: InferenceSettingsApi = inferenceSettingsApi) {
  const isLocal = isLocalStudioHost()
  const draft = reactive<InferenceSettings>({ engine: 'comfy', modelsRoot: '', lorasRoot: '', python: '', worker: '' })
  const snapshot = ref<InferenceSettingsResponse | null>(null)
  const diagnostics = ref<InferenceDiagnostics | null>(null)
  const probe = ref<InferenceProbeResponse | null>(null)
  const probing = ref(false)
  const probeError = ref('')
  let probeController: AbortController | null = null
  const loading = ref(false)
  const saving = ref(false)
  const error = ref('')
  const notice = ref('')
  const dirty = computed(() => !!snapshot.value && inferenceSettingKeys.some(key => draft[key] !== snapshot.value!.configured[key]))
  let disposed = false
  let controller: AbortController | null = null
  function apply(result: InferenceSettingsResponse, previous: InferenceSettings) {
    for (const key of inferenceSettingKeys) {
      if (!snapshot.value || draft[key] === previous[key]) {
        if (key === 'engine') draft.engine = result.configured.engine
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
      const result = await api.getStatus(controller.signal)
      if (disposed) return
      apply(result, previous)
      diagnostics.value = { ...result.diagnostics, files: { ...result.diagnostics.files } }
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
    try {
      const result = await api.save(submitted, controller.signal)
      if (disposed) return
      apply(result, submitted)
      diagnostics.value = null
      notice.value = result.restartRequired ? '已保存。请重启绘遇运行时后生效；当前任务继续使用原设置。' : '已保存，配置与当前运行时一致。'
    } catch (cause) {
      if (!disposed) error.value = cause instanceof Error ? cause.message : '保存失败，请重试；已保留输入'
    } finally { if (!disposed) saving.value = false }
  }
  async function diagnose() {
    if (!isLocal || probing.value || disposed) return
    probing.value = true
    probeError.value = ''
    probe.value = null
    probeController = new AbortController()
    try {
      const result = await api.diagnose(probeController.signal)
      if (!disposed) probe.value = { ...result, probe: { ...result.probe, dependencies: { ...result.probe.dependencies } } }
    } catch (cause) {
      if (!disposed) probeError.value = cause instanceof Error ? cause.message : '依赖检查失败'
    } finally { if (!disposed) probing.value = false }
  }
  onScopeDispose(() => { disposed = true; controller?.abort(); probeController?.abort() })
  return { isLocal, draft, snapshot, diagnostics, loading, saving, error, notice, dirty, refresh, save, probe, probing, probeError, diagnose }
}
