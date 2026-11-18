import { createHash, timingSafeEqual } from 'node:crypto'
import { DurableObject } from 'cloudflare:workers'
import { PART, Results, TTL, problem, resultRoute } from './results.mjs'

const ID = '[A-Za-z0-9_-]{1,160}'
const batchRoute = new RegExp('^/api/muse/batches/(' + ID + ')(?:/(' + ID + '))?$')
const directRoute = new RegExp('^/api/(?:anima|moss|qwen|creative)/(?:jobs|requests)/' + ID + '$')
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
const json = (value, status = 200) => Response.json(value, { status, headers })
const unavailable = () => problem(503, 'MUSE_LAPTOP_UNAVAILABLE', '出图机暂未回应。请重查原路径，提交重试请复用原 requestKey', { 'Retry-After': '3' })
const publicGuide = { name: '绘遇 Muse 私人中转', protocol: 'huiyu-muse', authHeader: 'X-Token',
  guidePath: '/api/muse/guide', drawPath: '/api/muse/jobs', partBytes: PART,
  download: '按 statusPath 查询。deliveryStatus 为 ready 后取 resultUrl，支持 Range 或 ?part=N。完成后核对 resultBytes 和 resultSha256。',
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
  }
  present(data, collect = false) {
    for (const job of [data.job, data.item, ...(Array.isArray(data.items) ? data.items : [])]) {
      if (job) this.results.describe(job, collect)
    }
    return data
  }
  async fetch(request) {
    const url = new URL(request.url)
    try {
      if (url.pathname === '/_agent/next' && request.method === 'POST') return await this.next()
      if (url.pathname.startsWith('/_agent/reply/') && request.method === 'POST') return await this.reply(request, url.pathname.slice(14))
      if (url.pathname === '/api/muse/connection' && request.method === 'GET') return json({ ok: true,
        laptopOnline: Date.now() - this.lastAgent < 45000, lastSeenAt: this.lastAgent || null, partBytes: PART })
      if (resultRoute.test(url.pathname) && ['GET','HEAD'].includes(request.method)) return this.results.serve(request, url)
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
  dispatch() {
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
    } else work = this.results.next()
    if (!work) return
    const ticket = crypto.randomUUID()
    this.background.set(ticket, { ...work, expiry: now + 40000 })
    return { ticket, method: work.method, path: work.path }
  }
  async next() {
    this.lastAgent = Date.now()
    let work = this.dispatch()
    if (!work) {
      // Keep just one idle poll. A new command wakes it immediately.
      this.wake?.()
      const due = this.sql.exec("SELECT min(due) AS due FROM (SELECT min(due) AS due FROM batches WHERE due IS NOT NULL AND expires>? UNION ALL SELECT min(due) FROM files WHERE state='transferring' AND expires>?)", Date.now(), Date.now()).one().due
      await new Promise(resolve => {
        const wake = () => { clearTimeout(timer); if (this.wake === wake) this.wake = null; resolve() }
        const timer = setTimeout(wake, due === null ? 24000 : Math.max(25, Math.min(24000, due - Date.now())))
        this.wake = wake
      })
      work = this.dispatch()
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
    const bytes = await readBody(request, work?.file ? PART : 2 * 1024 * 1024)
    this.lastAgent = Date.now()
    if (work?.file) this.results.accept(work, status, request.headers, bytes)
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
