import { onScopeDispose, ref } from 'vue'
import { AcceptedTaskTerminalError } from '@/api/acceptedTaskOutcome'
import { apiClient, ApiClientError } from '@/api/client'
import { jobPath, fetchResultImage, waitForDirectImageJob } from '@/api/directImageJobs'
import { acceptDirectImageRequest, cancelDirectImageRequest } from '@/api/directImageRequests'
import { DirectRequestRejected } from '@/api/directGenerationRequests'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'

export interface GuestSubmission {
  prompt: string
  characterId?: string
  scene?: { id: string; kind: 'blueprint' | 'scene' }
}

export interface GuestResultPayload {
  blob: Blob
  seed?: number
  elapsedMs: number
}

export type GuestGenerationPhase = 'idle' | 'submitting' | 'queued' | 'running' | 'reading' | 'cancelling'

const requestStorage = 'huiyu.guest.request.v1'

function savedAttempt() {
  try {
    const raw = sessionStorage.getItem(requestStorage) || ''
    if (/^[a-f0-9-]{32,36}$/i.test(raw)) return raw
    if (raw) {
      const value = JSON.parse(raw)
      if (value?.family === 'anima' && typeof value.key === 'string') return value.key
    }
  } catch { /* A blocked browser store leaves the current tab usable. */ }
  return ''
}

function ended(error: unknown) {
  return error instanceof ApiClientError
    && ['JOB_LOST', 'JOB_NOT_FOUND', 'IMAGE_REQUEST_INTERRUPTED'].includes(error.code || '')
}

function entryRejection(error: unknown) {
  return error instanceof ApiClientError && [
    'RATE_LIMITED', 'INVALID_REQUEST', 'SHARE_LOCAL_GPU_REQUIRED', 'SCENE_RECIPE_CHANGED',
    'SCENE_RECIPE_NOT_FOUND', 'SCENE_RECIPES_UNAVAILABLE', 'GUEST_CHARACTER_RECIPE_MISSING',
  ].includes(error.code || '')
}

function messageFor(error: unknown) {
  if (error instanceof AcceptedTaskTerminalError || error instanceof DirectRequestRejected) return error.message
  if (error instanceof ApiClientError && error.status === 401) return '会话已失效，请重新打开邀请链接。'
  if (error instanceof ApiClientError && error.status === 429) return '请求太频繁了，请稍等几秒再试。'
  if (ended(error)) return '原任务已过期，或房主的服务已重启，可以重新生成。'
  if (entryRejection(error) && error instanceof Error) return error.message
  return '暂时无法读取原任务，连接恢复后可点击「继续读取原图」。'
}

async function readResult(path: string, signal: AbortSignal, reconnecting: () => void) {
  for (let retries = 0; ; retries++) {
    try { return await fetchResultImage(path, signal) }
    catch (cause) {
      signal.throwIfAborted()
      if (retries >= 2) throw cause
      reconnecting()
      await new Promise(resolve => setTimeout(resolve, (retries + 1) * 1200))
    }
  }
}

