import { createHash, timingSafeEqual } from 'node:crypto'
import { PART, problem } from './results.mjs'
import {
  DESKTOP_INBOX, HEALTH_PATH, INPUTS_LOOKUP_PATH, INTERROGATE_RUN, INTERROGATE_STATUS,
  UPSCALE_PATH, VIDEO_BATCHES, VIDEO_INPUTS, VIDEO_JOBS, VIDEO_PREVIEW, VIDEO_STATUS,
  VOICE_STATUS, VOICE_SYNTHESIZE, galleryPath, interrogatePath, keyframePath,
  legacyModelReadPath, mangaPath, qqMessagePath, videoPath, voicePath,
} from './routes.mjs'

export const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
export const json = (value, status = 200, retryAfter) => Response.json(value, {
  status, headers: retryAfter ? { ...headers, 'Retry-After': String(retryAfter) } : headers,
})
export const unavailable = () => problem(503, 'MUSE_LAPTOP_UNAVAILABLE', '出图机暂未回应。请重查原路径，提交重试请复用原 requestKey', { 'Retry-After': '3' })
export const inboxUnavailable = () => problem(503, 'MUSE_CONNECTOR_INBOX_NO_REPLY', '出图机连接器近期在线，但这次取信未收到回执。请续接原收信地址', { 'Retry-After': '3' })
export const voiceBusy = () => ({ status: 429, data: { ok: false, code: 'MUSE_VOICE_BUSY', message: '语音合成繁忙，请稍后重试' }, retry: '3' })
export const interrogateBusy = () => ({ status: 429, data: { ok: false, code: 'MUSE_INTERROGATE_BUSY', message: '图像反推繁忙，请稍后重试' }, retry: '3' })
export const mediaPartBusy = () => ({ status: 429, data: { ok: false, code: 'MUSE_MEDIA_BUSY', message: '媒体分片通道繁忙，请稍后重试' }, retry: '2' })
export const outdated = (code, message, status = 503) => ({ status, data: { ok: false, code, message } })
export const voiceUnsupported = () => outdated('MUSE_VOICE_CONNECTOR_OUTDATED', '主力机连接器需要更新才能使用远程语音')
export const modelReadUnsupported = () => outdated('MUSE_OPTIONS_CONNECTOR_OUTDATED', '出图机连接器需要更新才能通过中转查询已装模型', 404)

export const POLL_SECONDS = 2
export const RECEIVE_WAIT_SECONDS = 20
export const PARALLEL_DOWNLOAD_MIN = 1024 * 1024
export const PARALLEL_DOWNLOAD_CONNECTIONS = 4
export const stopped = ['failed', 'cancelled', 'interrupted']
export const deliveryErrors = { expired: 410, storageFull: 507, integrityError: 502, invalidReceipt: 502 }

