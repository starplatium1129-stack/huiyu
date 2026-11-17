import { onScopeDispose, shallowRef, watch, type Ref } from 'vue'
import { downloadLocalSetupBatch } from '@/api/localSetupDownload'
import type { LocalSetupDownloadProgress, LocalSetupDownloadResult, LocalSetupModel } from '../../types/local-setup'

interface DownloadRow {
  model: LocalSetupModel
  phase: LocalSetupDownloadProgress['phase'] | 'queued' | 'ready' | 'failed'
  bytesRead: number
  expectedBytes: number
  source?: string
  bytesPerSecond?: number | null
  message?: string
}

export function useLocalSetupBatchDownload(workspace: Ref<string>, onResult: (result: LocalSetupDownloadResult) => void) {
  const rows = shallowRef<DownloadRow[]>([])
  let controller: AbortController | undefined

  function cancel() {
    controller?.abort()
  }

  async function run(models: LocalSetupModel[], confirmedWorkspace: string) {
    if (!models.length) return
    if (controller || confirmedWorkspace !== workspace.value) throw new Error('AI 工作区或下载状态已改变，请重新检查')
    const request = new AbortController()
    controller = request
    rows.value = models.map(model => ({
      model, phase: 'queued', bytesRead: 0, expectedBytes: model.preparation!.expectedBytes,
    }))
    const update = (id: string, value: Partial<DownloadRow>) => {
      request.signal.throwIfAborted()
      rows.value = rows.value.map(row => row.model.id === id ? { ...row, ...value } : row)
    }
    const manifest = new Map(models.map(model => [model.id, model]))
    try {
      await downloadLocalSetupBatch(models.map(model => model.id), {
        workspacePath: confirmedWorkspace,
        signal: request.signal,
        onProgress(event) {
          if (event.expectedBytes !== manifest.get(event.modelId)?.preparation?.expectedBytes) {
            throw new Error('下载进度与固定清单不一致，请重新检查')
          }
          update(event.modelId, {
            phase: event.phase, bytesRead: event.bytesRead, source: event.source,
            bytesPerSecond: event.bytesPerSecond, message: event.message,
          })
        },
        onResult(event) {
          const model = manifest.get(event.modelId)!
          if (event.path !== model.path || workspace.value !== confirmedWorkspace) {
            throw new Error('下载结果与当前工作区不一致，请重新检查')
          }
          const failed = event.state === 'failed'
          if (!failed && (event.bytes !== model.preparation?.expectedBytes || event.sha256 !== model.preparation.sha256)) {
            throw new Error('下载完整性结果与固定清单不一致，请重新检查')
          }
          update(model.id, {
            phase: failed ? 'failed' : 'ready', bytesRead: event.bytes ?? 0,
            source: undefined, bytesPerSecond: undefined, message: failed ? event.message : undefined,
          })
          onResult(event)
        },
      })
      const failures = rows.value.filter(row => row.phase === 'failed')
      if (failures.length) {
        throw new Error(failures.map(row => `${row.model.label} · ${row.message}`).join('；'))
      }
    } finally {
      controller = undefined
      rows.value = []
    }
  }

  watch(workspace, cancel, { flush: 'sync' })
  onScopeDispose(cancel)
  return { rows, run, cancel }
}
