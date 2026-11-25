import { problem } from './results.mjs'

export const ID = '[A-Za-z0-9_-]{1,160}'
export const CONTROL_BODY = 64 * 1024
export const QQ_MESSAGE_BODY = 4 * 1024 * 1024 + CONTROL_BODY
export const IMAGE_JSON_BODY = 11 * 1024 * 1024 + 256 * 1024
export const VIDEO_INPUT_BODY = 4 * 1024 * 1024 + CONTROL_BODY
export const VIDEO_BATCH_BODY = 1024 * 1024
export const INPUT_LOOKUP_BODY = 2048

export const VOICE_SYNTHESIZE = '/api/muse/voice/synthesize'
export const VOICE_STATUS = '/api/muse/voice/status'
export const INTERROGATE_STATUS = '/api/muse/interrogate/status'
export const INTERROGATE_RUN = '/api/muse/interrogate'
export const UPSCALE_PATH = '/api/muse/upscale'
const DRAW_PREVIEW = '/api/muse/jobs/preview'
export const INPUTS_LOOKUP_PATH = '/api/muse/inputs/lookup'
export const HEALTH_PATH = '/api/muse/health'
export const VIDEO_STATUS = '/api/muse/video/status'
export const VIDEO_PREVIEW = '/api/muse/video/prompt/preview'
export const VIDEO_INPUTS = '/api/muse/video/inputs'
export const VIDEO_JOBS = '/api/muse/video/jobs'
export const VIDEO_BATCHES = '/api/muse/video/batches'
export const DESKTOP_INBOX = '/api/muse/desktop/inbox'

export const LEGACY_INBOX_INTERVAL_MS = 3000
export const MAX_INBOX_WAIT_SECONDS = 30
export const AGENT_IDLE_POLL_MS = 15_000
export const AGENT_ONLINE_MS = 45_000
export const AGENT_RECONNECT_GRACE_MS = 6_000

