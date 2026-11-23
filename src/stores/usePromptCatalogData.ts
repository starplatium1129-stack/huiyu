import { nextTick, ref, watch } from 'vue'
import type { ModelProfile } from '@/utils/promptPolicyTypes'
import type { useSceneStore } from './sceneStore'

export function usePromptCatalogData(sceneStore: ReturnType<typeof useSceneStore>, applyModelProfile: () => void) {
  const modelProfiles = ref<ModelProfile[]>([])
  const dataReady = ref(false)
  const dataLoading = ref(false), dataError = ref('')
  let dataRequest: Promise<void> | null = null
  let dataRequestVersion = -1
  watch(() => sceneStore.version, () => {
    const requested = dataReady.value || dataLoading.value
    dataReady.value = false; modelProfiles.value = []
    if (requested) void nextTick().then(() => loadData()).catch(() => {})
  }, { flush: 'sync' })

  function loadData(): Promise<void> {
    const version = sceneStore.version
    if (dataRequest && dataRequestVersion === version) return dataRequest
    dataRequestVersion = version
    const current = () => version === sceneStore.version
    const check = () => { if (!current()) throw new Error('创作资料来源已更新，请重新读取。') }
    // Retain an earlier error during retry so its action and focus owner stay mounted.
    dataReady.value = false; dataLoading.value = true
    dataRequest = (async () => {
      try {
        await sceneStore.loadDrawingCatalog()
        check()
        const { parsePresetCatalog, fillMissingModelProfiles } = await import('@/utils/modelProfileDefaults')
        const catalog = parsePresetCatalog(sceneStore.presets)
        // Fill missing software profiles without replacing personal content.
        const profiles = await fillMissingModelProfiles(catalog.modelProfiles)
        check()
        modelProfiles.value = profiles
        applyModelProfile()
        dataError.value = ''; dataReady.value = true
      } catch (cause) {
        if (current()) dataError.value = '创作资料暂时无法读取，请检查连接后重试。'
        throw cause
      } finally { if (current()) { dataLoading.value = false; dataRequest = null } }
    })()
    return dataRequest
  }
  return { modelProfiles, dataReady, dataLoading, dataError, loadData }
}
