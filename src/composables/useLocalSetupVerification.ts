import { onUnmounted, ref, watch, type Ref } from 'vue'
import type { LocalSetupModel, LocalSetupVerificationResult } from '../../types/local-setup.ts'
import { localSetupApi } from '../api/localSetupApi.ts'

export function useLocalSetupVerification(models: Ref<LocalSetupModel[]>) {
  const activeId = ref(''), bytesRead = ref(0), expectedBytes = ref(0)
  const results = ref<Record<string, LocalSetupVerificationResult>>({})
  const notices = ref<Record<string, string>>({})
  let controller: AbortController | null = null
  let disposed = false
  function cancel() {
    const id = activeId.value
    controller?.abort(); controller = null; activeId.value = ''
    if (id) notices.value = { ...notices.value, [id]: '已取消校验，结果仍待确认' }
  }
  function reset() { cancel(); results.value = {}; notices.value = {}; bytesRead.value = 0; expectedBytes.value = 0 }
  async function verify(model: LocalSetupModel) {
    if (activeId.value || disposed || !model.preparation) return
    const request = new AbortController()
    controller = request; activeId.value = model.id; bytesRead.value = 0; expectedBytes.value = model.preparation.expectedBytes
    notices.value = { ...notices.value, [model.id]: '' }
    // A retry must not clear a known failure before a new result arrives.
    if (results.value[model.id]?.state === 'sha256-match') {
      const next = { ...results.value }; delete next[model.id]; results.value = next
    }
    try {
      const result = await localSetupApi.verifyModel(model.id, { signal: request.signal, onProgress(event) {
        if (!disposed && controller === request && !request.signal.aborted) { bytesRead.value = event.bytesRead; expectedBytes.value = event.expectedBytes }
      } })
      if (!disposed && controller === request && !request.signal.aborted) {
        if (result.path !== model.path || (result.state === 'sha256-match' && (result.bytes !== model.preparation.expectedBytes || result.sha256 !== model.preparation.sha256))) throw new Error('校验结果与当前文件清单不一致，请重新检查')
        results.value = { ...results.value, [model.id]: result }
      }
    } catch (cause) {
      if (!disposed && controller === request && !request.signal.aborted) notices.value = { ...notices.value, [model.id]: cause instanceof Error ? cause.message : '校验未完成，请重试' }
    } finally { if (controller === request) { controller = null; activeId.value = '' } }
  }
  watch(models, reset)
  onUnmounted(() => { disposed = true; cancel() })
  return { activeId, bytesRead, expectedBytes, results, notices, verify, cancel }
}