export const batchRoute = new RegExp('^/api/muse/batches/(' + ID + ')(?:/(' + ID + '))?$')
export const receiveRoute = new RegExp('^/api/muse/batches/(' + ID + ')/original/([1-9][0-9]?)$')
export const uploadRoute = /^\/_agent\/parts\/(anima|moss|qwen|creative|keyframe|manga)\/([a-f0-9]{32})\/(\d{1,3})$/
export const directRoute = new RegExp('^/api/(?:anima|moss|qwen|creative|keyframe|manga)/(?:jobs|requests)/' + ID + '$')
export const videoJobRoute = new RegExp('^/api/muse/video/(?:jobs|requests|batches|batch-requests)/' + ID + '$')
export const videoResultRoute = new RegExp('^/api/muse/video/(?:jobs|batches)/' + ID + '/result$')
export const videoConcatRoute = new RegExp('^/api/muse/video/batches/' + ID + '/concat$')
export const videoRetryRoute = new RegExp('^/api/muse/video/batches/' + ID + '/retry$')
export const galleryItemRoute = /^\/api\/muse\/gallery\/([^/?#]+)$/
export const galleryFileRoute = /^\/api\/muse\/gallery\/([^/?#]+)\/file$/

const requestKeyPattern = new RegExp('^' + ID + '$')

export const qqMessagePath = path => path === '/api/muse/qq/reply' || path === '/api/muse/qq/send'
export const chatPath = path => path.startsWith('/api/muse/qq/') || path.startsWith('/api/muse/desktop/')
export const voicePath = path => path === VOICE_STATUS || path === VOICE_SYNTHESIZE
export const interrogatePath = path => path === INTERROGATE_STATUS || path === INTERROGATE_RUN
export const videoPath = path => path.startsWith('/api/muse/video/')
export const galleryPath = path => path === '/api/muse/gallery' || path.startsWith('/api/muse/gallery/')
export const keyframePath = path => path.startsWith('/api/keyframe/')
export const mangaPath = path => path.startsWith('/api/manga/')
export const legacyModelReadPath = path => path === '/api/muse/options' || /^\/api\/(anima|moss|qwen|creative)\/status$/.test(path)
export const modelReadPath = path => path === '/api/muse/options' || /^\/api\/(anima|moss|qwen|creative|keyframe|manga)\/status$/.test(path)
export const noCacheRpcPath = path => chatPath(path) || voicePath(path) || interrogatePath(path) || videoPath(path) || path === HEALTH_PATH || path === DRAW_PREVIEW || galleryPath(path)
export const inboxPath = path => path === DESKTOP_INBOX || path === '/api/muse/qq/inbox'
export const mediaPartPath = path => videoResultRoute.test(path) || galleryFileRoute.test(path)

export async function readBody(request, limit) {
  if (Number(request.headers.get('Content-Length')) > limit) throw new RangeError()
  const reader = request.body?.getReader()
  const chunks = []
  let total = 0
  if (reader) for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if ((total += value.byteLength) > limit) { await reader.cancel(); throw new RangeError() }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes.buffer
}

export const decode = bytes => JSON.parse(new TextDecoder().decode(bytes))

export function validGalleryIdSegment(segment) {
  if (!segment || segment.length > 512 || segment === '.' || segment === '..' || segment.includes('..')) return false
  if (!/^(?:[A-Za-z0-9_.!~*'()-]|%[0-9A-Fa-f]{2})+$/.test(segment)) return false
  let decoded
  try { decoded = decodeURIComponent(segment) } catch { return false }
  return Boolean(decoded) && !/[\x00-\x1f\x7f\/\\]/.test(decoded) && !decoded.includes('..')
}

export function validatePartQuery(url, { requirePart, allowIdType }) {
  if (!url.search) return requirePart ? problem(400, 'MUSE_PART_REQUIRED', '经中转下载媒体文件请使用 ?part=N[&count=M] 分片参数') : null
  const seen = new Set()
  for (const [key, value] of url.searchParams.entries()) {
    if (seen.has(key)) return problem(400, 'INVALID_PARAMETER', '分片查询参数重复')
    seen.add(key)
    if (key === 'part') {
      if (!/^\d{1,9}$/.test(value)) return problem(400, 'INVALID_PARAMETER', 'part 须为非负整数')
    } else if (key === 'count') {
      if (!/^\d{1,2}$/.test(value) || Number(value) < 1 || Number(value) > 16) {
        return problem(400, 'INVALID_PARAMETER', 'count 须为 1 至 16 的整数')
      }
    } else if (key === 'idType' && allowIdType) {
      if (value !== 'string' && value !== 'number') return problem(400, 'INVALID_PARAMETER', 'idType 仅支持 string 或 number')
    } else {
      return problem(400, 'INVALID_PARAMETER', '包含不支持的查询参数')
    }
  }
  if (seen.has('count') && !seen.has('part')) return problem(400, 'INVALID_PARAMETER', '使用 count 时必须提供 part')
  if (requirePart && !seen.has('part')) return problem(400, 'MUSE_PART_REQUIRED', '经中转下载媒体文件请使用 ?part=N[&count=M] 分片参数')
  return null
}

export function control(method, path) {
  if (path === VOICE_STATUS) return method === 'GET'
  if (path === VOICE_SYNTHESIZE) return method === 'POST'
  if (path === INTERROGATE_STATUS) return method === 'GET'
  if (path === INTERROGATE_RUN) return method === 'POST'
  if (path === UPSCALE_PATH || path === DRAW_PREVIEW || path === INPUTS_LOOKUP_PATH) return method === 'POST'
  if (path === HEALTH_PATH || path === '/api/muse/gallery') return method === 'GET'
  if (path === VIDEO_STATUS) return method === 'GET'
  if (path === VIDEO_PREVIEW || path === VIDEO_INPUTS || path === VIDEO_JOBS || path === VIDEO_BATCHES) return method === 'POST'
  if (videoJobRoute.test(path)) return method === 'GET' || method === 'DELETE'
  if (videoResultRoute.test(path)) return method === 'GET' || method === 'HEAD'
  if (videoConcatRoute.test(path) || videoRetryRoute.test(path)) return method === 'POST'
  const galleryItem = galleryItemRoute.exec(path)
  if (galleryItem) return method === 'GET' && validGalleryIdSegment(galleryItem[1])
  const galleryFile = galleryFileRoute.exec(path)
  if (galleryFile) return (method === 'GET' || method === 'HEAD') && validGalleryIdSegment(galleryFile[1])
  if (path === '/api/muse/desktop/inbox') return method === 'GET'
  if (path === '/api/muse/desktop/reply') return method === 'POST'
  if (path === '/api/muse/qq/inbox' || path === '/api/muse/qq/targets') return method === 'GET'
  if (/^\/api\/muse\/qq\/context\/[0-9a-f]{64}$/.test(path)) return method === 'GET'
  if (qqMessagePath(path) || path === '/api/muse/qq/search') return method === 'POST'
  if (method === 'POST') return path === '/api/muse/jobs' || path === '/api/muse/batches'
  if (batchRoute.test(path) || directRoute.test(path)) return method === 'GET' || method === 'DELETE'
  return method === 'GET' && (modelReadPath(path) || /^\/api\/muse\/(catalog|queue|jobs|guide)$/.test(path)
    || /^\/api\/muse\/catalog\/(character|scene|blueprint|outfit)(\/[A-Za-z0-9_-]{1,180})+$/.test(path))
}

export function validateRouteQuery(method, url) {
  const path = url.pathname
  if (chatPath(path) || voicePath(path)) {
    if (!url.search) return null
    if (method === 'GET' && inboxPath(path)) {
      const value = url.searchParams.get('wait')
      if (url.searchParams.size !== 1 || value === null || !/^\d+$/.test(value) || Number(value) > 0xffffffff) {
        return problem(400, 'INVALID_WAIT', 'wait 须为一个非负整数，最多等待 30 秒')
      }
      return null
    }
    return problem(404, 'MUSE_ROUTE_NOT_FOUND', '找不到这个 Muse 接口')
  }
  if (interrogatePath(path) || path === UPSCALE_PATH || path === DRAW_PREVIEW || path === HEALTH_PATH || path === INPUTS_LOOKUP_PATH) {
    return url.search ? problem(400, 'INVALID_PARAMETER', '经中转调用此接口不支持 query 参数') : null
  }
  if (videoResultRoute.test(path)) {
    return validatePartQuery(url, { requirePart: method === 'GET', allowIdType: false })
  }
  if (galleryFileRoute.test(path)) {
    return validatePartQuery(url, { requirePart: method === 'GET', allowIdType: true })
  }
  if (galleryItemRoute.test(path)) {
    if (!url.search) return null
    const idType = url.searchParams.get('idType')
    if (url.searchParams.size !== 1 || (idType !== 'string' && idType !== 'number')) {
      return problem(400, 'INVALID_PARAMETER', 'idType 仅支持 string 或 number')
    }
    return null
  }
  if (videoPath(path) && path !== VIDEO_STATUS && path !== VIDEO_INPUTS && url.search) {
    return problem(400, 'INVALID_PARAMETER', '此视频接口不支持 query 参数')
  }
  return null
}

export function defaultCapabilities() {
  return {
    voice: false,
    modelRead: false,
    interrogate: false,
    upscale: false,
    video: false,
    gallery: false,
    health: false,
    keyframe: false,
    manga: false,
  }
}

export function parseAgentCapabilities(headers) {
  const caps = new Set(
    (headers.get('X-Muse-Capabilities') ?? '')
      .split(',')
      .map(item => item.trim())
      .filter(Boolean),
  )
  return {
    voice: headers.get('X-Muse-Voice') === '1' || caps.has('voice'),
    modelRead: headers.get('X-Muse-Options') === '1' || caps.has('modelRead'),
    interrogate: caps.has('interrogate'),
    upscale: caps.has('upscale'),
    video: caps.has('video'),
    gallery: caps.has('gallery'),
    health: caps.has('health'),
    keyframe: caps.has('keyframe'),
    manga: caps.has('manga'),
  }
}

export function requiresRequestKey(method, path) {
  if (method !== 'POST') return false
  return path !== INPUTS_LOOKUP_PATH && path !== DRAW_PREVIEW && path !== VIDEO_PREVIEW && path !== VIDEO_INPUTS && !videoConcatRoute.test(path)
}

export function largeBodyLimitFor(path) {
  if (path === INTERROGATE_RUN || path === UPSCALE_PATH) return IMAGE_JSON_BODY
  if (path === VIDEO_INPUTS) return VIDEO_INPUT_BODY
  if (path === VIDEO_BATCHES) return VIDEO_BATCH_BODY
  return null
}

export function bodyLimitFor(path, largeBodyLimit) {
  if (path === '/api/muse/batches') return 256 * 1024
  if (path === INPUTS_LOOKUP_PATH) return INPUT_LOOKUP_BODY
  return largeBodyLimit ?? CONTROL_BODY
}

export function validatePostBody(method, path, bytes) {
  if (videoConcatRoute.test(path) && bytes.byteLength === 0) return { body: undefined, error: null }
  const body = decode(bytes)
  if (qqMessagePath(path) && bytes.byteLength > CONTROL_BODY && typeof body?.image?.data !== 'string' && typeof body?.audio?.data !== 'string') {
    return { body: undefined, error: problem(413, 'MUSE_BODY_TOO_LARGE', '含图片或语音的消息可以超过 64 KiB') }
  }
  if (path === INPUTS_LOOKUP_PATH) {
    if (!Array.isArray(body) || body.length > 16 || body.some(item => typeof item !== 'string' || !/^[0-9a-f]{64}$/.test(item))) {
      return { body: undefined, error: problem(400, 'INVALID_REQUEST', '请输入最多 16 个小写 SHA-256 哈希数组') }
    }
  } else if (path === VIDEO_INPUTS) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.data !== 'string' || typeof body.mimeType !== 'string') {
      return { body: undefined, error: problem(400, 'INVALID_REQUEST', 'JSON 视频素材上传须包含 mimeType 与标准 Base64 data') }
    }
  } else if (path === DRAW_PREVIEW || path === VIDEO_PREVIEW || videoConcatRoute.test(path)) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { body: undefined, error: problem(400, 'INVALID_REQUEST', '请求体须为 JSON 对象') }
    }
  } else if (requiresRequestKey(method, path) && (typeof body?.requestKey !== 'string' || !requestKeyPattern.test(body.requestKey))) {
    return { body: undefined, error: problem(400, 'INVALID_REQUEST', '请提供稳定的 requestKey，推荐使用 UUID') }
  }
  return { body, error: null }
}

export function rpcTimeout(barePath, defaultTimeout, { mediaPart, interrogate, synthesize }) {
  let timeout = defaultTimeout
  if (qqMessagePath(barePath)) timeout = 105000
  if (barePath === '/api/muse/qq/search') timeout = 45000
  if (videoConcatRoute.test(barePath)) timeout = 130000
  if (barePath === UPSCALE_PATH || barePath === VIDEO_INPUTS) timeout = 75000
  if (mediaPart) timeout = 45000
  if (interrogate) timeout = 115000
  if (synthesize) timeout = 95000
  return timeout
}

export function rejectedRequestCode(barePath) {
  if (voicePath(barePath)) return 'MUSE_VOICE_REQUEST_REJECTED'
  if (barePath.startsWith('/api/muse/qq/')) return 'MUSE_QQ_REQUEST_REJECTED'
  if (barePath.startsWith('/api/muse/desktop/')) return 'MUSE_DESKTOP_REQUEST_REJECTED'
  if (interrogatePath(barePath)) return 'MUSE_INTERROGATE_REQUEST_REJECTED'
  if (barePath === UPSCALE_PATH) return 'MUSE_UPSCALE_REQUEST_REJECTED'
  if (videoPath(barePath)) return 'MUSE_VIDEO_REQUEST_REJECTED'
  if (galleryPath(barePath)) return 'MUSE_GALLERY_REQUEST_REJECTED'
  return 'MUSE_REQUEST_REJECTED'
}
