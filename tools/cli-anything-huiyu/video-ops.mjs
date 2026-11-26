import { setTimeout as delay } from 'node:timers/promises'
import { api, apiRaw, connection, readFileBytes, readInput, readStdin } from './muse.mjs'
import { saveVerifiedMedia } from './download.mjs'

export const MAX_RAW_VIDEO_INPUT = 20 * 1024 * 1024
export const MAX_JSON_VIDEO_INPUT = 3 * 1024 * 1024
export const MAX_BATCH_JSON_BYTES = 1024 * 1024
const PNG_HEADER = Buffer.from('89504e470d0a1a0a', 'hex')
const ACTIVE_STATUSES = new Set(['waiting', 'queued', 'pending', 'running', 'cancelling'])
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504])
const TRANSIENT_ERROR = new Set(['ABORT_ERR', 'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN', 'EPIPE', 'ETIMEDOUT', 'ERR_STREAM_PREMATURE_CLOSE'])

export const VIDEO_INPUT_KINDS = new Map([
  ['image', 'image'],
  ['first-frame', 'image'],
  ['last-frame', 'image'],
  ['frame', 'image'],
  ['studio-frame', 'studio-frame'],
  ['reference', 'reference'],
  ['ref', 'reference'],
  ['driving-video', 'driving-video'],
  ['video', 'driving-video'],
  ['motion', 'driving-video'],
  ['driving-audio', 'driving-audio'],
  ['audio', 'driving-audio'],
  ['studio-audio', 'studio-audio'],
])

export const VIDEO_CREATE_TEXT_OPTIONS = {
  model: 'modelId',
  negative: 'negative',
  'aspect-ratio': 'aspectRatio',
  camera: 'camera',
  motion: 'motion',
  quality: 'quality',
  'h3-decoder': 'h3Decoder',
  'video-attention': 'videoAttention',
  image: 'image',
  'last-frame': 'lastFrame',
  'driving-audio': 'drivingAudio',
  'driving-video': 'drivingVideo',
}

export function validIdOrKey(value, label = '任务标识') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) {
    throw new Error(`${label}须为 1–160 个字母、数字、下划线或连字符。`)
  }
  return value
}