export const publicGuide = {
  name: '绘遇远程出图（Muse 等 AI 助手）', protocol: 'huiyu-muse', authHeader: 'X-Token',
  guidePath: '/api/muse/guide', drawPath: '/api/muse/jobs', optionsPath: '/api/muse/options', partBytes: PART,
  agentTools: { cli: 'cli-anything-huiyu --json help', history: 'GET /api/muse/jobs', batch: 'GET /api/muse/batches/{batchKey}',
    functionCalling: 'cli-anything-huiyu --json help invoke 可读取 huiyu_drawing 函数定义。把参数作为 JSON 写入 --json invoke 的标准输入。',
    handoff: '共享 batchKey 交接任务；各助手可用 助手名_UUID 作 requestKey。重试沿用原编号和请求体。',
    errors: '按批次读取 items[].status、code、error、deliveryStatus；历史按 failedCount 或失败状态筛选，nextBefore 传给 before 续页。' },
  desktopChat: {
    inbox: '/api/muse/desktop/inbox', reply: '/api/muse/desktop/reply',
    usage: 'GET inbox?wait=25（HTTP 超时 ≥40s）；空结果立即续接，缺失 inboxWaitSeconds 时等 2s。按 conversationId 与 messages 回答，expiresAt 前凭原 requestKey 与 text 提交，重试沿用完整回复。',
    drawing: '用户要出图且来信 drawingAllowed=true 时可附 drawing，使用批次的 ids 或 items 参数，省略 requestKey。桌面在原对话显示出图进度和成图。',
  },
  qq: {
    senderIdentity: '同群按 senderId 认人，senderNickname 作称呼；senderRole=owner 为群主，admin 管理员，member 成员，unknown 未核实。',
    inbox: '/api/muse/qq/inbox', reply: '/api/muse/qq/reply', targets: '/api/muse/qq/targets',
    send: '/api/muse/qq/send', search: '/api/muse/qq/search',
    usage: '独立 GET inbox?wait=25（HTTP 超时 ≥40s），空结果立即续接。凭 recentMessages 回答，在 expiresAt 前凭原 requestKey POST reply（支持 text + 可选 image/audio 附件或仅附件，Base64 原文件 ≤3 MiB，status=sent 表已送达）。',
    context: '私聊附最近 1h ≤6 条；群聊更多前文 GET /api/muse/qq/context/{conversationId}（近 1h ≤64 条）。',
    skip: '无需插话的普通群消息提交 {requestKey,skip:true}，返回 status=skipped。',
    proactive: '开启主动发送后，从 GET targets 选 conversationId，POST send（新 requestKey + text/image/audio 三选一）。',
    webSearch: 'POST search 传原 requestKey + query（主动检索传新 UUID + conversationId + query），返回 title/url/snippet。',
  },
  voice: { status: VOICE_STATUS, synthesize: VOICE_SYNTHESIZE, language: 'ja',
    usage: 'GET status 确认所选声线可用，再 POST synthesize 提交 requestKey 和 1–500 字的日语台词 text。按 mimeType 保存并核对 bytes 与 sha256。' },
  interrogate: { status: INTERROGATE_STATUS, run: INTERROGATE_RUN, maxJsonImageBytes: 8 * 1024 * 1024,
    usage: 'POST /api/muse/interrogate 传 JSON {requestKey,imageBase64,mimeType?,mode?,threshold?,assist?,subjectMode?,layout?,noCache?}（原图 ≤8 MiB，HTTP 超时 ≥110s；默认按图片 SHA-256 与参数启用服务端持久化结果缓存，仅缓存成功结果）。' },
  upscale: { path: UPSCALE_PATH, maxJsonImageBytes: 8 * 1024 * 1024,
    usage: 'POST /api/muse/upscale 传 requestKey 与 initImage 或 imageBase64（≤8 MiB），返回标准 Muse 批次，经 statusPath/receivePath/resultUrl 校验取图。' },
  video: { status: VIDEO_STATUS, preview: VIDEO_PREVIEW, inputs: VIDEO_INPUTS, jobs: VIDEO_JOBS, batches: VIDEO_BATCHES,
    partBytes: PART, maxPartCount: 16, maxJsonInputBytes: 3 * 1024 * 1024,
    usage: '素材走 POST /api/muse/video/inputs 的 Base64 JSON（原文件 ≤3 MiB）；成片走 GET result?part=N&count=M（1..=16）逐片下载并校验 X-Part-Sha256 与 X-Result-Sha256。' },
  health: { path: HEALTH_PATH, usage: '严格只读查询出图机在线状态、推理引擎、模型计数与模块能力。' },
  gallery: { list: '/api/muse/gallery', item: '/api/muse/gallery/{id}', file: '/api/muse/gallery/{id}/file',
    partBytes: PART, maxPartCount: 16,
    usage: '严格只读浏览作品册；经中转下载原文件使用 GET /api/muse/gallery/{id}/file?part=N&count=M（数字 ID 附 idType=number），校验 SHA-256。' },
  followup: '用同 X-Token 跟随每张图的 next：application/json 按 retryAfterSeconds 查批次 statusPath；image/png 下载 resultUrl（有 ranges 可并行）；next=null 查 status、deliveryStatus 与 error。',
  download: '支持 200 整图或按 next.ranges 并发 206 Range 下载，保存前校验 PNG 文件头、字节数与 SHA-256。receivePath 支持长轮询，202 或 pending=true 按 Retry-After 续查。',
  resultFlow: {
    poll: { method: 'GET', pathField: 'statusPath', contentType: 'application/json', intervalSeconds: POLL_SECONDS,
      stopOnStatus: stopped, stopOnDeliveryStatus: Object.keys(deliveryErrors) },
    download: { method: 'GET', pathField: 'items[].resultUrl', when: { resultAvailable: true },
      status: 200, contentType: 'image/png', pngSignatureHex: '89504e470d0a1a0a', lengthHeader: 'Content-Length',
      bytesHeader: 'X-Result-Bytes', sha256Header: 'X-Result-Sha256' },
    parallelDownload: { method: 'GET', pathField: 'items[].resultUrl', rangesField: 'items[].next.ranges',
      header: 'Range', status: 206, contentType: 'image/png', minBytes: PARALLEL_DOWNLOAD_MIN,
      concurrency: PARALLEL_DOWNLOAD_CONNECTIONS,
      verify: '核对各段 Content-Range、Content-Length 与 X-Result-Sha256，按偏移拼接后再验整图大小、PNG 头与 SHA-256。',
      retry: '超时只重取缺失区间；不支持并发时回退 200 整图校验下载。' },
    receive: { method: 'GET', pathField: 'items[].receivePath', waitSeconds: RECEIVE_WAIT_SECONDS,
      pending: { status: 202, contentType: 'application/json', body: { pending: true }, retryAfterHeader: 'Retry-After' },
      legacyPending: { status: 200, contentType: 'application/json', body: { pending: true } } },
  },
  retry: '空响应、超时、429 或 503 按 Retry-After 退避重查原路径；提交重试沿用原 requestKey 与请求体。',
}

