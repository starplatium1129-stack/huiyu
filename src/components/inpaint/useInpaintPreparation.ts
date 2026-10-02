import { onBeforeUnmount, onDeactivated, ref, watch } from 'vue'
import type { InpaintSubmitPayload } from '../AnimaInpaintModal.vue'

type Draft = Omit<InpaintSubmitPayload, 'imageBlob' | 'maskBlob'> & { painted: boolean; requiresAdult: boolean }

/** Own the asynchronous image/mask reads before the generation controller takes over. */
export function useInpaintPreparation(deps: {
  open(): boolean
  sourceRevision(): number
  ready(): boolean
  busy(): boolean
  adultEnabled(): boolean
  capture(): Draft | null
  getBlob(signal: AbortSignal): Promise<Blob | null>
  maskBlob(): Promise<Blob | null>
  submit(payload: InpaintSubmitPayload): void
  error(message: string): void
}) {
  const preparing = ref(false)
  let controller: AbortController | null = null
  function cancel() {
    controller?.abort()
    controller = null
    preparing.value = false
  }
  watch([deps.open, deps.sourceRevision], cancel, { flush: 'sync' })
  onDeactivated(cancel)
  onBeforeUnmount(cancel)

  async function start() {
    if (!deps.open() || !deps.ready() || deps.busy() || controller) return
    const draft = deps.capture()
    if (!draft) return
    const active = new AbortController()
    controller = active
    preparing.value = true
    const current = () => controller === active && !active.signal.aborted && deps.open()
    try {
      // Invoke both reads now, before either can yield to a different form/source.
      const [imageBlob, maskBlob] = await Promise.all([deps.getBlob(active.signal), deps.maskBlob()])
      if (!current() || deps.busy()) return
      if (draft.requiresAdult && !deps.adultEnabled()) { deps.error('请先在工作台开启分级内容，才能使用该服装预设'); return }
      if (!imageBlob) { deps.error('请先上传或选择需要换装的图片'); return }
      if (draft.painted && !maskBlob) {
        deps.error('请先在图片上涂出需要换装的区域，按住 Shift 或右键可擦除保护区')
        return
      }
      const { painted: _painted, requiresAdult: _requiresAdult, ...payload } = draft
      deps.submit({ ...payload, imageBlob, maskBlob })
    } catch {
      if (current()) deps.error('图片或遮罩准备失败，请重试')
    } finally {
      if (controller === active) { controller = null; preparing.value = false }
    }
  }
  return { preparing, start }
}
