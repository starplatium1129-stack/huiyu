import { DurableObject } from 'cloudflare:workers'
import { PART, Results, TTL, problem, resultRoute } from './results.mjs'
import {
  AGENT_IDLE_POLL_MS, AGENT_ONLINE_MS, AGENT_RECONNECT_GRACE_MS, CONTROL_BODY,
  DESKTOP_INBOX, INPUTS_LOOKUP_PATH, INTERROGATE_RUN, LEGACY_INBOX_INTERVAL_MS,
  MAX_INBOX_WAIT_SECONDS, QQ_MESSAGE_BODY, UPSCALE_PATH, VOICE_SYNTHESIZE,
  batchRoute, bodyLimitFor, control, decode, defaultCapabilities, directRoute,
  inboxPath, largeBodyLimitFor, mediaPartPath, noCacheRpcPath, parseAgentCapabilities,
  qqMessagePath, readBody, receiveRoute, rejectedRequestCode, rpcTimeout,
  uploadRoute, validatePostBody, validateRouteQuery, voicePath,
} from './routes.mjs'
import {
  POLL_SECONDS, RECEIVE_WAIT_SECONDS, applyGuideOverlay, applyInboxUsage,
  authorized, deliveryErrors, headers, inboxUnavailable, interrogateBusy, json,
  mediaPartBusy, nextCommandResponse, nextImageRequest, pickMediaPartHeaders,
  publicGuide, stopped, unavailable, unsupportedCapability, voiceBusy,
} from './responses.mjs'

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
    this.largePayloads = 0
    this.voiceInFlight = 0
    this.interrogateInFlight = 0
    this.mediaPartsInFlight = 0
    this.inboxWaiters = new Map()
    this.background = new Map()
    this.reads = new Map()
    this.lastAgent = 0
    this.capabilities = defaultCapabilities()
    this.reconnectWaiters = new Set()
    this.receivers = new Set()
  }
  unsupportedCapability(path) {
    return unsupportedCapability(this.capabilities, path)
  }
  async alarm() {
    const now = Date.now()
    this.sql.exec('DELETE FROM batches WHERE expires<=?', now)
    this.results.cleanup(now)
    await this.scheduleCleanup()
  }
  async scheduleCleanup() {
    const { expires } = this.sql.exec(`SELECT min(expires) AS expires FROM (
      SELECT min(expires) AS expires FROM batches UNION ALL SELECT min(expires) FROM files
      UNION ALL SELECT min(expires) FROM discarded_results)`).one()
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
    const jobs = [data.job, data.item, ...(Array.isArray(data.items) ? data.items : [])].filter(Boolean)
    for (const job of jobs) this.results.describe(job, collect)
    // A later item in this response can evict a result found ready earlier.
    if (collect && jobs.length > 1) {
      for (const job of jobs) if (job.resultAvailable) this.results.describe(job, false)
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
        if (!request.signal.aborted) {
          this.capabilities = parseAgentCapabilities(request.headers)
        }
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
        idlePollSeconds: AGENT_IDLE_POLL_MS / 1000, reconnectGraceSeconds: AGENT_RECONNECT_GRACE_MS / 1000,
        storage: this.results.stats(), capabilities: { ...this.capabilities } })
      if (resultRoute.test(url.pathname) && ['GET','HEAD'].includes(request.method)) return this.results.serve(request, url)
      const receive = receiveRoute.exec(url.pathname)
      if (receive && request.method === 'GET') return await this.receive(request, receive[1], Number(receive[2]))
      if (url.href.length > 4096 || !control(request.method, url.pathname)) {
        return problem(404, 'MUSE_ROUTE_NOT_FOUND', '找不到这个 Muse 接口')
      }
      const queryError = validateRouteQuery(request.method, url)
      if (queryError) return queryError
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
      const largeBodyLimit = largeBodyLimitFor(url.pathname)
      if (largeBodyLimit !== null && request.method === 'POST' && (length === null || Number(length) > CONTROL_BODY)) {
        if (Number(length) > largeBodyLimit) throw new RangeError()
        if (this.largePayloads >= 2) return problem(429, 'MUSE_RELAY_BUSY', '大体积请求正在传送，请稍后重试', { 'Retry-After': '2' })
        this.largePayloads++
        try { return await this.client(request, url, largeBodyLimit) }
        finally { this.largePayloads-- }
      }
      return await this.client(request, url, bodyLimitFor(url.pathname, largeBodyLimit))
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
    const noCache = noCacheRpcPath(path)
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
    const cached = !noCache && method === 'GET' && this.reads.get(target)
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
      const parsed = validatePostBody(method, path, bytes)
      if (parsed.error) return parsed.error
      body = parsed.body
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
    if (call.binary) {
      const outHeaders = {
        ...call.headers,
        'Cache-Control': 'private, no-store, no-transform',
        'X-Content-Type-Options': 'nosniff',
      }
      return new Response(method === 'HEAD' ? null : call.bytes, { status: call.status, headers: outHeaders })
    }
    const { status, data, retry } = call
    if (noCache) {
      if (status === 200 && inboxPath(path) && data.operations) applyInboxUsage(path, data.operations)
      return json(data, status, retry)
    }
    if (status >= 400) return json(data, status, retry)
    if (path === '/api/muse/guide') applyGuideOverlay(data)
    if (method === 'GET') {
      if (this.reads.size >= 16) this.reads.delete(this.reads.keys().next().value)
      const text = JSON.stringify(data)
      if (text.length <= 256 * 1024) this.reads.set(target, { until: Date.now() + 2000, text, status, retry })
    } else this.reads.clear()
    const collect = Boolean(batch) || directRoute.test(path) || (method === 'POST' && path !== INPUTS_LOOKUP_PATH)
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
          applyInboxUsage(command.path, operations)
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
    const barePath = command.path.split('?')[0]
    const unsupported = this.unsupportedCapability(barePath)
    if (unsupported) return unsupported
    const mediaPart = mediaPartPath(barePath)
    if (command.method === 'GET' && !mediaPart) {
      for (const call of this.calls.values()) {
        if (call.command.method === 'GET' && call.command.path === command.path
          && call.command.inboxWaitSeconds === command.inboxWaitSeconds) {
          return call.promise.then(value => structuredClone(value))
        }
      }
    }
    if (this.calls.size >= 32) {
      if (voicePath(barePath)) return voiceBusy()
      if (barePath === INTERROGATE_RUN) return interrogateBusy()
      if (mediaPart) return mediaPartBusy()
      if (command.method !== 'GET' || !inboxPath(barePath)) return null
      return { status: 429, data: { ok: false, code: 'MUSE_RELAY_BUSY', message: '中转在途请求较多，请续接原收信地址' }, retry: '2' }
    }
    const synthesize = barePath === VOICE_SYNTHESIZE
    const interrogate = command.method === 'POST' && barePath === INTERROGATE_RUN
    if (synthesize && this.voiceInFlight >= 2) return voiceBusy()
    if (interrogate && this.interrogateInFlight >= 2) return interrogateBusy()
    if (mediaPart && this.mediaPartsInFlight >= 4) return mediaPartBusy()
    const ticket = crypto.randomUUID()
    let finish
    const promise = new Promise(resolve => { finish = resolve })
    timeout = rpcTimeout(barePath, timeout, { mediaPart, interrogate, synthesize })
    if (mediaPart) this.mediaPartsInFlight++
    if (interrogate) this.interrogateInFlight++
    if (synthesize) this.voiceInFlight++
    const resolve = value => {
      if (!this.calls.delete(ticket)) return
      clearTimeout(timer)
      clearTimeout(pickupTimer)
      if (synthesize) this.voiceInFlight--
      if (interrogate) this.interrogateInFlight--
      if (mediaPart) this.mediaPartsInFlight--
      finish(value)
    }
    const timer = setTimeout(() => resolve(null), timeout)
    // A laptop that just disconnected still looks online for 45 seconds. A
    // voice caller needs a quick fallback unless a connector took the command.
    const pickupTimer = voicePath(barePath) ? setTimeout(() => {
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
      const barePath = call.command.path.split('?')[0]
      const unsupported = this.unsupportedCapability(barePath)
      if (unsupported) {
        call.resolve(unsupported)
        continue
      }
      call.sent = true
      if (call.command.method === 'POST' && ['/api/muse/jobs', '/api/muse/batches', UPSCALE_PATH].includes(barePath)) {
        this.watch(call.command.body.requestKey)
      }
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
    return nextCommandResponse(work)
  }
  async reply(request, ticket) {
    this.agentSeen()
    const call = this.calls.get(ticket)
    const work = this.background.get(ticket)
    if (!call && !work) return new Response(null, { status: 204 })
    const callBarePath = call ? call.command.path.split('?')[0] : ''
    const noCache = Boolean(call && noCacheRpcPath(callBarePath))
    const mediaPart = Boolean(call && mediaPartPath(callBarePath))
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
    } else if (mediaPart && (call.command.method === 'HEAD' || status === 200)) {
      const picked = pickMediaPartHeaders(request.headers, call.command.method, bytes.byteLength)
      call.resolve({ binary: true, status, bytes: call.command.method === 'HEAD' ? new ArrayBuffer(0) : bytes, headers: picked })
    } else {
      let data
      try { data = decode(bytes) } catch { data = null }
      if (!data || typeof data !== 'object') {
        if ((noCache || callBarePath === UPSCALE_PATH) && status >= 400) {
          // Axum extractor rejections can be plain text. Keep the status without reflecting
          // a private message or its base64 attachment in the error body.
          const code = rejectedRequestCode(callBarePath)
          call.resolve({ status, data: { ok: false, code, message: '绘遇未接受此请求，请核对请求格式与大小' }, retry: request.headers.get('Retry-After') })
        } else if (call) call.resolve(null)
      } else {
        if (status < 300 && !noCache) this.save(data)
        if (work?.batch && status >= 400) {
          if (status === 404) this.sql.exec('DELETE FROM batches WHERE key=? AND snapshot IS NULL', work.batch)
          this.sql.exec('UPDATE batches SET due=? WHERE key=?', Date.now() + 15000, work.batch)
        }
        call?.resolve({ status, data, retry: request.headers.get('Retry-After') })
      }
    }
    this.calls.delete(ticket)
    this.background.delete(ticket)
    if (!work?.file && !noCache) await this.scheduleCleanup()
    return new Response(null, { status: 204 })
  }
}