export function parsePositiveInt(raw, label) {
  if (!/^\d+$/.test(raw)) throw new Error(`${label} 需要正整数。`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} 需要正整数。`)
  return value
}

export function parseNonNegativeInt(raw, label) {
  if (!/^\d+$/.test(raw)) throw new Error(`${label} 需要非负整数。`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) throw new Error(`${label} 需要非负整数。`)
  return value
}

export function parseDuration(raw) {
  const value = Number(raw)
  if (!raw.trim() || !Number.isFinite(value) || value <= 0) throw new Error('--duration 需要正数。')
  return value
}

export function parseWaitTimeout(raw, fallback = 1800) {
  if (raw === undefined) return fallback
  const value = parsePositiveInt(raw, '--timeout')
  if (value > 2_147_483) throw new Error('--timeout 最多为 2147483 秒。')
  return value
}

export function parseWaitInterval(raw, fallback = 3) {
  if (raw === undefined) return fallback
  const value = parsePositiveInt(raw, '--interval')
  if (value < 2) throw new Error('--interval 至少为 2 秒。')
  return value
}

function sniffVideoInputMime(buffer) {
  if (buffer.length >= PNG_HEADER.length && buffer.subarray(0, PNG_HEADER.length).equals(PNG_HEADER)) return 'image/png'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WAVE') return 'audio/wav'
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') return 'video/mp4'
  return null
}

function validateMimeForKind(canonicalKind, mime) {
  if (['image', 'studio-frame', 'reference'].includes(canonicalKind)) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) {
      throw new Error(`类型 ${canonicalKind} 仅支持 PNG、JPEG 或 WebP 图片。`)
    }
    return
  }
  if (canonicalKind === 'driving-video') {
    if (mime !== 'video/mp4') throw new Error('driving-video 仅支持 MP4 视频（video/mp4）。')
    return
  }
  if (['driving-audio', 'studio-audio'].includes(canonicalKind)) {
    if (mime !== 'audio/wav') throw new Error(`${canonicalKind} 仅支持 PCM WAV 音频（audio/wav）。`)
  }
}

export async function readLargeJson(file, limit, label) {
  if (file === '-') return JSON.parse(await readStdin(limit, label))
  const data = await readFileBytes(file, limit, label)
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(data) }
  catch { throw new Error(`${label}需要使用 UTF-8 编码。`) }
  return JSON.parse(text)
}

export async function videoStatus(options = {}) {
  const query = new URLSearchParams()
  if (options.model !== undefined) {
    if (!options.model.trim() || [...options.model].length > 160 || /\p{Cc}/u.test(options.model)) {
      throw new Error('--model 须为 1–160 字且不含控制字符。')
    }
    query.set('modelId', options.model.trim())
  }
  return api('GET', query.size ? `/api/muse/video/status?${query}` : '/api/muse/video/status')
}

export async function videoPreview(options) {
  let body = {}
  if (options.file !== undefined) {
    const loaded = await readInput(options.file, false)
    if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
      throw new Error('--file 须包含一个 JSON 对象。')
    }
    body = { ...loaded }
  }
  if (options.model !== undefined) body.modelId = options.model
  if (options.mode !== undefined) body.mode = options.mode
  if (options.duration !== undefined) body.duration = parseDuration(options.duration)
  if (options.camera !== undefined) body.camera = options.camera
  if (options.motion !== undefined) body.motion = options.motion
  if (options.prompt !== undefined) {
    body.prompt = options.prompt === '-' ? await readStdin(32 * 1024, '视频提示词') : options.prompt
  }
  if (options.negative !== undefined) body.negative = options.negative
  if (options['aspect-ratio'] !== undefined) body.aspectRatio = options['aspect-ratio']
  if (options.quality !== undefined) body.quality = options.quality
  if (typeof body.modelId !== 'string' || !body.modelId.trim()) {
    throw new Error('请指定 --model 模型 ID 或在 --file 中提供 modelId。')
  }
  return api('POST', '/api/muse/video/prompt/preview', body)
}

export async function videoUpload(filePath, { kind = 'image', mode = 'auto' } = {}) {
  const canonicalKind = VIDEO_INPUT_KINDS.get(kind)
  if (!canonicalKind) {
    throw new Error('--kind 须为 image、first-frame、last-frame、studio-frame、reference、driving-video、driving-audio 或 studio-audio。')
  }
  if (!['auto', 'raw', 'json'].includes(mode)) {
    throw new Error('--mode 须为 auto、raw 或 json。')
  }
  const useJson = mode === 'json' || (mode === 'auto' && connection().mode === 'relay')
  const limit = useJson ? MAX_JSON_VIDEO_INPUT : MAX_RAW_VIDEO_INPUT
  const data = await readFileBytes(filePath, limit, '视频素材')
  if (data.length < 16) throw new Error('视频素材文件过小或已损坏。')

  let result
  if (useJson) {
    const mimeType = sniffVideoInputMime(data)
    if (!mimeType) throw new Error('无法识别素材格式（支持 PNG/JPEG/WebP、MP4、WAV）。')
    validateMimeForKind(canonicalKind, mimeType)
    result = await api('POST', '/api/muse/video/inputs', {
      kind: canonicalKind,
      mimeType,
      data: data.toString('base64'),
    }, { timeoutMs: 90_000 })
  } else {
    result = await apiRaw(
      'POST',
      `/api/muse/video/inputs?kind=${encodeURIComponent(canonicalKind)}`,
      data,
      'application/octet-stream',
      { timeoutMs: 90_000 },
    )
  }
  return { ...result, transport: useJson ? 'json' : 'raw' }
}

function isVideoTerminal(receipt, isBatch) {
  if (receipt?.rejected) return true
  const entity = isBatch ? (receipt?.batch ?? receipt) : (receipt?.job ?? receipt)
  const status = entity?.status
  return typeof status === 'string' && !ACTIVE_STATUSES.has(status)
}

export async function videoJob(idOrKey, { byRequest = false, batch = false } = {}) {
  const target = validIdOrKey(idOrKey)
  const primary = batch
    ? (byRequest ? `/api/muse/video/batch-requests/${target}` : `/api/muse/video/batches/${target}`)
    : (byRequest ? `/api/muse/video/requests/${target}` : `/api/muse/video/jobs/${target}`)
  try {
    return await api('GET', primary)
  } catch (error) {
    if (byRequest || error.httpStatus !== 404) throw error
    const fallback = batch
      ? `/api/muse/video/batch-requests/${target}`
      : `/api/muse/video/requests/${target}`
    return api('GET', fallback)
  }
}

export async function videoWait(idOrKey, { byRequest = false, batch = false, timeout = 1800, interval = 3, initial } = {}) {
  const target = validIdOrKey(idOrKey)
  const signal = AbortSignal.timeout(Math.ceil(timeout * 1000))
  const due = performance.now() + timeout * 1000
  let snapshot = initial
  let nextPollAt = performance.now() + (snapshot ? interval * 1000 : 0)

  for (;;) {
    if (snapshot && isVideoTerminal(snapshot, batch)) return snapshot
    if (signal.aborted || performance.now() >= due) break
    try {
      const remaining = due - performance.now()
      const sleep = Math.min(remaining, nextPollAt - performance.now())
      if (sleep > 0) await delay(Math.ceil(sleep), undefined, { signal })
      if (performance.now() >= due) break
      snapshot = await videoJob(target, { byRequest, batch })
      nextPollAt = performance.now() + interval * 1000
    } catch (error) {
      if (signal.aborted) break
      const transient = TRANSIENT_STATUS.has(error.httpStatus) || TRANSIENT_ERROR.has(error.code)
      if (!transient) throw error
      nextPollAt = performance.now() + Math.max(interval, error.retryAfterSeconds ?? 0) * 1000
    }
  }
  return { ...(snapshot ?? { ok: true, id: target }), timedOut: true }
}

export async function videoCancel(idOrKey, { byRequest = false, batch = false } = {}) {
  const target = validIdOrKey(idOrKey)
  const primary = batch
    ? (byRequest ? `/api/muse/video/batch-requests/${target}` : `/api/muse/video/batches/${target}`)
    : (byRequest ? `/api/muse/video/requests/${target}` : `/api/muse/video/jobs/${target}`)
  try {
    return await api('DELETE', primary)
  } catch (error) {
    if (byRequest || error.httpStatus !== 404) throw error
    const fallback = batch
      ? `/api/muse/video/batch-requests/${target}`
      : `/api/muse/video/requests/${target}`
    return api('DELETE', fallback)
  }
}

export async function saveFromVideoJob(job, outputPath, singleConnection) {
  if (!job || job.resultAvailable !== true || typeof job.resultUrl !== 'string') {
    throw Object.assign(new Error(`视频成片暂不可用，当前状态：${job?.status ?? 'unknown'}。`), {
      code: job?.code || 'RESULT_UNAVAILABLE',
    })
  }
  const saved = await saveVerifiedMedia({
    url: job.resultUrl,
    bytes: job.resultBytes,
    sha256: job.resultSha256,
    mimeType: job.resultMime,
    partBytes: job.partBytes,
    outputPath,
    singleConnection,
  })
  return { ok: true, jobId: job.id, ...saved }
}

export async function videoSave(idOrKey, outputPath, { byRequest = false, batch = false, shot, singleConnection = false } = {}) {
  if (shot !== undefined && !batch) throw new Error('--shot 仅用于 --batch 分镜批次。')
  const receipt = await videoJob(idOrKey, { byRequest, batch })
  if (!batch) {
    return saveFromVideoJob(receipt.job ?? receipt, outputPath, singleConnection)
  }
  const batchObj = receipt.batch ?? receipt
  if (shot !== undefined) {
    const index = parsePositiveInt(String(shot), '--shot')
    const shotRow = batchObj?.shots?.[index - 1]
    if (!shotRow) throw new Error(`分镜批次中不存在第 ${index} 个分镜。`)
    if (shotRow.resultAvailable !== true || typeof shotRow.resultUrl !== 'string') {
      throw Object.assign(new Error(`第 ${index} 个分镜暂不可下载，状态：${shotRow.status ?? 'unknown'}。`), {
        code: shotRow.code || 'RESULT_UNAVAILABLE',
      })
    }
    const saved = await saveVerifiedMedia({
      url: shotRow.resultUrl,
      bytes: shotRow.resultBytes,
      sha256: shotRow.resultSha256,
      mimeType: shotRow.resultMime,
      partBytes: batchObj.partBytes,
      outputPath,
      singleConnection,
    })
    return { ok: true, batchId: batchObj.id, shot: index, ...saved }
  }
  if (!batchObj || batchObj.concatAvailable !== true || typeof batchObj.concatUrl !== 'string') {
    throw Object.assign(new Error(`分镜拼接成片尚不可用，当前状态：${batchObj?.status ?? 'unknown'}。可先执行 video concat。`), {
      code: 'RESULT_UNAVAILABLE',
    })
  }
  const saved = await saveVerifiedMedia({
    url: batchObj.concatUrl,
    bytes: batchObj.concatBytes,
    sha256: batchObj.concatSha256,
    mimeType: batchObj.concatMime,
    partBytes: batchObj.partBytes,
    outputPath,
    singleConnection,
  })
  return { ok: true, batchId: batchObj.id, ...saved }
}
