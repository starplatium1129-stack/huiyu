import { createHash, timingSafeEqual } from 'node:crypto'
import { DurableObject } from 'cloudflare:workers'
import { PART, Results, TTL, problem, resultRoute } from './results.mjs'

const ID = '[A-Za-z0-9_-]{1,160}'
const CONTROL_BODY = 64 * 1024
const QQ_MESSAGE_BODY = 4 * 1024 * 1024 + CONTROL_BODY
const qqMessagePath = path => path === '/api/muse/qq/reply' || path === '/api/muse/qq/send'
const chatPath = path => path.startsWith('/api/muse/qq/') || path.startsWith('/api/muse/desktop/')
const VOICE_SYNTHESIZE = '/api/muse/voice/synthesize'
const VOICE_STATUS = '/api/muse/voice/status'
const voicePath = path => path === VOICE_STATUS || path === VOICE_SYNTHESIZE
const privateRpcPath = path => chatPath(path) || voicePath(path)
const DESKTOP_INBOX = '/api/muse/desktop/inbox'
const inboxPath = path => path === DESKTOP_INBOX || path === '/api/muse/qq/inbox'
const LEGACY_INBOX_INTERVAL_MS = 3000
const MAX_INBOX_WAIT_SECONDS = 30
const AGENT_IDLE_POLL_MS = 15_000
const AGENT_ONLINE_MS = 45_000
const AGENT_RECONNECT_GRACE_MS = 6_000
const batchRoute = new RegExp('^/api/muse/batches/(' + ID + ')(?:/(' + ID + '))?$')
const receiveRoute = new RegExp('^/api/muse/batches/(' + ID + ')/original/([1-9][0-9]?)$')
const uploadRoute = /^\/_agent\/parts\/(anima|moss|qwen|creative)\/([a-f0-9]{32})\/(\d{1,3})$/
const directRoute = new RegExp('^/api/(?:anima|moss|qwen|creative)/(?:jobs|requests)/' + ID + '$')
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
const json = (value, status = 200, retryAfter) => Response.json(value, {
  status, headers: retryAfter ? { ...headers, 'Retry-After': String(retryAfter) } : headers,
})
const unavailable = () => problem(503, 'MUSE_LAPTOP_UNAVAILABLE', '出图机暂未回应。请重查原路径，提交重试请复用原 requestKey', { 'Retry-After': '3' })
const inboxUnavailable = () => problem(503, 'MUSE_CONNECTOR_INBOX_NO_REPLY', '出图机连接器近期在线，但这次取信未收到回执。请续接原收信地址', { 'Retry-After': '3' })
const voiceBusy = () => ({ status: 429, data: { ok: false, code: 'MUSE_VOICE_BUSY', message: '语音合成繁忙，请稍后重试' }, retry: '3' })
const voiceUnsupported = () => ({ status: 503, data: { ok: false, code: 'MUSE_VOICE_CONNECTOR_OUTDATED', message: '主力机连接器需要更新才能使用远程语音' } })
const POLL_SECONDS = 2
const RECEIVE_WAIT_SECONDS = 20
const PARALLEL_DOWNLOAD_MIN = 1024 * 1024
const PARALLEL_DOWNLOAD_CONNECTIONS = 4
const stopped = ['failed', 'cancelled', 'interrupted']
const deliveryErrors = { expired: 410, storageFull: 507, integrityError: 502, invalidReceipt: 502 }
const publicGuide = {
  name: '绘遇远程出图（Muse 等 AI 助手）', protocol: 'huiyu-muse', authHeader: 'X-Token',
  guidePath: '/api/muse/guide', drawPath: '/api/muse/jobs', partBytes: PART,
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

function nextImageRequest(item, statusPath) {
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

function authorized(value, secret) {
  if (typeof secret !== 'string' || secret.length < 32 || !value || value.length > 256) return false
  const digest = input => createHash('sha256').update(input).digest()
  return timingSafeEqual(digest(value), digest(secret))
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/' && request.method === 'GET') return json(publicGuide)
    const agent = url.pathname.startsWith('/_agent/')
    const supplied = agent ? /^Bearer (\S+)$/.exec(request.headers.get('Authorization'))?.[1] : request.headers.get('X-Token')
    if (!authorized(supplied, agent ? env.AGENT_TOKEN : env.MUSE_TOKEN)) return problem(401, 'UNAUTHORIZED', '请检查连接密钥')
    return env.RELAY.getByName('laptop').fetch(request)
  },
}

async function readBody(request, limit) {
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
const decode = bytes => JSON.parse(new TextDecoder().decode(bytes))

function control(method, path) {
  if (path === VOICE_STATUS) return method === 'GET'
  if (path === VOICE_SYNTHESIZE) return method === 'POST'
  if (path === '/api/muse/desktop/inbox') return method === 'GET'
  if (path === '/api/muse/desktop/reply') return method === 'POST'
  if (path === '/api/muse/qq/inbox' || path === '/api/muse/qq/targets') return method === 'GET'
  if (/^\/api\/muse\/qq\/context\/[0-9a-f]{64}$/.test(path)) return method === 'GET'
  if (qqMessagePath(path) || path === '/api/muse/qq/search') return method === 'POST'
  if (method === 'POST') return path === '/api/muse/jobs' || path === '/api/muse/batches'
  if (batchRoute.test(path) || directRoute.test(path)) return method === 'GET' || method === 'DELETE'
  return method === 'GET' && (/^\/api\/muse\/(catalog|queue|jobs|guide)$/.test(path)
    || /^\/api\/muse\/catalog\/(character|scene|blueprint|outfit)(\/[A-Za-z0-9_-]{1,180})+$/.test(path))
}

export class MuseRelay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.results = new Results(ctx.storage, () => this.wake?.())
    this.sql.exec(`CREATE TABLE IF NOT EXISTS batches (
      key TEXT PRIMARY KEY, snapshot TEXT, due INTEGER, expires INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS batch_queue ON batches(due);`)
    this.calls = new Map()
    this.largeQqMessages = 0
    this.voiceInFlight = 0
    this.inboxWaiters = new Map()
    this.background = new Map()
    this.reads = new Map()
    this.lastAgent = 0
    this.voiceCapable = false
    this.reconnectWaiters = new Set()
    this.receivers = new Set()
  }
  async alarm() {
    const now = Date.now()
    this.sql.exec('DELETE FROM batches WHERE expires<=?', now)
    this.sql.exec('DELETE FROM files WHERE expires<=?', now)
    await this.scheduleCleanup()
  }
  async scheduleCleanup() {
    const { expires } = this.sql.exec('SELECT min(expires) AS expires FROM (SELECT min(expires) AS expires FROM batches UNION ALL SELECT min(expires) FROM files)').one()
    if (expires !== null) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, expires))
  }
  watch(key) {
    this.sql.exec('INSERT OR IGNORE INTO batches(key,due,expires) VALUES(?,?,?)', key, Date.now() + 5000, Date.now() + TTL)
  }
  save(batch) {
    if (!batchRoute.test(batch?.statusPath) || !Array.isArray(batch.items) || !batch.items.length) return
    const key = batch.batchKey
    if (batch.statusPath !== '/api/muse/batches/' + key) return
    const active = batch.items.some(item => item.status !== 'succeeded' && !stopped.includes(item.status))
    this.watch(key)
    const now = Date.now()
    this.sql.exec('UPDATE batches SET snapshot=?, due=? WHERE key=?', JSON.stringify({ ...batch, relayUpdatedAt: now }), active ? now + 4000 : null, key)
    for (const item of batch.items) this.results.describe({ ...item, metadata: undefined }, true)
    this.notifyReceivers()
  }
  present(data, collect = false) {
    for (const job of [data.job, data.item, ...(Array.isArray(data.items) ? data.items : [])]) {
      if (job) this.results.describe(job, collect)
    }
    if (batchRoute.test(data.statusPath) && data.statusPath === '/api/muse/batches/' + data.batchKey && Array.isArray(data.items)) {
      data.guidePath = publicGuide.guidePath
      data.items.forEach((item, index) => {
        item.receivePath = data.statusPath + '/original/' + (index + 1)
        item.next = nextImageRequest(item, data.statusPath)
      })
      if (data.items.length === 1) data.receivePath = data.items[0].receivePath
    } else if (data.item && batchRoute.test(data.batchStatusPath)) {
      data.item.next = nextImageRequest(data.item, data.batchStatusPath)
    }
    return data
  }
  async fetch(request) {
    const url = new URL(request.url)
    try {
      if (url.pathname === '/_agent/next' && request.method === 'POST') {
        if (!request.signal.aborted) this.voiceCapable = request.headers.get('X-Muse-Voice') === '1'
        return await this.next(request.signal, request.headers.get('X-Muse-Part-Count') === '16' ? 16 : 1, request.headers.get('X-Muse-Parallel') === '1')
      }
      const upload = uploadRoute.exec(url.pathname)
      if (upload && request.method === 'POST') {
        this.agentSeen()
        const path = '/api/' + upload[1] + '/jobs/' + upload[2] + '/result'
        const response = this.results.upload(path, Number(upload[3]), await readBody(request, 4 * PART), request.headers)
        this.notifyReceivers()
        return response
      }
      if (url.pathname === '/_agent/finished' && request.method === 'POST') {
        this.agentSeen()
        this.sql.exec('UPDATE batches SET due=? WHERE due IS NOT NULL AND due>?', Date.now(), Date.now())
        this.wake?.()
        return new Response(null, { status: 204 })
      }
      if (url.pathname.startsWith('/_agent/reply/') && request.method === 'POST') return await this.reply(request, url.pathname.slice(14))
      if (url.pathname === '/api/muse/connection' && request.method === 'GET') return json({ ok: true,
        laptopOnline: this.agentOnline(), lastSeenAt: this.lastAgent || null, partBytes: PART,
        idlePollSeconds: AGENT_IDLE_POLL_MS / 1000, reconnectGraceSeconds: AGENT_RECONNECT_GRACE_MS / 1000 })
      if (resultRoute.test(url.pathname) && ['GET','HEAD'].includes(request.method)) return this.results.serve(request, url)
      const receive = receiveRoute.exec(url.pathname)
      if (receive && request.method === 'GET') return await this.receive(request, receive[1], Number(receive[2]))
      const inbox = request.method === 'GET' && inboxPath(url.pathname)
      if (url.href.length > 4096 || !control(request.method, url.pathname) || (privateRpcPath(url.pathname) && url.search && !inbox)) {
        return problem(404, 'MUSE_ROUTE_NOT_FOUND', '找不到这个 Muse 接口')
      }
      if (inbox && url.search) {
        const value = url.searchParams.get('wait')
        if (url.searchParams.size !== 1 || value === null || !/^\d+$/.test(value) || Number(value) > 0xffffffff) {
          return problem(400, 'INVALID_WAIT', 'wait 须为一个非负整数，最多等待 30 秒')
        }
      }
      const length = request.headers.get('Content-Length')
      if (qqMessagePath(url.pathname) && (length === null || Number(length) > CONTROL_BODY)) {
        if (Number(length) > QQ_MESSAGE_BODY) throw new RangeError()
        // The command stays in memory until the laptop replies. Bound simultaneous attachments,
        // including chunked requests, before reading their bodies.
        if (this.largeQqMessages >= 2) return problem(429, 'MUSE_QQ_BUSY', '附件正在传送，请稍后用相同编号重试', { 'Retry-After': '2' })
        this.largeQqMessages++
        try { return await this.client(request, url, QQ_MESSAGE_BODY) }
        finally { this.largeQqMessages-- }
      }
      return await this.client(request, url, url.pathname === '/api/muse/batches' ? 256 * 1024 : CONTROL_BODY)
    } catch (error) {
      if (error instanceof RangeError) return problem(413, 'MUSE_BODY_TOO_LARGE', '数据超过中转单次传输上限')
      if (error instanceof SyntaxError) return problem(400, 'INVALID_JSON', '请求不是完整的 JSON')
      console.error('Muse relay operation failed', error.name)
      return problem(503, 'MUSE_RELAY_UNAVAILABLE', '中转暂时无法完成请求，请稍后重试', { 'Retry-After': '3' })
    }
  }
  async client(request, url, bodyLimit) {
    const path = url.pathname
    const target = path + url.search
    const method = request.method
    const privateRpc = privateRpcPath(path)
    const batch = batchRoute.exec(path)
    if (method === 'GET' && directRoute.test(path) && path.includes('/jobs/')) {
      const job = this.results.job(path)
      if (job) return json({ ok: true, job })
    }
    if (method === 'GET' && batch) {
      const row = this.sql.exec('SELECT snapshot FROM batches WHERE key=? AND expires>?', batch[1], Date.now()).toArray()[0]
      if (row?.snapshot) {
        const data = this.present(JSON.parse(row.snapshot), true)
        data.laptopOnline = this.agentOnline()
        if (!batch[2]) return json(data)
        const item = data.items.find(item => item.requestKey === batch[2])
        if (item) return json({ ok: true, item, batchKey: batch[1], batchStatusPath: data.statusPath,
          relayUpdatedAt: data.relayUpdatedAt, laptopOnline: data.laptopOnline })
      }
    }
    const cached = !privateRpc && method === 'GET' && this.reads.get(target)
    if (cached && cached.until > Date.now()) return json(this.present(JSON.parse(cached.text)), cached.status, cached.retry)
    if (!this.agentOnline()) {
      if (voicePath(path)) return unavailable()
      if (this.reconnectWaiters.size >= 32 || request.signal.aborted) return unavailable()
      await this.waitForChange(request.signal, AGENT_RECONNECT_GRACE_MS, this.reconnectWaiters)
      if (!this.agentOnline() || request.signal.aborted) return unavailable()
    }
    let body
    if (method === 'POST') {
      const bytes = await readBody(request, bodyLimit)
      body = decode(bytes)
      if (qqMessagePath(path) && bytes.byteLength > CONTROL_BODY && typeof body?.image?.data !== 'string' && typeof body?.audio?.data !== 'string') {
        return problem(413, 'MUSE_BODY_TOO_LARGE', '含图片或语音的消息可以超过 64 KiB')
      }
      if (typeof body?.requestKey !== 'string' || !new RegExp('^' + ID + '$').test(body.requestKey)) {
        return problem(400, 'INVALID_REQUEST', '请提供稳定的 requestKey，推荐使用 UUID')
      }
    }
    const command = { method, path: target, body }
    if (method === 'GET' && inboxPath(path)) {
      const prefer = /(?:^|,)\s*wait=(\d{1,9})\s*(?:,|$)/i.exec(request.headers.get('Prefer') ?? '')
      command.path = path // Older connectors accept only the bare, allowlisted RPC path.
      command.inboxWaitSeconds = Math.min(Number(url.searchParams.get('wait') ?? prefer?.[1] ?? 0), MAX_INBOX_WAIT_SECONDS)
      if (command.inboxWaitSeconds > 0) return this.waitInbox(request, command)
    }
    const call = await this.rpc(command)
    if (!call) return method === 'GET' && inboxPath(path) && this.agentOnline() ? inboxUnavailable() : unavailable()
    const { status, data, retry } = call
    if (privateRpc) {
      if (status === 200 && inboxPath(path) && data.operations) {
        if (path === DESKTOP_INBOX) data.operations.usage = publicGuide.desktopChat.usage
        else data.operations.inboxUsage = publicGuide.qq.usage
      }
      return json(data, status, retry)
    }
    if (status >= 400) return json(data, status, retry)
    if (path === '/api/muse/guide') {
      data.relay = publicGuide
      if (data.operations?.desktopChat) data.operations.desktopChat.usage = publicGuide.desktopChat.usage
      if (data.operations?.qqChat) data.operations.qqChat.usage = publicGuide.qq.usage
      data.download = publicGuide.download
      data.followup = publicGuide.followup
      delete data.operations?.uploadedInputs
    }
    if (method === 'GET') {
      if (this.reads.size >= 16) this.reads.delete(this.reads.keys().next().value)
      const text = JSON.stringify(data)
      if (text.length <= 256 * 1024) this.reads.set(target, { until: Date.now() + 2000, text, status, retry })
    } else this.reads.clear()
    const collect = Boolean(batch) || directRoute.test(path) || method === 'POST'
    const response = this.present(data, collect)
    if (collect) await this.scheduleCleanup()
    return json(response, status, retry)
  }
  async waitInbox(request, command) {
    const readers = this.inboxWaiters.get(command.path) ?? 0
    if (readers >= 4) return problem(429, 'MUSE_INBOX_BUSY', '收信连接已满，请稍后续接', { 'Retry-After': '2' })
    this.inboxWaiters.set(command.path, readers + 1)
    const until = Date.now() + command.inboxWaitSeconds * 1000
    let seconds = command.inboxWaitSeconds
    try {
      for (;;) {
        const call = await this.rpc({ ...command, inboxWaitSeconds: seconds }, (seconds + 10) * 1000)
        if (!call) return this.agentOnline() ? inboxUnavailable() : unavailable()
        const { data, status, retry } = call
        if (status !== 200 || !data.ok || !Array.isArray(data.items) || !data.operations) return json(data, status, retry)
        const snapshot = command.path === DESKTOP_INBOX && data.operations.inboxWaitSeconds === undefined
        const remaining = until - Date.now()
        if (data.items.length || remaining <= 0) {
          const operations = { ...data.operations, inboxWaitSeconds: command.inboxWaitSeconds }
          if (command.path === DESKTOP_INBOX) operations.usage = publicGuide.desktopChat.usage
          else operations.inboxUsage = publicGuide.qq.usage
          if (snapshot) Object.assign(operations, { inboxWaitMode: 'relay-poll', inboxPollSeconds: LEGACY_INBOX_INTERVAL_MS / 1000 })
          return json({ ...data, operations })
        }
        if (!snapshot && data.operations.inboxWaitSeconds === 0 && seconds > 0) {
          return problem(429, 'MUSE_INBOX_BUSY', '网关收信连接已满，请稍后续接', { 'Retry-After': '2' })
        }
        // A snapshot-only desktop needs a short pause. Event-capable gateways
        // can immediately hold the rest of the wait after a shorter native window.
        if (snapshot) await new Promise(resolve => setTimeout(resolve, Math.min(remaining, LEGACY_INBOX_INTERVAL_MS)))
        if (request.signal.aborted) return new Response(null, { status: 204, headers })
        seconds = snapshot ? 0 : Math.max(0, Math.ceil((until - Date.now()) / 1000))
      }
    } finally {
      this.inboxWaiters.set(command.path, this.inboxWaiters.get(command.path) - 1)
    }
  }
  rpc(command, timeout = 30000) {
    if (voicePath(command.path) && !this.voiceCapable) return voiceUnsupported()
    if (command.method === 'GET') {
      for (const call of this.calls.values()) {
        if (call.command.method === 'GET' && call.command.path === command.path
          && call.command.inboxWaitSeconds === command.inboxWaitSeconds) {
          return call.promise.then(value => structuredClone(value))
        }
      }
    }
    if (this.calls.size >= 32) {
      if (voicePath(command.path)) return voiceBusy()
      if (command.method !== 'GET' || !inboxPath(command.path)) return null
      return { status: 429, data: { ok: false, code: 'MUSE_RELAY_BUSY', message: '中转在途请求较多，请续接原收信地址' }, retry: '2' }
    }
    const synthesize = command.path === VOICE_SYNTHESIZE
    if (synthesize && this.voiceInFlight >= 2) return voiceBusy()
    const ticket = crypto.randomUUID()
    let finish
    const promise = new Promise(resolve => { finish = resolve })
    if (qqMessagePath(command.path)) timeout = 105000
    if (command.path === '/api/muse/qq/search') timeout = 45000
    if (synthesize) {
      timeout = 95000
      this.voiceInFlight++
    }
    const resolve = value => {
      if (!this.calls.delete(ticket)) return
      clearTimeout(timer)
      clearTimeout(pickupTimer)
      if (synthesize) this.voiceInFlight--
      finish(value)
    }
    const timer = setTimeout(() => resolve(null), timeout)
    // A laptop that just disconnected still looks online for 45 seconds. A
    // voice caller needs a quick fallback unless a connector took the command.
    const pickupTimer = voicePath(command.path) ? setTimeout(() => {
      if (!this.calls.get(ticket)?.sent) resolve(null)
    }, AGENT_RECONNECT_GRACE_MS) : undefined
    this.calls.set(ticket, { command, promise, resolve })
    this.wake?.()
    return promise
  }
  notifyReceivers() {
    for (const wake of this.receivers) wake()
  }
  agentOnline() {
    return this.lastAgent > 0 && Date.now() - this.lastAgent < AGENT_ONLINE_MS
  }
  agentSeen() {
    this.lastAgent = Date.now()
    for (const wake of this.reconnectWaiters) wake()
  }
  waitForChange(signal, ms, waiters = this.receivers) {
    if (signal.aborted) return
    return new Promise(resolve => {
      const wake = () => { clearTimeout(timer); waiters.delete(wake); signal.removeEventListener('abort', wake); resolve() }
      const timer = setTimeout(wake, ms)
      waiters.add(wake)
      signal.addEventListener('abort', wake, { once: true })
    })
  }
  async receive(request, key, number) {
    const until = Date.now() + RECEIVE_WAIT_SECONDS * 1000
    const statusPath = '/api/muse/batches/' + key
    const url = new URL(request.url)
    for (;;) {
      const now = Date.now()
      const row = this.sql.exec('SELECT snapshot FROM batches WHERE key=? AND expires>?', key, now).toArray()[0]
      if (!row) return problem(404, 'MUSE_BATCH_NOT_FOUND', '请沿提交回执的 statusPath 恢复批次')
      if (row.snapshot) {
        const batch = JSON.parse(row.snapshot)
        const item = batch.items[number - 1]
        if (!item) return problem(404, 'MUSE_ITEM_NOT_FOUND', '此批次没有这张图片')
        if (stopped.includes(item.status)) return problem(409, item.code || 'MUSE_JOB_STOPPED', item.error || '出图任务已结束')
        this.results.describe(item, true)
        if (item.deliveryStatus === 'ready') {
          url.pathname = item.resultUrl
          return this.results.serve(request, url)
        }
        if (Object.hasOwn(deliveryErrors, item.deliveryStatus)) {
          return problem(deliveryErrors[item.deliveryStatus], 'MUSE_RESULT_UNAVAILABLE', '原图暂不可取，原因是 ' + item.deliveryStatus)
        }
      }
      if (request.signal.aborted || now >= until) {
        return json({ pending: true, resultAvailable: false, statusPath,
          receivePath: url.pathname + url.search, retryAfterSeconds: POLL_SECONDS }, 202, POLL_SECONDS)
      }
      if (this.receivers.size >= 64) return problem(429, 'MUSE_RECEIVERS_BUSY', '正在收图的连接较多，请稍后重连', { 'Retry-After': '1' })
      await this.waitForChange(request.signal, until - now)
    }
  }
  dispatch(maxParts, parallel) {
    const now = Date.now()
    for (const [key, value] of this.background) if (value.expiry <= now) this.background.delete(key)
    for (const [ticket, call] of this.calls) {
      if (call.sent) continue
      if (voicePath(call.command.path) && !this.voiceCapable) {
        call.resolve(voiceUnsupported())
        continue
      }
      call.sent = true
      if (call.command.method === 'POST' && ['/api/muse/jobs', '/api/muse/batches'].includes(call.command.path.split('?')[0])) this.watch(call.command.body.requestKey)
      return { ticket, ...call.command }
    }
    const batch = this.sql.exec('SELECT key FROM batches WHERE due<=? AND expires>? ORDER BY due LIMIT 1', now, now).toArray()[0]
    let work
    if (batch) {
      this.sql.exec('UPDATE batches SET due=? WHERE key=?', now + 40000, batch.key)
      work = { method: 'GET', path: '/api/muse/batches/' + batch.key, batch: batch.key }
    } else work = this.results.next(maxParts)
    if (!work) return
    const ticket = crypto.randomUUID()
    work.parallel = Boolean(work.file && work.count > 1 && parallel)
    this.background.set(ticket, { ...work, expiry: now + 40000 })
    return { ticket, method: work.method, path: work.path, parallel: work.parallel }
  }
  async next(signal, maxParts, parallel) {
    if (signal.aborted) return new Response(null, { status: 204 })
    this.agentSeen()
    // A disconnected or superseded reader must never consume a queued command.
    const poll = Symbol()
    this.currentPoll = poll
    this.wake?.()
    let work = this.dispatch(maxParts, parallel)
    if (!work) {
      // Keep just one idle poll. A new command wakes it immediately.
      const due = this.sql.exec("SELECT min(due) AS due FROM (SELECT min(due) AS due FROM batches WHERE due IS NOT NULL AND expires>? UNION ALL SELECT min(due) FROM files WHERE state='transferring' AND expires>?)", Date.now(), Date.now()).one().due
      await new Promise(resolve => {
        const wake = () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', wake)
          if (this.wake === wake) this.wake = null
          resolve()
        }
        const timer = setTimeout(wake, due === null ? AGENT_IDLE_POLL_MS : Math.max(25, Math.min(AGENT_IDLE_POLL_MS, due - Date.now())))
        this.wake = wake
        signal.addEventListener('abort', wake, { once: true })
      })
      if (signal.aborted || this.currentPoll !== poll) return new Response(null, { status: 204 })
      work = this.dispatch(maxParts, parallel)
    }
    if (!work) return new Response(null, { status: 204 })
    const response = json(work)
    if (work.method === 'POST' && qqMessagePath(work.path)) response.headers.set('X-Muse-QQ-Media', '1')
    return response
  }
  async reply(request, ticket) {
    this.agentSeen()
    const call = this.calls.get(ticket)
    const work = this.background.get(ticket)
    if (!call && !work) return new Response(null, { status: 204 })
    const privateRpc = call && privateRpcPath(call.command.path)
    const status = Number(request.headers.get('X-Upstream-Status'))
    if (!Number.isInteger(status) || status < 200 || status > 599) return problem(400, 'INVALID_STATUS', '出图机状态码无效')
    const bytes = await readBody(request, work?.file ? PART * work.count : 2 * 1024 * 1024)
    if (work?.file) {
      if (work.parallel && status === 204) {
        this.sql.exec("UPDATE files SET due=?, attempts=0 WHERE path=? AND state='transferring' AND part>=?", Date.now(), work.file.path, work.file.part + work.count)
      } else if (work.parallel && status >= 500) {
        this.sql.exec("UPDATE files SET due=? WHERE path=? AND state='transferring' AND part<?", Date.now() + 1000, work.file.path, work.file.part + work.count)
      } else this.results.accept(work, status, request.headers, bytes)
      this.notifyReceivers()
    }
    else {
      let data
      try { data = decode(bytes) } catch { data = null }
      if (!data || typeof data !== 'object') {
        if (privateRpc && status >= 400) {
          // Axum extractor rejections can be plain text. Keep the status without reflecting
          // a private message or its base64 attachment in the error body.
          const path = call.command.path
          const code = voicePath(path) ? 'MUSE_VOICE_REQUEST_REJECTED'
            : path.startsWith('/api/muse/qq/') ? 'MUSE_QQ_REQUEST_REJECTED' : 'MUSE_DESKTOP_REQUEST_REJECTED'
          call.resolve({ status, data: { ok: false, code, message: '绘遇未接受此请求，请核对请求格式与大小' }, retry: request.headers.get('Retry-After') })
        } else if (call) call.resolve(null)
      } else {
        if (status < 300 && !privateRpc) this.save(data)
        if (work?.batch && status >= 400) {
          if (status === 404) this.sql.exec('DELETE FROM batches WHERE key=? AND snapshot IS NULL', work.batch)
          this.sql.exec('UPDATE batches SET due=? WHERE key=?', Date.now() + 15000, work.batch)
        }
        call?.resolve({ status, data, retry: request.headers.get('Retry-After') })
      }
    }
    this.calls.delete(ticket)
    this.background.delete(ticket)
    if (!work?.file && !privateRpc) await this.scheduleCleanup()
    return new Response(null, { status: 204 })
  }
}
