import { onScopeDispose, ref } from 'vue'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'

export function useChatCardImport(allowed: () => boolean, active: () => string, select: (id: string) => void,
  notice: (text: string, kind: string, timeout?: number) => void) {
  const pending = ref(false), progress = ref('')
  const failures = ref<string[]>([])
  let operation: AbortController | undefined
  let disposed = false
  onScopeDispose(() => { disposed = true; operation?.abort() })

  async function importFiles(files: File[]) {
    if (!allowed() || pending.value || !files.length) return
    const controller = new AbortController(), original = active()
    const owner = runtimeResourceIdentity()
    operation = controller
    pending.value = true
    failures.value = []
    let first = '', count = 0
    const failed: string[] = []
    try {
      const { importChatCard, announceChatCardsChanged } = await import('@/utils/chatCards')
      for (const [i, file] of files.entries()) {
        if (controller.signal.aborted || owner !== runtimeResourceIdentity()) break
        progress.value = `正在导入 ${i + 1}/${files.length} · ${file.name}`
        try {
          if (!/\.(png|json)$/i.test(file.name)) throw new Error('请选择 PNG 或 JSON 角色卡')
          const limit = /\.png$/i.test(file.name) ? 16 : 1
          if (!file.size || file.size > limit * 1024 * 1024) throw new Error(`文件须非空且不超过 ${limit} MiB`)
          const id = await importChatCard(file, AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]))
          first ||= id
          count++
        } catch (error) {
          if (controller.signal.aborted) break
          failed.push(`${file.name}（${error instanceof Error ? error.message : '读取失败'}）`)
        }
      }
      if (owner !== runtimeResourceIdentity()) {
        if (!disposed) notice('工作区已切换，已停止导入剩余角色卡。', 'info')
        return
      }
      if (count) announceChatCardsChanged()
      if (disposed) return
      if (first && active() === original && allowed() && !controller.signal.aborted) select(first)
      const summary = `${controller.signal.aborted ? '已停止。' : ''}已导入 ${count} 张角色卡`
      failures.value = failed
      notice(failed.length ? `${summary}，${failed.length} 张失败。` : summary, failed.length ? 'warning' : 'info', failed.length ? 0 : 4000)
    } catch (error) {
      if (!disposed) notice(error instanceof Error ? error.message : '导入失败，请重试', 'error')
    } finally {
      operation = undefined
      pending.value = false
      progress.value = ''
    }
  }
  function choose(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const files = Array.from(input.files || [])
    input.value = ''
    void importFiles(files)
  }
  function dragOver(event: DragEvent) {
    if (!event.dataTransfer?.types.includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = allowed() && !pending.value ? 'copy' : 'none'
  }
  function drop(event: DragEvent) {
    if (!event.dataTransfer?.types.includes('Files')) return
    event.preventDefault()
    void importFiles(Array.from(event.dataTransfer.files))
  }
  return { pending, progress, failures, choose, dragOver, drop, cancel: () => operation?.abort() }
}