export function useGuestGeneration(onResult: (payload: GuestResultPayload) => void) {
  let invite = /^#[a-f0-9]{32}$/.test(location.hash) ? location.hash.slice(1) : ''
  const attempt = ref(savedAttempt())
  const busy = ref(false)
  const cancelling = ref(false)
  const checking = ref(false)
  const connected = ref(false)
  const ready = ref(false)
  const phase = ref<GuestGenerationPhase>('idle')
  const notice = ref('')
  const error = ref('')
  const progress = ref<number>()
  const elapsedSeconds = ref(0)
  const life = new AbortController()
  let run: AbortController | undefined
  let timer: ReturnType<typeof setInterval> | undefined

  function startTimer() {
    stopTimer()
    const startedAt = Date.now()
    elapsedSeconds.value = 0
    timer = setInterval(() => {
      elapsedSeconds.value = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
    }, 1000)
  }

  function stopTimer() {
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }

  onScopeDispose(() => {
    stopTimer()
    life.abort()
    run?.abort()
  })

  function keep(key = '') {
    attempt.value = key
    try {
      if (key) sessionStorage.setItem(requestStorage, key)
      else sessionStorage.removeItem(requestStorage)
    } catch { /* The active tab still owns its in-memory request. */ }
  }

  async function connect() {
    if (checking.value) return false
    checking.value = true
    error.value = ''
    try {
      if (invite) {
        await apiClient.request('/api/guest/session', {
          method: 'POST', body: { invite }, timeoutMs: 12_000, signal: life.signal,
        })
        invite = ''
        history.replaceState(null, '', location.pathname)
      }
      const status = await apiClient.request<{ ready: boolean }>('/api/anima/status', {
        cache: 'no-store', cachePolicy: 'bypass', timeoutMs: 15_000, signal: life.signal,
      })
      connected.value = true
      ready.value = status.ready === true
      return true
    } catch (cause) {
      connected.value = ready.value = false
      if (!life.signal.aborted) {
        error.value = cause instanceof ApiClientError && cause.status === 401
          ? '请重新打开房主发来的邀请链接。'
          : '暂时连不上房主的电脑，请确认对方保持绘遇运行后点「重新连接」。'
      }
      return false
    } finally { checking.value = false }
  }

  async function draw(submission?: GuestSubmission) {
    if (busy.value || cancelling.value || (submission ? !!attempt.value : !attempt.value)) return
    const current = new AbortController()
    run = current
    const { signal } = current
    const startedAt = Date.now()
    busy.value = true
    phase.value = 'submitting'
    progress.value = undefined
    error.value = ''
    startTimer()
    const key = submission ? crypto.randomUUID() : attempt.value
    notice.value = submission ? '正在向房主提交绘制请求…' : '正在查找原任务…'
    try {
      const accepted = await acceptDirectImageRequest('anima', { ...submission }, key, {
        signal, resume: !submission, onSubmitting: () => keep(key),
      })
      const job = await waitForDirectImageJob('anima', accepted.id, signal, {
        immediate: true, timeoutMs: 20 * 60_000, intervalMs: 1500,
        reconnecting: () => { notice.value = '网络波动，正在重新连接原任务…' },
        update: job => {
          if (job.status === 'queued') {
            phase.value = 'queued'
            notice.value = '正在排队等候房主出图…'
          } else if (job.status === 'cancelling') {
            phase.value = 'cancelling'
            notice.value = '正在停止绘制…'
          } else {
            phase.value = 'running'
            notice.value = '房主正在为你绘制画面…'
          }
          progress.value = typeof job.progress === 'number' ? Math.max(0, Math.min(1, job.progress)) : undefined
        },
      })
      const path = jobPath('anima', job.id) + '/result'
      if (job.resultUrl !== path) throw new Error('图片地址与原任务不符')
      phase.value = 'reading'
      notice.value = '画好了，正在把成品传到你的屏幕…'
      const blob = await readResult(path, signal, () => { notice.value = '正在重新读取这张图…' })
      signal.throwIfAborted()
      const seed = typeof job.seed === 'number' && Number.isFinite(job.seed) ? job.seed : undefined
      onResult({ blob, seed, elapsedMs: Date.now() - startedAt })
      keep()
      notice.value = '绘制完成，点击画面可放大查看。'
    } catch (cause) {
      if (signal.aborted) return
      if (cause instanceof AcceptedTaskTerminalError || cause instanceof DirectRequestRejected || ended(cause)
        || (submission && entryRejection(cause))) keep()
      notice.value = ''
      error.value = messageFor(cause)
    } finally {
      if (run === current) {
        run = undefined
        busy.value = false
        phase.value = 'idle'
        progress.value = undefined
        stopTimer()
      }
    }
  }

  async function cancel() {
    if (cancelling.value) return
    run?.abort()
    const key = attempt.value
    if (!key) { notice.value = ''; return }
    cancelling.value = true
    phase.value = 'cancelling'
    notice.value = '正在停止绘制…'
    error.value = ''
    try {
      const job = await cancelDirectImageRequest('anima', key, runtimeResourceIdentity())
      if (life.signal.aborted) return
      if (!job || (job.upstreamSettled === true && job.unknown === false && ['failed', 'cancelled'].includes(job.status))) {
        keep()
        notice.value = '已停止这次绘制。'
      } else {
        notice.value = job.status === 'succeeded' ? '图片其实已经画好了，可点击「继续读取原图」。' : '已发送停止请求，可稍后查看状态。'
      }
    } catch (cause) {
      if (life.signal.aborted) return
      if (ended(cause)) keep()
      notice.value = ''
      error.value = messageFor(cause)
    } finally {
      cancelling.value = false
      if (!busy.value) phase.value = 'idle'
    }
  }

  return {
    attempt,
    busy,
    cancelling,
    checking,
    connected,
    ready,
    phase,
    notice,
    error,
    progress,
    elapsedSeconds,
    connect,
    draw,
    cancel,
  }
}
