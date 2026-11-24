import { createHash } from 'node:crypto'

export const PART = 128 * 1024
const MAX_FILE = 32 * 1024 * 1024
const MAX_TOTAL = 512 * 1024 * 1024
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
export const TTL = 48 * 60 * 60 * 1000
export const resultRoute = /^\/api\/(?:anima|moss|creative|qwen)\/jobs\/[a-f0-9]{32}\/result$/
const hash = bytes => createHash('sha256').update(new Uint8Array(bytes)).digest('hex')

export function problem(status, code, message, extra = {}) {
  return Response.json({ ok: false, code, message }, {
    status, headers: { 'Cache-Control': 'private, no-store', ...extra },
  })
}

export class Results {
  constructor(storage, onQueued) {
    this.storage = storage
    this.onQueued = onQueued
    this.sql = storage.sql
    this.sql.exec(`CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY, size INTEGER NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL,
      part INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
      due INTEGER NOT NULL, started INTEGER NOT NULL, ready INTEGER, expires INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS file_queue ON files(state, due);
    CREATE TABLE IF NOT EXISTS parts (
      path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE, n INTEGER NOT NULL,
      digest TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY(path,n)
    );
    CREATE TABLE IF NOT EXISTS receipts (
      path TEXT PRIMARY KEY REFERENCES files(path) ON DELETE CASCADE, snapshot TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS discarded_results (
      path TEXT PRIMARY KEY, state TEXT NOT NULL, expires INTEGER NOT NULL
    );`)
  }
  stats(now = Date.now()) {
    const { usedBytes, readyFiles, transferringFiles, oldestExpiresAt } = this.sql.exec(`
      SELECT coalesce(sum(CASE WHEN state IN ('ready','transferring') THEN size ELSE 0 END),0) AS usedBytes,
        count(CASE WHEN state='ready' THEN 1 END) AS readyFiles,
        count(CASE WHEN state='transferring' THEN 1 END) AS transferringFiles,
        min(expires) AS oldestExpiresAt
      FROM files WHERE expires>?`, now).one()
    return { usedBytes, maxBytes: MAX_TOTAL, readyFiles, transferringFiles, oldestExpiresAt }
  }
  find(path) {
    return this.sql.exec('SELECT * FROM files WHERE path=?', path).toArray()[0]
  }
  discarded(path, now) {
    return this.sql.exec('SELECT state,expires FROM discarded_results WHERE path=? AND expires>?', path, now).toArray()[0]
  }
  discard(file, state, now) {
    // A cached batch can still refer to this result. Preserve only its status
    // until the original deadline so polling cannot immediately queue it again.
    if (file.expires > now) {
      this.sql.exec('INSERT OR REPLACE INTO discarded_results(path,state,expires) VALUES(?,?,?)', file.path, state, file.expires)
    }
    this.sql.exec('DELETE FROM parts WHERE path=?', file.path)
    this.sql.exec('DELETE FROM receipts WHERE path=?', file.path)
    this.sql.exec('DELETE FROM files WHERE path=?', file.path)
  }
  reap(now) {
    const stale = this.sql.exec("SELECT path,state,expires FROM files WHERE expires<=? OR state IN ('expired','integrityError')", now).toArray()
    for (const file of stale) this.discard(file, file.state === 'integrityError' ? 'integrityError' : 'expired', now)
    // Also clean any orphans left by older installations.
    this.sql.exec('DELETE FROM parts WHERE NOT EXISTS (SELECT 1 FROM files WHERE files.path=parts.path)')
    this.sql.exec('DELETE FROM receipts WHERE NOT EXISTS (SELECT 1 FROM files WHERE files.path=receipts.path)')
    this.sql.exec('DELETE FROM discarded_results WHERE expires<=?', now)
  }
  cleanup(now) {
    this.storage.transactionSync(() => this.reap(now))
  }
  reserve(path, size, digest, now, expires) {
    return this.storage.transactionSync(() => {
      const usedBytes = () => this.sql.exec('SELECT coalesce(sum(size),0) AS bytes FROM files').one().bytes
      let used = usedBytes()
      if (size + used > MAX_TOTAL) {
        this.reap(now)
        used = usedBytes()
        if (size + used > MAX_TOTAL) {
          const ready = this.sql.exec("SELECT path,size,expires FROM files WHERE state='ready' ORDER BY coalesce(ready,started) ASC,path ASC").toArray()
          for (const old of ready) {
            this.discard(old, 'expired', now)
            used -= old.size
            if (size + used <= MAX_TOTAL) break
          }
        }
      }
      if (size + used > MAX_TOTAL) return
      this.sql.exec("INSERT INTO files(path,size,digest,state,due,started,expires) VALUES(?,?,?,'transferring',?,?,?)",
        path, size, digest, now, now, expires)
      return this.find(path)
    })
  }
  job(path) {
    const receipt = this.sql.exec('SELECT snapshot FROM receipts WHERE path=?', path + '/result').toArray()[0]
    if (!receipt) return
    const job = JSON.parse(receipt.snapshot)
    this.describe(job, false)
    return job
  }
  // A shared history listing should never start moving unrelated pictures.
  describe(job, collect) {
    const path = job?.resultUrl
    if (!resultRoute.test(path)) {
      if (job?.entryType !== 'batch' && (job?.batchKey || path !== undefined)) {
        job.resultAvailable = false
        job.resultUrl = null
        if (job.metadata) job.metadata.resultUrl = null
        if (job.status === 'succeeded') job.deliveryStatus ??= path ? 'invalidReceipt' : 'expired'
      }
      return
    }
    const now = Date.now()
    let file = this.find(path)
    const discarded = file ? undefined : this.discarded(path, now)
    let state = 'onDemand'
    if (discarded) {
      state = discarded.state
      job.resultExpiresAt = discarded.expires
    } else if (collect && !file) {
      const size = job.resultBytes
      const digest = job.resultSha256
      const finished = Number(job.finishedAt)
      const expires = Math.min(Number(job.resultExpiresAt) || (finished > 0 ? finished : now) + TTL, now + TTL)
      if (expires <= now) state = 'expired'
      else if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_FILE || !/^[a-f0-9]{64}$/.test(digest)) state = 'invalidReceipt'
      else {
        file = this.reserve(path, size, digest, now, expires)
        if (file) this.onQueued()
        else state = 'storageFull'
      }
    }
    if (file) {
      // Only a complete job has metadata and the job ID. Batch items have their
      // own schema and cannot replace a direct job receipt.
      if (collect && job.metadata && path.endsWith('/' + job.id + '/result')) {
        this.sql.exec('INSERT INTO receipts(path,snapshot) SELECT ?,? WHERE NOT EXISTS (SELECT 1 FROM receipts WHERE path=?)',
          path, JSON.stringify(job), path)
      }
      state = file.expires <= now ? 'expired' : file.state
      job.deliveryBytes = Math.min(file.size, file.part * PART)
      job.deliveryMs = file.ready === null ? null : file.ready - file.started
      job.resultExpiresAt = file.expires
    }
    job.deliveryStatus = state
    job.resultAvailable = state === 'ready'
    if (!job.resultAvailable) job.resultUrl = null
    if (job.metadata) job.metadata.resultUrl = job.resultUrl
  }
  next(maxParts) {
    const now = Date.now()
    const file = this.sql.exec("SELECT * FROM files WHERE state='transferring' AND due<=? AND expires>? ORDER BY due LIMIT 1", now, now).toArray()[0]
    if (!file) return
    // A dropped large upload formerly had to wait for a round trip per 128 KiB.
    // Negotiate the window with this agent; a failed lease retries one small part.
    const count = file.attempts ? 1 : Math.min(maxParts, Math.ceil(file.size / PART) - file.part)
    this.sql.exec('UPDATE files SET due=?, attempts=attempts+1 WHERE path=?', now + 40000, file.path)
    return { method: 'GET', path: file.path + '?part=' + file.part + (count > 1 ? '&count=' + count : ''), file, count }
  }
  accept({ file, count }, status, headers, bytes) {
    const current = this.find(file.path)
    if (!current || current.part !== file.part || current.state !== 'transferring') return
    const now = Date.now()
    const offset = file.part * PART
    const partHash = hash(bytes)
    if (status !== 200 || bytes.byteLength !== Math.min(PART * count, file.size - offset)
      || headers.get('x-result-offset') !== String(offset) || headers.get('x-result-bytes') !== String(file.size)
      || headers.get('x-result-sha256') !== file.digest || headers.get('x-part-sha256') !== partHash) {
      const state = [404,410].includes(status) ? 'expired' : 'transferring'
      this.sql.exec('UPDATE files SET state=?, due=? WHERE path=?',
        state, now + Math.min(60000, 1000 * 2 ** Math.min(6, file.attempts)), file.path)
      return
    }
    this.savePieces(current, file.part, bytes)
    this.sql.exec('UPDATE files SET attempts=0, due=? WHERE path=?', now, file.path)
  }
  // Parallel uploads may finish in any order. Persist verified pieces even if
  // the agent disconnects before acknowledging its window.
  savePieces(file, first, bytes) {
    const now = Date.now()
    return this.storage.transactionSync(() => {
      for (let start = 0; start < bytes.byteLength; start += PART) {
        const piece = bytes.slice(start, start + PART)
        const n = first + start / PART
        const digest = hash(piece)
        const saved = this.sql.exec('SELECT digest FROM parts WHERE path=? AND n=?', file.path, n).toArray()[0]
        if (saved && saved.digest !== digest) throw new Error('Conflicting result piece')
        if (!saved) this.sql.exec('INSERT INTO parts(path,n,digest,data) VALUES(?,?,?,?)', file.path, n, digest, piece)
      }
      if (file.state === 'ready') return
      let next = file.part
      for (const row of this.sql.exec('SELECT n FROM parts WHERE path=? AND n>=? ORDER BY n', file.path, next)) {
        if (row.n !== next) break
        next++
      }
      this.sql.exec('UPDATE files SET part=? WHERE path=?', next, file.path)
      if (next * PART < file.size) return
      const full = createHash('sha256')
      let isPng = false
      for (const row of this.sql.exec('SELECT n,data FROM parts WHERE path=? ORDER BY n', file.path)) {
        const piece = new Uint8Array(row.data)
        if (row.n === 0) isPng = PNG_SIGNATURE.every((byte, index) => piece[index] === byte)
        full.update(piece)
      }
      const state = isPng && full.digest('hex') === file.digest ? 'ready' : 'integrityError'
      this.sql.exec('UPDATE files SET state=?, ready=? WHERE path=?', state, state === 'ready' ? now : null, file.path)
      if (state !== 'ready') this.sql.exec('DELETE FROM parts WHERE path=?', file.path)
    })
  }
  upload(path, first, bytes, headers) {
    const file = this.find(path)
    if (!file || file.expires <= Date.now()) return problem(410, 'MUSE_RESULT_EXPIRED', '原图回执已过期')
    const length = bytes.byteLength
    const end = first * PART + length
    if (!['ready','transferring'].includes(file.state) || !length || length > 4 * PART || end > file.size
      || (end < file.size && length % PART !== 0) || headers.get('x-result-sha256') !== file.digest
      || headers.get('x-part-sha256') !== hash(bytes)) return problem(409, 'MUSE_PART_INVALID', '原图分片与回执不符')
    this.savePieces(file, first, bytes)
    return new Response(null, { status: 204 })
  }
  serve(request, url) {
    const file = this.find(url.pathname)
    const now = Date.now()
    const state = file ? (file.expires <= now ? 'expired' : file.state) : this.discarded(url.pathname, now)?.state
    if (state === 'expired') return problem(410, 'MUSE_RESULT_EXPIRED', '中转原图已过期或已淘汰')
    if (state === 'integrityError') return problem(502, 'MUSE_RESULT_INTEGRITY', '整图校验失败，请检查出图机归档')
    if (!file) return problem(404, 'MUSE_RESULT_UNKNOWN', '请先查原任务的 statusPath')
    if (file.state !== 'ready') return problem(409, 'MUSE_RESULT_TRANSFERRING', '已出图，正在传送原图', { 'Retry-After': '2' })
    const etag = '"' + file.digest + '"'
    const headers = { 'Accept-Ranges': 'bytes', 'Content-Type': 'image/png', ETag: etag,
      'X-Result-Bytes': String(file.size), 'X-Result-Sha256': file.digest,
      'Cache-Control': 'private, no-store, no-transform', 'X-Content-Type-Options': 'nosniff' }
    const invalid = () => problem(416, 'INVALID_RANGE', '请求的字节或分片超出范围', { 'Content-Range': 'bytes */' + file.size, ETag: etag })
    const range = request.headers.get('Range')
    if (url.searchParams.has('part')) {
      if (range) return problem(400, 'INVALID_RANGE', '按编号取片时请省略 Range')
      const n = url.searchParams.get('part')
      if (!/^\d{1,9}$/.test(n) || Number(n) * PART >= file.size) return invalid()
      const part = this.sql.exec('SELECT data,digest FROM parts WHERE path=? AND n=?', file.path, Number(n)).toArray()[0]
      if (!part) return problem(502, 'MUSE_RESULT_INTEGRITY', '中转原图缺少分片，请检查出图机归档')
      Object.assign(headers, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(part.data.byteLength),
        'X-Part-Sha256': part.digest, 'X-Result-Sha256': file.digest, 'X-Result-Bytes': String(file.size), 'X-Result-Offset': String(Number(n) * PART) })
      return new Response(request.method === 'HEAD' ? null : part.data, { headers })
    }
    let first = 0, last = file.size - 1, status = 200
    if (range && (!request.headers.has('If-Range') || request.headers.get('If-Range') === etag)) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range)
      if (!match || (!match[1] && !match[2])) return invalid()
      if (match[1]) {
        first = Number(match[1])
        if (match[2]) last = Math.min(last, Number(match[2]))
      } else first = Math.max(0, file.size - Number(match[2]))
      if (first > last || first >= file.size) return invalid()
      headers['Content-Range'] = 'bytes ' + first + '-' + last + '/' + file.size
      status = 206
    }
    const length = last - first + 1
    headers['Content-Length'] = String(length)
    if (request.method === 'HEAD') return new Response(null, { status, headers })
    // FixedLengthStream lets Workers emit a real Content-Length without buffering
    // an entire image for each simultaneous download.
    const output = new FixedLengthStream(length)
    const sql = this.sql
    let offset = first
    const source = new ReadableStream({
      pull(controller) {
        const n = Math.floor(offset / PART)
        const part = sql.exec("SELECT data FROM parts JOIN files USING(path) WHERE path=? AND n=? AND state='ready' AND started=?", file.path, n, file.started).toArray()[0]
        const chunk = part && new Uint8Array(part.data).subarray(offset % PART, Math.min(part.data.byteLength, last - n * PART + 1))
        if (!chunk?.byteLength) {
          controller.error(new Error('中转原图已淘汰或分片不可用'))
          return
        }
        offset += chunk.byteLength
        controller.enqueue(chunk)
        if (offset > last) controller.close()
      },
    })
    source.pipeTo(output.writable).catch(() => {}) // A disconnected caller can resume independently.
    return new Response(output.readable, { status, headers })
  }
}
