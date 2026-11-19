import { computed, onDeactivated, onScopeDispose, ref, watch, type Ref } from 'vue'
import { uploadVideoDriver, type DrivingInput, type VideoDriver } from '@/api/videoApi'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'

export function useVideoDriver(kind: Readonly<Ref<DrivingInput | undefined>>, checkOwner: () => void, error: Ref<string>) {
  const source = ref<VideoDriver | null>(null)
  const selected = computed(() => source.value?.kind === kind.value ? source.value : null)
  const busy = ref(false)
  let pending: AbortController | undefined
  function stop() {
    pending?.abort()
    pending = undefined
    busy.value = false
  }
  watch([kind, runtimeResourceIdentity], stop, { flush: 'sync' })
  onDeactivated(stop)
  onScopeDispose(stop)
  async function choose(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0], inputKind = kind.value
    input.value = ''
    if (!file || !inputKind) return
    stop()
    const controller = new AbortController()
    pending = controller
    busy.value = true
    error.value = ''
    try {
      checkOwner()
      if (!file.size || file.size > 20 * 1024 * 1024) throw new Error('请选择 20 MiB 以内的素材')
      const result = await uploadVideoDriver(file, inputKind, controller.signal)
      controller.signal.throwIfAborted()
      checkOwner()
      source.value = { kind: inputKind, name: result.name, label: file.name }
    } catch (cause) {
      if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : '素材上传失败'
    } finally {
      if (pending === controller) stop()
    }
  }
  return { source, selected, busy, choose }
}
