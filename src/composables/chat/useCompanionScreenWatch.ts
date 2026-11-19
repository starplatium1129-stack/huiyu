import { computed, onScopeDispose, ref, watch } from 'vue'
import { requestScreenWatchComment, type ScreenWatchConnection } from '@/api/companionScreenWatchApi'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'
import { maintenanceFrozen, registerMaintenanceParticipant } from '@/platform/maintenanceParticipants'
import { abortableTask } from '@/utils/abortableTask'
import { createScreenWatchCapture, screenWatchChanged, type ScreenWatchFrame } from '@/utils/screenWatchCapture'

const SAMPLE_MS = 750
const QUIET_MS = 1500
const PACE_MS = { quiet: 55_000, balanced: 28_000 }

interface ScreenWatchOptions {
  connection: () => ScreenWatchConnection | null
  character: () => string
  visible: () => boolean
  chatting: () => boolean
  quiet: () => boolean
  onGesture: () => void
  onComment: (line: string, aloud: boolean) => void
  onInterrupt: () => void
}

export function useCompanionScreenWatch(options: ScreenWatchOptions) {
  const state = ref<'idle' | 'choosing' | 'watching' | 'paused'>('idle')
  const pace = ref<keyof typeof PACE_MS>('quiet')
  const listenForGaps = ref(false)
  const audioAvailable = ref(false)
  const audioBusy = ref(false)
  const frameAvailable = ref(false)
  const comment = ref('')
  const notice = ref('')
  const inspecting = ref(false)
  const supported = typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function'
  const origin = computed(() => options.connection()?.origin || '')
  const canInspect = computed(() => state.value === 'watching' && !inspecting.value && !options.chatting())
  const status = computed(() => {
    if (state.value === 'paused') return '已暂停'
    if (inspecting.value) return '正在看画面'
    if (options.chatting()) return '等待对话空闲'
    if (options.quiet()) return '勿扰中'
    if (!frameAvailable.value) return '等待共享画面'
    if (audioBusy.value) return '等待声音空档'
    return '陪看中'
  })
  let owner: AbortController | undefined
  let request: AbortController | undefined
  let manualRequest = false
  let capture: ReturnType<typeof createScreenWatchCapture> | undefined
  let audio: AudioContext | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let audioTimer: ReturnType<typeof setInterval> | undefined
  let baseline: ScreenWatchFrame | null = null
  let changedSamples = 0
  let lastAudio = -Infinity
  let lastRequest = -Infinity
  let unanswered = 0
  const recent: string[] = []

  function release(message = '') {
    clearTimeout(timer)
    clearInterval(audioTimer)
    owner?.abort()
    request?.abort()
    owner = undefined
    request = undefined
    capture?.close()
    capture = undefined
    if (audio) void audio.close().catch(() => {})
    audio = undefined
    baseline = null
    recent.length = 0
    changedSamples = 0
    audioAvailable.value = false
    audioBusy.value = false
    frameAvailable.value = false
    inspecting.value = false
    comment.value = ''
    state.value = 'idle'
    notice.value = message
    options.onInterrupt()
  }

  function schedule() {
    clearTimeout(timer)
    if (state.value === 'watching') timer = setTimeout(() => { void sample(false) }, SAMPLE_MS)
  }

  function trackAudio() {
    const source = capture
    if (!source) return
    const now = performance.now()
    audioAvailable.value = source.hasAudio()
    if (source.audioActive()) lastAudio = now
    audioBusy.value = audioAvailable.value && now - lastAudio < QUIET_MS
  }

  function startAudioMeter() {
    if (!audio) return
    clearInterval(audioTimer)
    trackAudio()
    audioTimer = setInterval(trackAudio, 150)
  }

  async function start() {
    if (state.value !== 'idle' || !supported || !options.connection() || !options.visible() || maintenanceFrozen()) return
    options.onGesture()
    const current = owner = new AbortController()
    const picking = AbortSignal.any([current.signal, AbortSignal.timeout(60_000)])
    state.value = 'choosing'
    notice.value = ''
    const withAudio = listenForGaps.value && typeof AudioContext === 'function'
    try {
      // Start the browser picker in the original click. A late grant after
      // cancellation owns no session and its tracks must be stopped immediately.
      const selection = navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'window', width: { max: 1280 }, height: { max: 960 }, frameRate: { ideal: 3, max: 5 } },
        audio: withAudio,
      })
      if (withAudio) {
        try {
          audio = new AudioContext()
          void audio.resume().catch(() => {})
        } catch { audio = undefined }
      }
      void selection.then(stream => {
        if (picking.aborted) for (const track of stream.getTracks()) track.stop()
      }, () => {})
      const stream = await abortableTask(() => selection, picking)
      try {
        picking.throwIfAborted()
        capture = createScreenWatchCapture(stream, audio ?? null)
      } catch (error) {
        for (const track of stream.getTracks()) track.stop()
        throw error
      }
      capture.track.addEventListener('ended', () => {
        if (owner === current) release('屏幕共享已结束。')
      }, { once: true, signal: current.signal })
      if (capture.track.readyState === 'ended') throw new Error('屏幕共享已结束。')
      await abortableTask(capture.play, picking)
      picking.throwIfAborted()
      lastRequest = -Infinity
      lastAudio = performance.now()
      unanswered = 0
      state.value = 'watching'
      startAudioMeter()
      schedule()
    } catch (error) {
      if (owner !== current) return
      const message = error instanceof DOMException && error.name === 'NotAllowedError' ? '屏幕共享已取消或未获允许。'
        : picking.reason instanceof DOMException && picking.reason.name === 'TimeoutError' ? '等待选择画面超时。'
          : '当前窗口无法开始屏幕共享。'
      release(message)
    }
  }

  function pause(message = '') {
    if (!capture || state.value !== 'watching') return
    clearTimeout(timer)
    clearInterval(audioTimer)
    request?.abort()
    request = undefined
    inspecting.value = false
    state.value = 'paused'
    capture.pause(true)
    void audio?.suspend().catch(() => {})
    baseline = null
    changedSamples = 0
    notice.value = message
    options.onInterrupt()
  }

  function resume() {
    const current = owner
    if (!current || !capture || state.value !== 'paused') return
    notice.value = ''
    state.value = 'watching'
    lastAudio = performance.now()
    void audio?.resume().catch(() => {})
    void capture.pause(false)?.catch(() => {
      if (owner === current && state.value === 'watching') pause('共享画面还未恢复，请检查共享窗口。')
    })
    startAudioMeter()
    schedule()
  }

  async function sample(manual: boolean) {
    const current = owner
    const source = capture
    if (!current || !source || state.value !== 'watching' || request) return
    let active: AbortController | undefined
    try {
      if (options.chatting()) return
      const now = performance.now()
      trackAudio()
      const frame = source.sample()
      frameAvailable.value = frame !== null
      if (!frame) {
        if (manual) notice.value = '画面暂不可用，请恢复共享窗口后重试。'
        return
      }
      if (!baseline) baseline = frame
      const changed = screenWatchChanged(baseline, frame)
      changedSamples = changed ? changedSamples + 1 : 0
      const cooldown = PACE_MS[pace.value] * (1 + Math.min(4, unanswered) * 0.45)
      if (!manual && (options.quiet() || changedSamples < 2 || now - lastRequest < cooldown
        || audioBusy.value)) return
      const connection = options.connection()
      if (!connection) { release('视觉聊天连接已改变，请重新选择共享画面。'); return }
      const character = options.character()
      const jpeg = source.jpeg()
      baseline = frame
      changedSamples = 0
      lastRequest = now
      if (manual) unanswered = 0
      manualRequest = manual
      active = request = new AbortController()
      inspecting.value = true
      notice.value = ''
      const signal = AbortSignal.any([active.signal, current.signal, AbortSignal.timeout(25_000)])
      const line = await requestScreenWatchComment({ connection, character, frame: jpeg, manual, previous: comment.value, signal })
      if (signal.aborted || owner !== current || state.value !== 'watching' || options.chatting() || (!manual && options.quiet())) return
      if (!line) {
        if (manual) notice.value = '这次没有收到可展示的短评。'
        return
      }
      const normalized = line.toLowerCase().replace(/[\s\p{P}]/gu, '')
      if (!normalized || !manual && recent.includes(normalized)) return
      recent.push(normalized)
      if (recent.length > 4) recent.shift()
      if (!manual) unanswered++
      comment.value = line
      trackAudio()
      options.onComment(line, !options.quiet() && !audioBusy.value)
    } catch {
      if (owner === current && !active?.signal.aborted && !current.signal.aborted) {
        pause('视觉服务没有完成这次看屏。请确认聊天模型支持图片，或稍后继续。')
      }
    } finally {
      if (owner === current && (!active || request === active)) {
        request = undefined
        inspecting.value = false
        schedule()
      }
    }
  }

  function inspectNow() {
    if (!canInspect.value) return
    options.onGesture()
    clearTimeout(timer)
    void sample(true)
  }

  watch([options.connection, options.character, runtimeResourceIdentity], () => {
    if (owner) release('角色或视觉连接已变化，请重新选择共享画面。')
  }, { flush: 'sync' })
  watch(options.visible, visible => {
    if (!visible && owner) release('桌宠已隐藏，屏幕共享已结束。')
  }, { flush: 'sync' })
  watch(options.chatting, busy => {
    if (!busy || !owner) return
    unanswered = 0
    request?.abort()
    if (state.value === 'watching') options.onInterrupt()
  }, { flush: 'sync' })
  watch(options.quiet, quiet => {
    if (!quiet || !owner) return
    if (!manualRequest) request?.abort()
    options.onInterrupt()
  }, { flush: 'sync' })
  const unregister = registerMaintenanceParticipant(() => release())
  onScopeDispose(() => { unregister(); release() })

  return { state, pace, listenForGaps, audioAvailable, comment, notice, supported, origin, canInspect, status, inspecting,
    start, pause, resume, inspectNow, stop: () => release() }
}
