import { computed, onMounted, onUnmounted, shallowRef, ref } from 'vue'
import { readResourceAssistant, pickResourceArchive, installResourceArchive, cancelResourceInstall, finishResourceInstall,
  hasResourceAssistant, type OfflineInstallState } from '@/platform/desktop/resourceAssistant'

export function useOfflineResourceAssistant() {
  const state = shallowRef<OfflineInstallState | null>(null)
  const error = ref(''), actionError = ref(''), submitting = ref(false), now = ref(Date.now())
  const available = hasResourceAssistant()
  let disposed = false, polling = false, poll: ReturnType<typeof setTimeout> | undefined
  const busy = computed(() => submitting.value || !!state.value?.busy)
  const complete = computed(() => state.value?.stage === 'completed')
  const canInstall = computed(() => !!state.value?.preview && !busy.value && !complete.value && !state.value?.drainFailed)
  const percent = computed(() => state.value?.phase === 'extracting' && state.value.total > 0
    ? Math.min(100, Math.floor(state.value.done / state.value.total * 100)) : null)
  const elapsed = computed(() => {
    const seconds = Math.max(0, Math.floor((now.value - (state.value?.startedAt ?? now.value)) / 1000))
    return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
  })
  const heading = computed(() => {
    const value = state.value
    if (value?.cancelRequested && value.busy) return '正在安全取消…'
    return ({ idle: '把喜欢的故事，收进画室', checking: '正在识别资源包', ready: '资源包已就绪', preparing: '正在保存并暂停画室',
      installing: '正在接入素材', completed: '素材已接入画室', cancelled: '安装已取消', failed: '这次安装未能完成' })[value?.stage ?? 'idle']
  })
  const detail = computed(() => {
    const value = state.value
    if (value?.cancelRequested && value.busy) return '正在收尾并保留恢复内容，请稍候。'
    if (value?.stage === 'installing' && value.phase === 'connecting') return '登记素材位置并同步人物内容，图片保留在原目录，按需加载。'
    if (value?.stage === 'installing') return value.phase === 'extracting'
      ? '正在解压文件，此处显示整包解压进度。' : '正在合并资源与人物内容，请稍候。'
    if (value?.stage === 'preparing') return '保存当前编辑后，自动暂停桌宠与画室服务。请保持窗口打开。'
    if (complete.value) return value?.result?.directoryRoot ? '文件夹已接入。请保留在原位置，重启后即可使用。' : '角色图片、场景卡片与素材画册将在重启后可用。'
    if (value?.stage === 'ready') return value.preview?.sourceType === 'directory' ? '直接使用此文件夹，不复制图片，也不扫描整库。' : '解压到固定资源目录后直接使用，无需再次复制整包素材。'
    if (value?.stage === 'checking') return '读取官方发行清单，自动识别版本与安装位置。'
    if (value?.stage === 'cancelled') return value.canResume ? '已保留完整暂存，继续安装时可复用。' : '重新安装时会再次解压并校验资源包。'
    return '选择官方 ZIP 自动解压，或直接接入已解压的素材文件夹。'
  })
  const issue = computed(() => {
    const raw = actionError.value || error.value || state.value?.error || ''
    if (!raw || state.value?.stage === 'cancelled' && !error.value) return ''
    if (/UNTRUSTED_RELEASE|approval|identity mismatch/i.test(raw)) return '此包尚未获得当前助手批准，请更新绘遇或选择匹配的官方资源包。'
    if (/space|ENOSPC|磁盘/i.test(raw)) return '磁盘空间不足，请腾出临时目录及资源目录所在盘的空间后重试。'
    if (/CATALOG_SNAPSHOT_STALE/.test(raw)) return '当前人物与场景内容比资源包更新，请保留当前内容并更新绘遇后重新安装素材。'
    if (/DIRECTORY_FULL_REQUIRED/.test(raw)) return '此目录是增量包。请选择完整素材目录，或通过 ZIP 安装增量包。'
    if (/BASELINE_REQUIRED|BASELINE_MISMATCH/.test(raw)) return '此增量包与已安装版本不匹配。首次安装请选择完整资源包。'
    if (/WINDOW_BUSY|OPEN_EDITOR|UNSAVED|COMPOSING|FLUSH/i.test(raw)) return '仍有未保存的编辑或进行中的任务，请先完成它们，再点击安装。'
    if (/hash mismatch|ZIP|inventory|Metadata|Unsafe|Linked/i.test(raw)) return '资源包内容不完整、已损坏或路径不可用，请重新取得官方 ZIP 后安装。'
    if (/PENDING_TRANSACTION/i.test(raw)) return '上次安装尚待恢复，请选择同一资源包继续安装。'
    if (/MAINTENANCE|HOST_IDENTITY|HOST_PROFILE/i.test(raw)) return '画室暂停未确认，请返回画室重启后再试。'
    return raw.length > 240 ? '安装未能完成，可展开详细信息查看原因并重试。' : raw
  })
  async function refresh() {
    if (!available || disposed || polling) return
    polling = true
    try { const next = await readResourceAssistant(); if (!disposed) { state.value = next; error.value = '' } }
    catch (cause) { if (!disposed) error.value = String(cause) }
    finally {
      polling = false
      if (!disposed) poll = setTimeout(() => { now.value = Date.now(); void refresh() }, state.value?.busy ? 500 : 1500)
    }
  }
  async function act(action: () => Promise<void>) {
    if (submitting.value) return
    submitting.value = true; error.value = ''; actionError.value = ''
    try { await action() } catch (cause) { if (!disposed) actionError.value = String(cause) }
    finally { submitting.value = false; clearTimeout(poll); await refresh() }
  }
  onMounted(() => { void refresh() })
  onUnmounted(() => { disposed = true; clearTimeout(poll) })
  return { state, error, available, busy, complete, canInstall, percent, elapsed, heading, detail, issue, refresh,
    pick: () => act(() => pickResourceArchive()), pickDirectory: () => act(() => pickResourceArchive(true)), install: () => act(installResourceArchive),
    cancel: () => act(cancelResourceInstall), finish: () => act(finishResourceInstall) }
}
