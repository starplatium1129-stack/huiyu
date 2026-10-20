import { onDeactivated, onUnmounted, ref, shallowRef } from 'vue'
import { endLocalImageImport, localImageImportStatus, retryLocalImageImport, watchLocalImageImports } from '../utils/desktopImport'
import { imageMediaSession } from '../platform/imageMediaSession'
import { onDesktopRuntime } from '../platform/desktop/runtime'
import { confirmAction } from './useConfirm'

export function useLocalImageImportRecovery(onSaved: () => void) {
  const status = shallowRef(localImageImportStatus())
  const input = ref<HTMLInputElement>()
  const workingId = ref('')
  const feedback = ref('')
  let alive = true
  let action: AbortController | undefined
  let selection: { id: string; invalid: boolean; stop(): void } | undefined
  const refresh = () => { status.value = localImageImportStatus() }
  const bindInput = (value: HTMLInputElement | undefined) => { input.value = value }
  const stop = watchLocalImageImports(refresh)
  async function resolve(id: string, kind: 'save' | 'abort', file?: Blob) {
    if (workingId.value || status.value.busy) return
    workingId.value = id; feedback.value = ''
    const controller = new AbortController(), session = imageMediaSession()
    action = controller
    const stopRuntime = onDesktopRuntime(() => { if (imageMediaSession() !== session) controller.abort() })
    try {
      if (kind === 'abort' && !await confirmAction({ title: '结束这条图片导入待办？',
        message: '仅在确认原导入已结束后移除待办。已入册作品和已有图片不会删除；尚未入册的原图将不再由此入口保留。结果无法确认时，待办会继续保留。',
        confirmLabel: '结束待办', signal: controller.signal })) return
      if (controller.signal.aborted) return
      const outcome = await (kind === 'save' ? retryLocalImageImport(id, file) : endLocalImageImport(id))
      if (!alive || controller.signal.aborted) return
      if (outcome === 'saved') { feedback.value = '原图片已确认存入作品册，没有重复创建作品。'; onSaved() }
      else feedback.value = outcome === 'not-live' ? '原作品已删除或在回收站中，未重新创建；恢复记录已结束。' : '原导入已终止，恢复记录已结束。'
    } catch (error) {
      if (alive) feedback.value = error instanceof Error ? error.message : '导入尚未确认，原图片和编号已保留。'
    } finally { stopRuntime(); action = undefined; workingId.value = ''; if (alive) refresh() }
  }
  const retry = (id: string, file?: Blob) => resolve(id, 'save', file)
  const end = (id: string) => resolve(id, 'abort')
  function selectOriginal(id: string) {
    if (workingId.value || status.value.busy) return
    selection?.stop()
    const session = imageMediaSession()
    const selected = { id, invalid: false, stop: () => {} }
    selection = selected
    selected.stop = onDesktopRuntime(() => { if (imageMediaSession() !== session) selected.invalid = true })
    input.value?.click()
  }
  function selectedOriginal() {
    const selected = selection, file = input.value?.files?.[0]
    if (input.value) input.value.value = ''
    selection = undefined; selected?.stop()
    if (!selected || !file) return
    if (selected.invalid) { feedback.value = '选择文件期间连接或页面已变化，请重新选择原文件；原导入已保留。'; return }
    void retry(selected.id, file)
  }
  function cancelInteraction() {
    // Close only the UI-owned confirmation/chooser. Accepted saves keep their owner.
    action?.abort()
    if (selection) { selection.invalid = true; selection.stop() }
  }
  onDeactivated(cancelInteraction)
  onUnmounted(() => { alive = false; cancelInteraction(); stop() })
  return { status, bindInput, workingId, feedback, refresh, retry, end, selectOriginal, selectedOriginal, cancelInteraction }
}
export type LocalImageImportRecovery = ReturnType<typeof useLocalImageImportRecovery>
