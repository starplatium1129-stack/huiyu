import { createHash, timingSafeEqual } from 'node:crypto'
import { DurableObject } from 'cloudflare:workers'
import { PART, Results, TTL, problem, resultRoute } from './results.mjs'

const ID = '[A-Za-z0-9_-]{1,160}'
const batchRoute = new RegExp('^/api/muse/batches/(' + ID + ')(?:/(' + ID + '))?$')
const receiveRoute = new RegExp('^/api/muse/batches/(' + ID + ')/original/([1-9][0-9]?)$')
const uploadRoute = /^\/_agent\/parts\/(anima|moss|qwen|creative)\/([a-f0-9]{32})\/(\d{1,3})$/
const directRoute = new RegExp('^/api/(?:anima|moss|qwen|creative)/(?:jobs|requests)/' + ID + '$')
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
const json = (value, status = 200) => Response.json(value, { status, headers })
const unavailable = () => problem(503, 'MUSE_LAPTOP_UNAVAILABLE', '出图机暂未回应。请重查原路径，提交重试请复用原 requestKey', { 'Retry-After': '3' })
const publicGuide = { name: '绘遇 Muse 私人中转', protocol: 'huiyu-muse', authHeader: 'X-Token',
  guidePath: '/api/muse/guide', drawPath: '/api/muse/jobs', partBytes: PART,
  download: '提交成功后立即自动 GET 每个 items[].receivePath（单图也有顶层 receivePath），使用同一 X-Token。200 image/png 即原图，按 Content-Length、X-Result-Bytes 和 X-Result-Sha256 核对后交付。202 表示仍在出图或传输，立即再次 GET 同一路径。连接中断可重连接收或用 Range 和 If-Range 续传，无需用户另行取图。',
  retry: '空响应、超时或 503 时稍后重查；重试提交复用同一个 requestKey 与请求体。' }

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
  if (method === 'POST') return path === '/api/muse/jobs' || path === '/api/muse/batches'
  if (batchRoute.test(path) || directRoute.test(path)) return method === 'GET' || method === 'DELETE'
  return method === 'GET' && (/^\/api\/muse\/(catalog|queue|jobs|guide)$/.test(path)
    || /^\/api\/muse\/catalog\/(scene|blueprint|outfit)(\/[A-Za-z0-9_-]{1,180})+$/.test(path))
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
    this.background = new Map()
    this.reads = new Map()
    this.lastAgent = 0
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
    const active = batch.items.some(item => !['succeeded','failed','cancelled'].includes(item.status))
    this.watch(key)
    const now = Date.now()
    this.sql.exec('UPDATE batches SET snapshot=?, due=? WHERE key=?', JSON.stringify({ ...batch, relayUpdatedAt: now }), active ? now + 4000 : null, key)
    for (const item of batch.items) this.results.describe({ ...item, metadata: undefined }, true)
    this.notifyReceivers()
  }
  present(data, collect = false) {
    if (batchRoute.test(data.statusPath) && data.statusPath === '/api/muse/batches/' + data.batchKey && Array.isArray(data.items)) {
      data.items.forEach((item, index) => { item.receivePath = data.statusPath + '/original/' + (index + 1) })
      if (data.items.length === 1) data.receivePath = data.items[0].receivePath
    }
    for (const job of [data.job, data.item, ...(Array.isArray(data.items) ? data.items : [])]) {
      if (job) this.results.describe(job, collect)
    }
    return data
  }
  async fetch(request) {
    const url = new URL(request.url)
    try {
      if (url.pathname === '/_agent/next' && request.method === 'POST') return await this.next(request.headers.get('X-Muse-Part-Count') === '16' ? 16 : 1, request.headers.get('X-Muse-Parallel') === '1')
      const upload = uploadRoute.exec(url.pathname)
      if (upload && request.method === 'POST') {
        const path = '/api/' + upload[1] + '/jobs/' + upload[2] + '/result'
        const response = this.results.upload(path, Number(upload[3]), await readBody(request, 4 * PART), request.headers)
        this.notifyReceivers()
        return response
      }
      if (url.pathname === '/_agent/finished' && request.method === 'POST') {
        this.sql.exec('UPDATE batches SET due=? WHERE due IS NOT NULL AND due>?', Date.now(), Date.now())
        this.wake?.()
        return new Response(null, { status: 204 })
      }
      if (url.pathname.startsWith('/_agent/reply/') && request.method === 'POST') return await this.reply(request, url.pathname.slice(14))
      if (url.pathname === '/api/muse/connection' && request.method === 'GET') return json({ ok: true,
        laptopOnline: Date.now() - this.lastAgent < 45000, lastSeenAt: this.lastAgent || null, partBytes: PART })
      if (resultRoute.test(url.pathname) && ['GET','HEAD'].includes(request.method)) return this.results.serve(request, url)
      const receive = receiveRoute.exec(url.pathname)
      if (receive && request.method === 'GET') return await this.receive(request, receive[1], Number(receive[2]))
      if (url.href.length > 4096 || !control(request.method, url.pathname)) return problem(404, 'MUSE_ROUTE_NOT_FOUND', '这个中转仅提供 Muse 出图接口')
      return await this.client(request, url)
    } catch (error) {
      if (error instanceof RangeError) return problem(413, 'MUSE_BODY_TOO_LARGE', '数据超过中转单次传输上限')
      if (error instanceof SyntaxError) return problem(400, 'INVALID_JSON', '请求不是完整的 JSON')
      console.error('Muse relay operation failed', error.name)
      return problem(503, 'MUSE_RELAY_UNAVAILABLE', '中转暂时无法完成请求，请稍后重试', { 'Retry-After': '3' })
    }
  }
  async client(request, url) {
    const path = url.pathname
    const target = path + url.search
    const method = request.method
    const batch = batchRoute.exec(path)
    if (method === 'GET' && directRoute.test(path) && path.includes('/jobs/')) {
      const job = this.results.job(path)
      if (job) return json({ ok: true, job })
    }
    if (method === 'GET' && batch) {
      const row = this.sql.exec('SELECT snapshot FROM batches WHERE key=? AND expires>?', batch[1], Date.now()).toArray()[0]
      if (row?.snapshot) {
        const data = this.present(JSON.parse(row.snapshot), true)
        data.laptopOnline = Date.now() - this.lastAgent < 45000
        if (!batch[2]) return json(data)
        const item = data.items.find(item => item.requestKey === batch[2])
        if (item) return json({ ok: true, item, batchKey: batch[1], batchStatusPath: data.statusPath,
          relayUpdatedAt: data.relayUpdatedAt, laptopOnline: data.laptopOnline })
      }
    }
    const cached = method === 'GET' && this.reads.get(target)
    if (cached && cached.until > Date.now()) return json(this.present(JSON.parse(cached.text)))
    if (Date.now() - this.lastAgent > 45000) return unavailable()
    let body
    if (method === 'POST') {
      body = decode(await readBody(request, path.endsWith('/batches') ? 256 * 1024 : 64 * 1024))
      if (typeof body?.requestKey !== 'string' || !new RegExp('^' + ID + '$').test(body.requestKey)) {
        return problem(400, 'INVALID_REQUEST', '请提供稳定的 requestKey，推荐使用 UUID')
      }
    }
    const call = await this.rpc({ method, path: target, body })
    if (!call) return unavailable()
    const { status, data, retry } = call
    if (status >= 400) return Response.json(data, { status, headers: retry ? { ...headers, 'Retry-After': retry } : headers })
    if (path === '/api/muse/guide') {
      data.relay = publicGuide
      data.download = publicGuide.download
      data.followup = '中转出图默认自动接收原图。' + publicGuide.download
      delete data.operations?.uploadedInputs
    }
    if (method === 'GET') {
      if (this.reads.size >= 16) this.reads.delete(this.reads.keys().next().value)
      const text = JSON.stringify(data)
      if (text.length <= 256 * 1024) this.reads.set(target, { until: Date.now() + 2000, text })
    } else this.reads.clear()
    const collect = Boolean(batch) || directRoute.test(path) || method === 'POST'
    const response = this.present(data, collect)
    if (collect) await this.scheduleCleanup()
    return json(response, status)
  }
  rpc(command) {
    if (this.calls.size >= 32) return null
    if (command.method === 'GET') {
      for (const call of this.calls.values()) if (call.command.method === 'GET' && call.command.path === command.path) return call.promise.then(value => structuredClone(value))
    }
    const ticket = crypto.randomUUID()
    let finish
    const promise = new Promise(resolve => { finish = resolve })
    const timer = setTimeout(() => { this.calls.delete(ticket); finish(null) }, 30000)
    this.calls.set(ticket, { command, promise, resolve: value => { clearTimeout(timer); finish(value) } })
    this.wake?.()
    return promise
  }
  notifyReceivers() {
    for (const wake of this.receivers) wake()
  }
  waitForChange(signal, ms) {
    if (this.receivers.size >= 64 || signal.aborted) return Promise.reject(new Error('Receiver unavailable'))
    return new Promise(resolve => {
      const wake = () => { clearTimeout(timer); this.receivers.delete(wake); signal.removeEventListener('abort', wake); resolve() }
      const timer = setTimeout(wake, ms)
      this.receivers.add(wake)
      signal.addEventListener('abort', wake, { once: true })
    })
  }
  async receive(request, key, number) {
    const until = Date.now() + 20000
    const statusPath = '/api/muse/batches/' + key
    for (;;) {
      const now = Date.now()
      const row = this.sql.exec('SELECT snapshot FROM batches WHERE key=? AND expires>?', key, now).toArray()[0]
      if (!row) return problem(404, 'MUSE_BATCH_NOT_FOUND', '请沿提交回执的 statusPath 恢复批次')
      if (row.snapshot) {
        const batch = JSON.parse(row.snapshot)
        const item = batch.items[number - 1]
        if (!item) return problem(404, 'MUSE_ITEM_NOT_FOUND', '此批次没有这张图片')
        if (['failed','cancelled','interrupted'].includes(item.status)) return problem(409, item.code || 'MUSE_JOB_STOPPED', item.error || '出图任务已结束')
        const sourcePath = item.resultUrl
        this.results.describe(item, true)
        if (item.deliveryStatus === 'ready') {
          return this.results.serve(request, new URL(item.resultUrl + new URL(request.url).search, request.url))
        }
        if (item.deliveryStatus === 'transferring' && item.deliveryBytes > 0 && !request.headers.has('range') && !new URL(request.url).search) {
          return this.results.serve(request, new URL(sourcePath, request.url), (signal, ms) => this.waitForChange(signal, ms))
        }
        if (item.status === 'succeeded' && item.deliveryStatus !== 'transferring') {
          return problem(item.deliveryStatus === 'integrityError' ? 502 : item.deliveryStatus === 'storageFull' ? 507 : 410,
            'MUSE_RESULT_UNAVAILABLE', '原图暂不可取：' + (item.deliveryStatus || 'expired'))
        }
      }
      if (request.signal.aborted || now >= until) return json({ ok: true, statusPath, receivePath: new URL(request.url).pathname, pending: true }, 202)
      if (this.receivers.size >= 64) return problem(429, 'MUSE_RECEIVERS_BUSY', '正在收图的连接较多，请稍后重连', { 'Retry-After': '1' })
      await this.waitForChange(request.signal, until - now)
    }
  }
  dispatch(maxParts, parallel) {
    const now = Date.now()
    for (const [key, value] of this.background) if (value.expiry <= now) this.background.delete(key)
    for (const [ticket, call] of this.calls) {
      if (call.sent) continue
      call.sent = true
      if (call.command.method === 'POST') this.watch(call.command.body.requestKey)
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
  async next(maxParts, parallel) {
    this.lastAgent = Date.now()
    let work = this.dispatch(maxParts, parallel)
    if (!work) {
      // Keep just one idle poll. A new command wakes it immediately.
      this.wake?.()
      const due = this.sql.exec("SELECT min(due) AS due FROM (SELECT min(due) AS due FROM batches WHERE due IS NOT NULL AND expires>? UNION ALL SELECT min(due) FROM files WHERE state='transferring' AND expires>?)", Date.now(), Date.now()).one().due
      await new Promise(resolve => {
        const wake = () => { clearTimeout(timer); if (this.wake === wake) this.wake = null; resolve() }
        const timer = setTimeout(wake, due === null ? 24000 : Math.max(25, Math.min(24000, due - Date.now())))
        this.wake = wake
      })
      work = this.dispatch(maxParts, parallel)
    }
    this.lastAgent = Date.now()
    return work ? json(work) : new Response(null, { status: 204 })
  }
  async reply(request, ticket) {
    const call = this.calls.get(ticket)
    const work = this.background.get(ticket)
    if (!call && !work) return new Response(null, { status: 204 })
    const status = Number(request.headers.get('X-Upstream-Status'))
    if (!Number.isInteger(status) || status < 200 || status > 599) return problem(400, 'INVALID_STATUS', '出图机状态码无效')
    const bytes = await readBody(request, work?.file ? PART * work.count : 2 * 1024 * 1024)
    this.lastAgent = Date.now()
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
        if (call) call.resolve(null)
      } else {
        if (status < 300) this.save(data)
        if (work?.batch && status >= 400) {
          if (status === 404) this.sql.exec('DELETE FROM batches WHERE key=? AND snapshot IS NULL', work.batch)
          this.sql.exec('UPDATE batches SET due=? WHERE key=?', Date.now() + 15000, work.batch)
        }
        call?.resolve({ status, data, retry: request.headers.get('Retry-After') })
      }
    }
    this.calls.delete(ticket)
    this.background.delete(ticket)
    if (!work?.file) await this.scheduleCleanup()
    return new Response(null, { status: 204 })
  }
}
