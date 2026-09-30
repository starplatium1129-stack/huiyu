import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { createHash, randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import type { ModelFile } from './model-download-manifest'

interface DownloadOptions {
  signal?: AbortSignal
  timeoutMs?: number
  totalTimeoutMs?: number
  onProgress?: (received: number, total: number) => void
}

export async function matchesModel(file: string, expected: Pick<ModelFile, 'bytes' | 'sha256'>, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted()
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size !== expected.bytes) return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  const hash = createHash('sha256')
  const input = fs.createReadStream(file, { signal })
  for await (const chunk of input) hash.update(chunk)
  return hash.digest('hex') === expected.sha256
}

async function response(url: URL, signal: AbortSignal, timeoutMs: number, redirects = 0): Promise<http.IncomingMessage> {
  const loopback = url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !loopback) || url.username || url.password) throw Error('Model downloads require HTTPS')
  if (redirects > 5) throw Error('Too many model download redirects')
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).get(url, {
      signal, agent: false, headers: { 'user-agent': 'huiyu-model-downloader', 'accept-encoding': 'identity' },
    }, incoming => {
      incoming.on('error', () => {})
      if (incoming.statusCode && incoming.statusCode >= 300 && incoming.statusCode < 400 && incoming.headers.location) {
        const next = new URL(incoming.headers.location, url)
        incoming.resume()
        if (url.protocol === 'https:' && next.protocol !== 'https:') {
          reject(Error('Model redirect downgraded HTTPS')); return
        }
        response(next, signal, timeoutMs, redirects + 1).then(resolve, reject)
      } else if (incoming.statusCode !== 200) {
        incoming.destroy(); reject(Error(`Model source returned HTTP ${incoming.statusCode}`))
      } else if (incoming.headers['content-encoding'] && incoming.headers['content-encoding'] !== 'identity') {
        incoming.destroy(); reject(Error('Compressed model response cannot be checked'))
      } else resolve(incoming)
    })
    request.setTimeout(timeoutMs, () => request.destroy(Error('Model download idle timeout')))
    request.on('error', reject)
  })
}

/** Only verified temporary bytes become the final weight; failed downloads leave existing files intact. */
export async function downloadModel(url: string, target: string, entry: ModelFile, options: DownloadOptions = {}): Promise<'downloaded' | 'verified-existing'> {
  const signal = options.signal ?? new AbortController().signal
  if (await matchesModel(target, entry, signal)) return 'verified-existing'
  const cancelled = new AbortController()
  const stop = () => cancelled.abort(signal.reason)
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()
  const timer = setTimeout(() => cancelled.abort(Error('Model download total timeout')), options.totalTimeoutMs ?? 24 * 60 * 60 * 1000)
  const partial = `${target}.${randomUUID()}.part`
  let incoming: http.IncomingMessage | undefined
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const capacity = fs.statfsSync(path.dirname(target))
    if (capacity.bavail * capacity.bsize < entry.bytes + 65536) throw Error('Insufficient disk space for verified model download')
    incoming = await response(new URL(url), cancelled.signal, options.timeoutMs ?? 60000)
    const length = incoming.headers['content-length']
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) !== entry.bytes)) throw Error('Model Content-Length differs from pinned metadata')
    let received = 0
    const hash = createHash('sha256')
    const meter = new Transform({ transform(chunk: Buffer, _encoding, next) {
      received += chunk.length
      if (received > entry.bytes) { next(Error('Model response exceeds expected bytes')); return }
      hash.update(chunk)
      options.onProgress?.(received, entry.bytes)
      next(null, chunk)
    } })
    await pipeline(incoming, meter, fs.createWriteStream(partial, { flags: 'wx' }), { signal: cancelled.signal })
    if (received !== entry.bytes || hash.digest('hex') !== entry.sha256) throw Error('Model byte count or SHA-256 differs from pinned metadata')
    cancelled.signal.throwIfAborted()
    fs.renameSync(partial, target)
    return 'downloaded'
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', stop)
    incoming?.destroy()
    if (fs.existsSync(partial)) fs.unlinkSync(partial)
  }
}

export async function runModelDownloads(root: string, files: readonly ModelFile[], url: (entry: ModelFile) => string): Promise<void> {
  fs.mkdirSync(root, { recursive: true })
  const lock = path.join(root, '.huiyu-model-download.lock')
  let fd: number
  try { fd = fs.openSync(lock, 'wx') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw Error('A model download lock exists; finish the running downloader first. After a crash, confirm it stopped before removing this lock.')
    throw error
  }
  const cancel = new AbortController()
  const stop = () => cancel.abort(Error('Model download cancelled'))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }))
    for (const entry of files) {
      cancel.signal.throwIfAborted()
      console.log(`[文件] ${entry.path}`)
      let lastPercent = -1
      const result = await downloadModel(url(entry), path.join(root, entry.path), entry, { signal: cancel.signal,
        onProgress(received, total) {
          const percent = Math.floor(received / total * 100)
          if (percent !== lastPercent) { lastPercent = percent; process.stdout.write(`\r  ${percent}% (${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MiB)`) }
        },
      })
      console.log(`\n  [字节与 SHA-256 已核对] ${result}`)
    }
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    fs.closeSync(fd)
    fs.unlinkSync(lock)
    if (cancel.signal.aborted) process.exitCode = 130
  }
}

export function downloadPlan(root: string, files: readonly ModelFile[], url: (entry: ModelFile) => string): object {
  return { checkedAt: '2026-09-30', target: root, totalBytes: files.reduce((sum, entry) => sum + entry.bytes, 0),
    files: files.map(entry => ({ ...entry, url: url(entry) })),
    verification: 'exact bytes and SHA-256; inference and device performance are unverified',
    retry: 'verified files reused; interrupted file restarts from zero; existing files retained until replacement verifies' }
}
