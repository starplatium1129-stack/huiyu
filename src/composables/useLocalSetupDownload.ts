import { onUnmounted, ref, watch, type Ref } from 'vue'
import type { LocalSetupModel, LocalSetupDownloadResult } from '../../types/local-setup.ts'
import { localSetupApi } from '../api/localSetupApi.ts'

export function useLocalSetupDownload(workspace: Ref<string>, ready: Ref<boolean>, onResult: (result: LocalSetupDownloadResult) => void) {
  const activeId = ref(''), bytesRead = ref(0), expectedBytes = ref(0), phase = ref('downloading')
  const notices = ref<Record<string, string>>({}), failed = ref<Record<string, boolean>>({})
  let controller: AbortController | null = null, disposed = false
  function cancel() {
    const id = activeId.value
    controller?.abort(); controller = null; activeId.value = ''
    if (id) { notices.value = { ...notices.value, [id]: '已取消下载，已有模型保留；已接收的部分可在重试时续传' }; failed.value = { ...failed.value, [id]: true } }
  }
  async function download(model: LocalSetupModel) {
    if (disposed || activeId.value || !ready.value || !model.preparation) return
    const request = new AbortController(), confirmedWorkspace = workspace.value
    controller = request; activeId.value = model.id; bytesRead.value = 0; expectedBytes.value = model.preparation.expectedBytes; phase.value = 'checking'
    notices.value = { ...notices.value, [model.id]: '' }
    try {
      const result = await localSetupApi.downloadModel(model.id, { workspacePath: confirmedWorkspace, signal: request.signal, onProgress(event) {
        if (!disposed && controller === request && !request.signal.aborted) { bytesRead.value = event.bytesRead; expectedBytes.value = event.expectedBytes; phase.value = event.phase }
      } })
      if (disposed || controller !== request || request.signal.aborted) return
      if (result.path !== model.path || workspace.value !== confirmedWorkspace) throw new Error('下载结果与当前工作区清单不一致，请重新检查')
      if (result.state === 'failed') { onResult(result); throw new Error(result.message) }
      if (result.bytes !== model.preparation.expectedBytes || result.sha256 !== model.preparation.sha256) throw new Error('下载完整性结果与固定清单不一致，请重新检查')
      notices.value = { ...notices.value, [model.id]: result.message }; failed.value = { ...failed.value, [model.id]: false }
      controller = null; activeId.value = ''
      onResult(result)
    } catch (cause) {
      if (!disposed && controller === request && !request.signal.aborted) {
        notices.value = { ...notices.value, [model.id]: cause instanceof Error ? cause.message : '下载未完成，请重试' }
        failed.value = { ...failed.value, [model.id]: true }
      }
    } finally { if (controller === request) { controller = null; activeId.value = '' } }
  }
  watch(workspace, () => { cancel(); notices.value = {}; failed.value = {} })
  watch(ready, value => { if (!value) cancel() })
  onUnmounted(() => { disposed = true; cancel() })
  return { activeId, bytesRead, expectedBytes, phase, notices, failed, download, cancel }
}