export function nextImageRequest(item, statusPath) {
  if (stopped.includes(item.status) || Object.hasOwn(deliveryErrors, item.deliveryStatus)) return null
  if (item.resultAvailable && item.resultUrl) {
    const next = { method: 'GET', path: item.resultUrl, accept: 'image/png' }
    const size = item.resultBytes
    if (Number.isSafeInteger(size) && size >= PARALLEL_DOWNLOAD_MIN) {
      const step = Math.ceil(size / PARALLEL_DOWNLOAD_CONNECTIONS)
      next.ranges = []
      for (let start = 0; start < size; start += step) {
        next.ranges.push(`bytes=${start}-${Math.min(start + step, size) - 1}`)
      }
    }
    return next
  }
  return { method: 'GET', path: statusPath, accept: 'application/json', retryAfterSeconds: POLL_SECONDS }
}

export function authorized(value, secret) {
  if (typeof secret !== 'string' || secret.length < 32 || !value || value.length > 256) return false
  const digest = input => createHash('sha256').update(input).digest()
  return timingSafeEqual(digest(value), digest(secret))
}

export function unsupportedCapability(caps, path) {
  if (voicePath(path) && !caps.voice) return voiceUnsupported()
  if (legacyModelReadPath(path) && !caps.modelRead) return modelReadUnsupported()
  if (interrogatePath(path) && !caps.interrogate) return outdated('MUSE_INTERROGATE_CONNECTOR_OUTDATED', '出图机连接器需要更新才能通过中转使用远程图像反推')
  if (path === UPSCALE_PATH && !caps.upscale) return outdated('MUSE_UPSCALE_CONNECTOR_OUTDATED', '出图机连接器需要更新才能通过中转使用独立图像放大')
  if (path === INPUTS_LOOKUP_PATH && !caps.upscale) return outdated('MUSE_INPUTS_CONNECTOR_OUTDATED', '出图机连接器需要更新才能通过中转查询可复用素材', 404)
  if (videoPath(path) && !caps.video) return outdated('MUSE_VIDEO_CONNECTOR_OUTDATED', '出图机连接器需要更新才能通过中转使用远程短视频生成')
  if (galleryPath(path) && !caps.gallery) return outdated('MUSE_GALLERY_CONNECTOR_OUTDATED', '出图机连接器需要更新才能通过中转访问作品册')
  if (path === HEALTH_PATH && !caps.health) return outdated('MUSE_HEALTH_CONNECTOR_OUTDATED', '出图机连接器需要更新才能通过中转查询健康状态')
  if (keyframePath(path) && !caps.keyframe) return outdated('MUSE_KEYFRAME_CONNECTOR_OUTDATED', '出图机连接器需要更新才能通过中转访问关键帧模型接口')
  if (mangaPath(path) && !caps.manga) return outdated('MUSE_MANGA_CONNECTOR_OUTDATED', '出图机连接器需要更新才能通过中转访问漫画网点接口')
  return null
}

export function applyInboxUsage(path, operations) {
  if (path === DESKTOP_INBOX) operations.usage = publicGuide.desktopChat.usage
  else operations.inboxUsage = publicGuide.qq.usage
}

export function applyGuideOverlay(data) {
  data.relay = publicGuide
  if (data.operations?.desktopChat) data.operations.desktopChat.usage = publicGuide.desktopChat.usage
  if (data.operations?.qqChat) data.operations.qqChat.usage = publicGuide.qq.usage
  data.download = publicGuide.download
  data.followup = publicGuide.followup
  delete data.operations?.uploadedInputs
}

export function nextCommandResponse(work) {
  const response = json(work)
  const workPath = work.path.split('?')[0]
  if (work.method === 'POST' && qqMessagePath(workPath)) response.headers.set('X-Muse-QQ-Media', '1')
  else if (work.method === 'POST' && (workPath === INTERROGATE_RUN || workPath === UPSCALE_PATH)) response.headers.set('X-Muse-Body-Class', 'image-json')
  else if (work.method === 'POST' && workPath === VIDEO_INPUTS) response.headers.set('X-Muse-Body-Class', 'video-input')
  else if (work.method === 'POST' && workPath === VIDEO_BATCHES) response.headers.set('X-Muse-Body-Class', 'video-batch')
  return response
}

const MEDIA_PART_HEADERS = [
  ['content-type', 'Content-Type'],
  ['x-upstream-content-length', 'Content-Length'],
  ['x-result-mime', 'X-Result-Mime'],
  ['x-result-offset', 'X-Result-Offset'],
  ['x-result-bytes', 'X-Result-Bytes'],
  ['x-result-sha256', 'X-Result-Sha256'],
  ['x-part-sha256', 'X-Part-Sha256'],
  ['x-part-bytes', 'X-Part-Bytes'],
  ['etag', 'ETag'],
  ['accept-ranges', 'Accept-Ranges'],
  ['retry-after', 'Retry-After'],
]

export function pickMediaPartHeaders(requestHeaders, method, byteLength) {
  const picked = {}
  for (const [src, dst] of MEDIA_PART_HEADERS) {
    const val = requestHeaders.get(src)
    if (val !== null) picked[dst] = val
  }
  if (method !== 'HEAD') {
    picked['Content-Type'] ||= 'application/octet-stream'
    picked['Content-Length'] = String(byteLength)
  }
  return picked
}
