/**
 * 控制面板 · 状态轮询与渲染（从 ControlView.vue 拆出）。
 *
 * 所有权：状态、日志与分享链接的轮询生命周期，
 * 上游在线状态、操作进度、日志缓冲与展示文案。
 */

import { ref, computed, nextTick, watch, getCurrentScope, onScopeDispose, type Ref } from 'vue'
import { usePolling } from './usePolling.ts'
import { ApiClientError } from '../api/client.ts'
import { controlApi } from '../api/controlApi.ts'
import type {
  ControlStatus, ControlLogs, ControlOperationView,
} from '@/types/api'

interface StatusHooks {
  showToast: (msg: string, isError?: boolean) => void
}

export function useControlStatus({ showToast }: StatusHooks) {
  const tunnelActive = ref(false)
  const sdOnline = ref(false)
  const comfyOnline = ref(false)
  const imageProvider = ref<ControlStatus['imageProvider']>(null)
  const ttsOnline = ref(false)
  const ollamaOnline = ref(false)
  const llamaOnline=ref(false),llamaManaged=ref(false),llamaLabel=ref('')
  const webuiManaged = ref(false)
  const comfyManaged = ref(false)
  const ollamaModels = ref<string[]>([])
  const ollamaVram = ref(0)
  const modeBusy = ref(false)
  const operation = ref<ControlOperationView | null>(null)
  const operationSubmitting = ref(false)
  const selfHealing = ref<ControlStatus['selfHealing'] | null>(null)
  const serviceChecking = ref(false)
  const statusLoaded = ref(false)
  const statusError = ref('')
  const scripts = ref({ voiceStart: true, voiceStop: true, webui: true, comfy: true })

  // 轮询只回填没有未确认编辑的配置字段。
  const sdHost = ref('http://127.0.0.1:7860')
  const comfyHost = ref('http://127.0.0.1:8188')
  const ttsHost = ref('http://127.0.0.1:9880')
  const ttsEngine = ref('gpt-sovits')
  const activeVoiceEngine = ref('GPT-SoVITS')
  const voiceNeneLora = ref('')
  const voiceNatsumeLora = ref('')
  const voiceNeneRef = ref('')
  const voiceNenePrompt = ref('')
  const voiceNatsumeRef = ref('')
  const voiceNatsumePrompt = ref('')
  const configFields = [sdHost, comfyHost, ttsHost, ttsEngine, voiceNeneLora, voiceNatsumeLora, voiceNeneRef, voiceNenePrompt, voiceNatsumeRef, voiceNatsumePrompt]
  const configEdits = new Map(configFields.map(field => [field, { revision: 0, acknowledged: 0 }]))
  let syncingConfig = false
  for (const [field, edit] of configEdits) {
    watch(field, () => { if (!syncingConfig) edit.revision++ }, { flush: 'sync' })
  }
  function captureConfigEdits() {
    return new Map([...configEdits].map(([field, edit]) => [field, edit.revision]))
  }
  function acknowledgeConfigEdits(snapshot: Map<Ref<string>, number>) {
    let hasNewerEdits = false
    for (const [field, edit] of configEdits) {
      if (edit.revision === snapshot.get(field)) edit.acknowledged = edit.revision
      else hasNewerEdits = true
    }
    return hasNewerEdits
  }
  function syncConfigField(field: Ref<string>, incoming: string | undefined) {
    if (incoming === undefined) return
    const edit = configEdits.get(field)!
    // Even returning to the old server value is a new draft until a save confirms it.
    if (edit.revision !== edit.acknowledged) return
    syncingConfig = true
    try { field.value = incoming }
    finally { syncingConfig = false }
  }
  const autoStartVoice = ref(false)
  const savingAutoStartVoice = ref(false)

  const tunnelStatus = ref('')
  const shareLink = ref('')
  const localLink = ref('http://127.0.0.1:3000/')
  const uptime = ref('')
  /** 前端构建信息：公网分享伺服 dist/，源码过期时提示重建 */
  const webBuild = ref<{ distReady: boolean; builtAt: string | null; stale: boolean } | null>(null)
  const actionBusy = ref(false)
  const mainBtnLabel = ref('启动并生成分享链接')
  const feedbackText = ref('正在检测本地服务…')
  const actionNote = ref('')
  const overviewFeedback = computed(() => {
    if (serviceChecking.value) return {
      title: statusLoaded.value ? '正在刷新本机服务状态…' : '正在检测本地服务…',
      note: '请稍候，正在确认本机连接状态。',
    }
    if (statusError.value) return { title: '本机服务状态待确认', note: '本次检测未能完成，请检查控制服务后重试。' }
    return { title: feedbackText.value, note: actionNote.value || '正在读取本机服务状态。' }
  })
  const logs = ref<string[]>([])
  const logsOpen = ref(false), logsLoading = ref(false)
  const logsLoaded = ref(false), logsError = ref('')
  const logsSummary = computed(() => logsLoading.value && !logsLoaded.value ? '读取中…' : logsError.value ? '读取失败' : logsLoaded.value ? `${logs.value.length} 条` : '未读取')
  // File tails repeat on every poll, independently of the server cursor.
  const seenLogLines = new Set<string>()
  const logBoxEl = ref<HTMLElement | null>(null)
  const logIndex = ref(0)
  let disposed = false
  if (getCurrentScope()) onScopeDispose(() => { disposed = true; stopPolling() })
  let statusRevision = 0
  let lastStatus: ControlStatus | null = null
  let statusRequest: AbortController | null = null
  let logsRequest: AbortController | null = null
  let shareRequest: AbortController | null = null

  watch(operationSubmitting, submitting => { if (submitting) statusRevision++ }, { flush: 'sync' })

  const opBusy = computed(() => operationSubmitting.value || !!(operation.value && operation.value.status === 'running') || modeBusy.value)
  const opStatusLabel = computed(() => {
    const s = operation.value?.status
    if (s === 'failed' && operation.value?.cancelled) return '已取消'
    return s === 'running' ? '进行中' : s === 'completed' ? '完成' : s === 'failed' ? '失败' : ''
  })
  const opCompletedStages = computed(() => {
    const op = operation.value
    const count = op?.stages?.length || 0
    if (!op || !count) return 0
    // stageIndex names the current/last attempted stage, not a finished one.
    return op.status === 'completed' ? count : Math.max(0, Math.min(count, op.stageIndex))
  })
  const opProgress = computed(() => {
    const op = operation.value, count = op?.stages?.length || 0
    const fraction = op?.status === 'running' && (op.workTotal ?? 0) > 0
      ? Math.min(1, (op.workDone ?? 0) / op.workTotal!) : 0
    return count ? (opCompletedStages.value + fraction) / count * 100 : 0
  })
  const ollamaMeta = computed(() => {
    if (!ollamaOnline.value) return '未连接'
    if (!ollamaModels.value.length) return '在线 · 无加载模型'
    const v = fmtVram(ollamaVram.value)
    return '占用 ' + (v || (ollamaModels.value.length + ' 模型'))
  })
  const voiceConfiguredCount = computed(() => {
    let n = 0
    if (voiceNeneRef.value.trim() && voiceNenePrompt.value.trim() && (ttsEngine.value !== 'voxcpm2' || voiceNeneLora.value.trim())) n += 1
    if (voiceNatsumeRef.value.trim() && voiceNatsumePrompt.value.trim() && (ttsEngine.value !== 'voxcpm2' || voiceNatsumeLora.value.trim())) n += 1
    return n
  })

  function fmt(seconds: number) {
    const v = Math.max(0, Number(seconds) || 0)
    if (v < 60) return v + ' 秒'
    const m = Math.floor(v / 60)
    return m < 60 ? m + ' 分钟' : Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分钟'
  }
  function fmtVram(bytes: number) {
    const n = Number(bytes) || 0
    if (n <= 0) return ''
    if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(0) + ' MB'
    return (n / 1024 ** 3).toFixed(1) + ' GB'
  }
  function lineClass(line: string) {
    const low = line.toLowerCase()
    if (low.includes('error') || low.includes('failed') || low.includes('失败')) return 'err'
    if (low.includes('started') || low.includes('ready') || low.includes('已启') || low.includes('就绪')) return 'info'
    return ''
  }

  function renderStatus(data: ControlStatus) {
    if (disposed) return
    lastStatus = data
    statusLoaded.value = true
    statusError.value = data.ok === false ? (data.error || '服务状态暂时不可用') : ''
    tunnelActive.value = !!(data.tunnelStatus === 'active' || data.shareLinkAvailable)
    sdOnline.value = !!data.sdOnline
    comfyOnline.value = !!data.comfyOnline
    ttsOnline.value = !!data.ttsOnline
    activeVoiceEngine.value = data.ttsEngine === 'voxcpm2' ? 'VoxCPM2' : 'GPT-SoVITS'
    ollamaOnline.value = !!data.ollamaOnline
    llamaOnline.value=!!data.llama?.online;llamaManaged.value=!!data.llama?.managed;llamaLabel.value=data.llama?.label||''
    webuiManaged.value = !!data.webuiManaged
    comfyManaged.value = !!data.comfyManaged
    ollamaModels.value = Array.isArray(data.ollamaModels) ? data.ollamaModels : []
    ollamaVram.value = Number(data.ollamaVram) || 0
    modeBusy.value = !!data.modeBusy
    if (data.ok || data.operation) {
      operation.value = data.operation ?? null
      statusRevision++
    }
    selfHealing.value = data.selfHealing && typeof data.selfHealing === 'object' ? data.selfHealing : null
    tunnelStatus.value = data.tunnelStatus || ''
    // 分享链接含原始 token，已从 /api/status 拆到仅本机可读的 /api/share-link
    if (data.shareLinkAvailable) void loadShareLink()
    else {
      shareRequest?.abort()
      shareRequest = null
      shareLink.value = ''
    }
    if (data.localLink) localLink.value = data.localLink
    if (data.uptime != null) uptime.value = '网站已运行 ' + fmt(data.uptime)
    if (data.scripts) scripts.value = { ...scripts.value, ...data.scripts }
    if (data.webBuild) webBuild.value = {
      distReady:!!data.webBuild.distReady,
      builtAt:data.webBuild.builtAt || null,
      stale:!!data.webBuild.stale,
    }

    const ae = document.activeElement as HTMLElement | null
    const displayedConfig = data.restartRequired && data.savedConfig ? data.savedConfig : data
    syncConfigField(sdHost, displayedConfig.sdHost)
    syncConfigField(comfyHost, displayedConfig.comfyHost)
    syncConfigField(ttsHost, displayedConfig.ttsHost)
    syncConfigField(ttsEngine, displayedConfig.ttsEngine ?? 'gpt-sovits')
    const voices = displayedConfig.voices || {}
    syncConfigField(voiceNeneRef, voices.nene?.refAudioPath)
    syncConfigField(voiceNenePrompt, voices.nene?.promptText)
    syncConfigField(voiceNeneLora, voices.nene?.loraWeightsPath ?? '')
    syncConfigField(voiceNatsumeRef, voices.natsume?.refAudioPath)
    syncConfigField(voiceNatsumePrompt, voices.natsume?.promptText)
    syncConfigField(voiceNatsumeLora, voices.natsume?.loraWeightsPath ?? '')
    if (!savingAutoStartVoice.value && (ae?.tagName !== 'INPUT' || (ae as HTMLInputElement).type !== 'checkbox')) {
      autoStartVoice.value = !!data.autoStartVoice
    }

    actionBusy.value = !!(data.operation && data.operation.status === 'running')
    mainBtnLabel.value = tunnelActive.value ? '停止公网分享' : '启动并生成分享链接'

    const imageOnline = data.sdOnline || data.comfyOnline
    imageProvider.value = data.imageProvider === undefined ? 'comfy' : data.imageProvider
    if (imageProvider.value === 'native') {
      feedbackText.value = data.nativeRuntimeFilesReady ? '原生运行库已就绪' : '原生运行库待准备'
      actionNote.value = data.nativeRuntimeFilesReady
        ? '生成时按需加载模型'
        : '前往绘图与模型完成配置'
    } else if (imageProvider.value === null) {
      feedbackText.value = '绘图引擎配置待确认'
      actionNote.value = '请在原生首次配置中检查引擎设置。'
    } else if (imageOnline && data.ttsOnline && (data.llama?.online || data.ollamaOnline)) {
      feedbackText.value = '画面、语音与聊天均已就绪'
      actionNote.value = '可以完整使用绘制台、角色房间与配音。'
    } else if (imageOnline && data.ttsOnline) {
      feedbackText.value = '画面与语音就绪'
      actionNote.value = '出图与 AI 声线可用；本地聊天可在首次配置中准备 llama.cpp，也可使用 API。'
    } else if (imageOnline) {
      feedbackText.value = '画面创作就绪'
      actionNote.value = '可正常出图。需要角色声线时启动语音服务。'
    } else if (data.ttsOnline) {
      feedbackText.value = '语音已连接 · 等待绘图引擎'
      actionNote.value = '按需启动 ComfyUI，即可开始绘图。'
    } else {
      feedbackText.value = '浏览可用 · 等待生成服务'
      actionNote.value = '网站本身正常。按需启动绘图或语音服务，也可以先浏览角色与场景。'
    }
    if (data.restartRequired) {
      feedbackText.value = '配置已保存，重新启动应用后生效'
      actionNote.value = '当前连接仍使用原设置；重新启动后会使用下方已保存的配置。'
    }
    serviceChecking.value = false
  }

  async function loadShareLink() {
    if (disposed) return
    shareRequest?.abort()
    const controller = new AbortController()
    shareRequest = controller
    try {
      const data = await controlApi.getShareLink({ signal: controller.signal })
      if (shareRequest !== controller || controller.signal.aborted) return
      shareLink.value = data.shareLink
    } catch {
      if (shareRequest === controller) shareLink.value = ''
    } finally {
      if (shareRequest === controller) shareRequest = null
    }
  }

  async function pollStatus(force = false) {
    if (disposed) return
    if (force) serviceChecking.value = true
    statusRequest?.abort()
    const controller = new AbortController()
    statusRequest = controller
    try {
      const data = await controlApi.getStatus({ fresh: force, signal: controller.signal })
      if (statusRequest !== controller || controller.signal.aborted) return
      renderStatus(data)
      // 探测失败现在是 200 + ok:false + degraded（与三个同族 *-status 一致）。
      // 之前后端回 500，这里的 `if (!r.ok) return` 会把状态墙冻在上一次的值上，
      // 用户看到的是"点了没反应"而不是"探测失败"。
      if (data.ok === false && data.error) showToast('服务探测失败：' + data.error, true)
    } catch {
      if (statusRequest === controller && !controller.signal.aborted) {
        serviceChecking.value = false
        statusError.value = '无法连接本机控制服务'
      }
    } finally {
      if (statusRequest === controller) statusRequest = null
    }
  }

  async function pollLogs(force = false) {
    // Operations retain their log fallback even when the optional console is closed.
    if (disposed || (!force && !logsOpen.value && !opBusy.value) || (logsRequest && !force)) return
    logsRequest?.abort()
    const controller = new AbortController()
    logsRequest = controller
    logsLoading.value = true
    const revision = statusRevision
    try {
      const data: ControlLogs = await controlApi.getLogs(logIndex.value, { signal: controller.signal })
      if (logsRequest !== controller || controller.signal.aborted) return
      if (data.operation && revision === statusRevision && !operationSubmitting.value) {
        operation.value = data.operation
      }
      let followingTail = false
      if (data.logs.length) {
        const fresh: string[] = []
        for (const line of data.logs) {
          if (!seenLogLines.has(line)) fresh.push(line)
          seenLogLines.delete(line)
          seenLogLines.add(line)
        }
        while (seenLogLines.size > 600) seenLogLines.delete(seenLogLines.values().next().value!)
        if (fresh.length) {
          const box = logBoxEl.value
          followingTail = logsOpen.value && (!box || box.scrollHeight - box.scrollTop - box.clientHeight < 24)
          logs.value.push(...fresh)
          if (logs.value.length > 300) logs.value = logs.value.slice(-200)
        }
      }
      // 2026-08-16 审计：游标改为服务端权威 controlLogs 总长（total），而不是按本批
      // logs.length 自增——本批混入每文件 ≤30 行文件尾行，旧实现把游标逐轮推过头，
      // 新 controlLogs 从此永不上屏（逐条吞日志）。服务端保证 total 不含尾行。
      logIndex.value = data.total
      logsLoaded.value = true; logsError.value = ''
      if (followingTail) {
        await nextTick()
        if (logsRequest === controller && logsOpen.value && logBoxEl.value) logBoxEl.value.scrollTop = logBoxEl.value.scrollHeight
      }
    } catch (error) {
      if (logsRequest !== controller || controller.signal.aborted) return
      if (error instanceof ApiClientError && (error.status === 403 || error.status === 421)) {
        clearLogs()
        logsLoaded.value = false
      }
      logsError.value = '运行日志暂时无法读取，请检查连接后重试。'
    } finally {
      if (logsRequest === controller) { logsRequest = null; logsLoading.value = false }
    }
  }

  function cancelLogRead() {
    logsRequest?.abort()
    logsRequest = null
    logsLoading.value = false
  }
  function clearLogs() {
    cancelLogRead()
    logs.value = []
  }
  watch(logsOpen, open => {
    if (open) void pollLogs()
    else if (!opBusy.value) cancelLogRead()
  }, { flush: 'sync' })
  // 轮询底座（2026-08-28 审计 P1-9）：3s 状态/日志轮询收敛到 usePolling，
  // in-flight 去重、页面隐藏暂停（paused=document.hidden）、回前台 sync 续跑。
  let visibilityBound = false
  const polling = usePolling({
    intervalMs: 3000,
    tick: async () => { await Promise.all([pollStatus(), pollLogs()]) },
    paused: () => typeof document !== 'undefined' && document.hidden,
    immediate: true,
  })
  function handleVisibilityChange() { polling.sync() }
  function bindPollingVisibility() {
    if (visibilityBound || typeof document === 'undefined') return
    document.addEventListener('visibilitychange', handleVisibilityChange)
    visibilityBound = true
  }
  function unbindPollingVisibility() {
    if (!visibilityBound || typeof document === 'undefined') return
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    visibilityBound = false
  }
  function startPolling() {
    if (disposed || polling.isActive()) return
    bindPollingVisibility()
    polling.start()
  }
  function stopPolling() {
    unbindPollingVisibility()
    polling.stop()
    statusRequest?.abort()
    cancelLogRead()
    shareRequest?.abort()
    statusRequest = null
    shareRequest = null
    serviceChecking.value = false
  }

  return {
    tunnelActive, sdOnline, comfyOnline, ttsOnline, ollamaOnline, llamaOnline,llamaManaged,llamaLabel,webuiManaged, comfyManaged, ollamaModels, ollamaVram, selfHealing,
    modeBusy, operation, operationSubmitting, serviceChecking, statusLoaded, statusError, scripts,
    sdHost, comfyHost, ttsHost, ttsEngine, activeVoiceEngine, voiceNeneLora, voiceNatsumeLora, voiceNeneRef, voiceNenePrompt, voiceNatsumeRef, voiceNatsumePrompt, autoStartVoice, savingAutoStartVoice,
    tunnelStatus, shareLink, localLink, uptime, actionBusy, mainBtnLabel, webBuild,
    feedbackText, actionNote, overviewFeedback, imageProvider, logs, logBoxEl,
    logsOpen, logsLoading, logsLoaded, logsError, logsSummary,
    opBusy, opStatusLabel, opProgress, opCompletedStages, ollamaMeta, voiceConfiguredCount,
    lastStatus: () => lastStatus,
    captureConfigEdits, acknowledgeConfigEdits,
    pollStatus, pollLogs, clearLogs, startPolling, stopPolling,
    lineClass,
  }
}
